import { afterEach, describe, expect, it, vi } from "vitest";
import { createDisplayFrameReader, logDisplayDiagnostics } from "./display-smoke-diagnostics.mjs";

afterEach(() => vi.useRealTimers());

describe("display smoke failure diagnostics", () => {
  it("takes no diagnostic probes when the frame succeeds", async () => {
    const shot = { data: "jpeg", width: 640, height: 400 };
    const preview = vi.fn(async () => shot);
    const waitFor = vi.fn(async (predicate) => expect(await predicate()).toBeTruthy());
    await expect(createDisplayFrameReader(preview, waitFor)()).resolves.toBe(shot);
    expect(preview.mock.calls).toEqual([["mini-frame"]]);
    expect(waitFor).toHaveBeenCalledWith(expect.any(Function), "a frame of the page", 30_000);
  });

  it("logs state during retries and probes capturePage only after the original timeout", async () => {
    const timeout = new Error("timed out waiting for a frame of the page");
    const order = [];
    const preview = vi.fn(async (command, input) => {
      order.push(command === "mini-frame" ? command : `diagnostics:${input.capturePage}`);
      if (command === "mini-frame") throw new Error("The hidden page did not paint.");
      return { capturePage: { status: "ok", value: { width: 1280, height: 800 } } };
    });
    const waitFor = async (predicate) => {
      expect(await predicate()).toBeFalsy();
      expect(await predicate()).toBeFalsy();
      order.push("timeout");
      throw timeout;
    };
    const log = vi.fn();
    await expect(createDisplayFrameReader(preview, waitFor, { log })()).rejects.toBe(timeout);
    expect(order).toEqual(["mini-frame", "diagnostics:false", "mini-frame", "timeout", "diagnostics:true"]);
    expect(log.mock.calls.flat().filter((line) => line.startsWith("[display-smoke-diagnostics]"))).toHaveLength(2);
  });

  it("does not let a hung diagnostic request delay frame retries", async () => {
    const shot = { data: "jpeg" };
    let frames = 0;
    const preview = vi.fn(async (command) => {
      if (command !== "mini-frame") return new Promise(() => undefined);
      if (++frames === 1) throw new Error("The hidden page did not paint.");
      return shot;
    });
    vi.useFakeTimers();
    const log = vi.fn();
    const waitFor = async (predicate) => { expect(await predicate()).toBeFalsy(); expect(await predicate()).toBeTruthy(); };
    await expect(createDisplayFrameReader(preview, waitFor, { log })()).resolves.toBe(shot);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(log.mock.calls.flat().join("\n")).toContain("diagnostic-request-timeout");
  });

  it("logs diagnostic request errors without their possibly sensitive message", async () => {
    const log = vi.fn();
    await logDisplayDiagnostics(async () => { throw new Error("secret page content"); }, true, { log });
    expect(log).toHaveBeenCalledWith("[display-smoke-diagnostics] diagnostic request failed");
  });
});
