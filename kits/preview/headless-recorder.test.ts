import { describe, expect, it, vi } from "vitest";
import { HeadlessPreviewRecorder } from "./headless-recorder.js";

const part = (data = "", eof = true) => ({ data: Buffer.from(data).toString("base64"), base64Encoded: true, eof });
function harness(reads: Array<ReturnType<typeof part> | Error> = [part("video")]) {
  const send = vi.fn(async (method: string) => {
    if (method === "Page.startScreenRecording" || method === "Page.stopScreenRecording") return { stream: "owned-stream" };
    if (method === "IO.read") {
      const next = reads.shift() ?? part();
      if (next instanceof Error) throw next;
      return next;
    }
    return {};
  });
  return { send, recorder: new HeadlessPreviewRecorder(send as never, async () => undefined) };
}

describe("the owned headless video recorder", () => {
  it("requests bounded silent capture, keeps live EOF open and flushes before its final read", async () => {
    const { recorder, send } = harness([new Error("Read failed"), part("header"), part(), part("fragment"), part("trailer", false), part()]);
    expect(await recorder.record("start", { frameRate: 300 })).toEqual({ chunks: [], mimeType: "video/mp4" });
    expect(send).toHaveBeenCalledWith("Page.startScreenRecording", { audio: false, maxWidth: 1920, maxHeight: 1920, frameRate: 60 });
    expect((await recorder.record("take")).chunks).toEqual([]);
    expect((await recorder.record("take")).chunks).toEqual([Buffer.from("header").toString("base64")]);
    expect((await recorder.record("take")).chunks).toEqual([]);
    expect((await recorder.record("take")).chunks).toEqual([Buffer.from("fragment").toString("base64")]);
    expect(send.mock.calls.map(([method]) => method)).not.toContain("IO.close");
    expect((await recorder.record("stop")).chunks).toEqual([Buffer.from("trailer").toString("base64")]);
    expect(send.mock.calls.slice(-4).map(([method]) => method)).toEqual(["Page.stopScreenRecording", "IO.read", "IO.read", "IO.close"]);
    expect(await recorder.record("stop")).toEqual({ chunks: [], mimeType: "video/mp4" });
  });

  it("reports missing browser capability without downloading or trying another recording surface", async () => {
    const send = vi.fn(async () => { throw new Error("'Page.startScreenRecording' wasn't found"); });
    const recorder = new HeadlessPreviewRecorder(send, async () => undefined);
    await expect(recorder.record("start")).rejects.toThrow("153 or newer");
    expect(send).toHaveBeenCalledTimes(1);
    await recorder.dispose();
  });

  it.each([false, true])("cleans an ambiguous start timeout and closes the browser if cleanup fails=%j", async (cleanupFails) => {
    const closeBrowser = vi.fn(async () => undefined);
    const send = vi.fn(async (method: string) => {
      if (method === "Page.startScreenRecording") throw new Error("The preview browser timed out: Page.startScreenRecording.");
      if (method === "Page.stopScreenRecording") {
        if (cleanupFails) throw new Error("The preview browser timed out: Page.stopScreenRecording.");
        return { stream: "late-stream" };
      }
      return {};
    });
    const recorder = new HeadlessPreviewRecorder(send as never, closeBrowser);
    await expect(recorder.record("start")).rejects.toThrow("timed out");
    expect(send.mock.calls.map(([method]) => method)).toContain("Page.stopScreenRecording");
    if (cleanupFails) expect(closeBrowser).toHaveBeenCalledTimes(1);
    else expect(send.mock.calls.at(-1)).toEqual(["IO.close", { handle: "late-stream" }]);
  });

  it.each([{}, null, undefined])("cleans up a successful start whose stream response is malformed %j", async (response) => {
    const send = vi.fn(async (method: string) => method === "Page.stopScreenRecording" ? { stream: "cleanup-stream" } : response);
    const recorder = new HeadlessPreviewRecorder(send as never, async () => undefined);
    await expect(recorder.record("start")).rejects.toThrow("did not return a recording stream");
    expect(send.mock.calls.at(-1)).toEqual(["IO.close", { handle: "cleanup-stream" }]);
  });

  it("propagates an established-stream failure and closes on finalization failure", async () => {
    const { recorder, send } = harness([part("header"), new Error("Read failed"), new Error("encoder unavailable")]);
    await recorder.record("start");
    await recorder.record("take");
    await expect(recorder.record("take")).rejects.toThrow("Read failed");
    await expect(recorder.record("stop")).rejects.toThrow("Read failed");
    expect(send.mock.calls.at(-1)).toEqual(["IO.close", { handle: "owned-stream" }]);
  });

  it("refuses an artifact after consuming a header before a later read fails", async () => {
    const { recorder, send } = harness([part("header", false), new Error("Read failed"), part("trailer")]);
    await recorder.record("start");
    await expect(recorder.record("take")).rejects.toThrow("Read failed");
    await expect(recorder.record("stop")).rejects.toThrow("Read failed");
    expect(send.mock.calls.at(-1)?.[0]).toBe("IO.close");
    expect(send.mock.calls.filter(([method]) => method === "IO.read")).toHaveLength(2);
  });

  it("does not report an empty final stream as success", async () => {
    const { recorder, send } = harness([part()]);
    await recorder.record("start");
    await expect(recorder.record("stop")).rejects.toThrow("no video data");
    expect(send.mock.calls.at(-1)?.[0]).toBe("IO.close");
  });

  it.each([
    { data: "a", base64Encoded: true, eof: false },
    { data: "!invalid!", base64Encoded: true, eof: true },
    { data: "text", base64Encoded: false, eof: true },
    { data: "a".repeat(100_000), base64Encoded: true, eof: true },
  ])("refuses malformed or oversized binary data %j", async (bad) => {
    const { recorder, send } = harness([bad]);
    await recorder.record("start");
    await expect(recorder.record("stop")).rejects.toThrow("invalid recording data");
    expect(send.mock.calls.at(-1)?.[0]).toBe("IO.close");
  });

  it("bounds each live drain and refuses an oversized final backlog", async () => {
    const chunk = part("v".repeat(64 * 1024), false);
    const { recorder, send } = harness(Array.from({ length: 512 }, () => chunk));
    await recorder.record("start");
    expect((await recorder.record("take")).chunks).toHaveLength(256);
    await expect(recorder.record("stop")).rejects.toThrow("too much undrained data");
    expect(send.mock.calls.filter(([method]) => method === "IO.read")).toHaveLength(512);
    expect(send.mock.calls.at(-1)?.[0]).toBe("IO.close");
  });

  it("serializes capture calls and closes its own stream once on disposal", async () => {
    const { recorder, send } = harness();
    await Promise.all([recorder.record("start"), recorder.record("start"), recorder.record("take")]);
    await Promise.all([recorder.dispose(), recorder.dispose()]);
    expect(send.mock.calls.filter(([method]) => method === "Page.startScreenRecording")).toHaveLength(1);
    expect(send.mock.calls.filter(([method]) => method === "Page.stopScreenRecording")).toHaveLength(1);
    expect(send.mock.calls.filter(([method]) => method === "IO.close")).toHaveLength(1);
    await expect(recorder.record("start")).rejects.toThrow("closed");
  });
});
