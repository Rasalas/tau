import { describe, expect, it } from "vitest";
import type { ScreenFrame, ScreenWindow } from "./protocol.js";
import { ScreenRemote, driverCalls, readScreenInput, type ScreenRemotePorts } from "./remote-control.js";

const TARGET = { pid: 4242, windowId: 7 };

function frame(seq: number): ScreenFrame {
  return { seq, at: 0, width: 800, height: 600, mimeType: "image/png", window: TARGET, data: `PNG${String(seq)}` };
}

function remote(options: { target?: ScreenWindow; frame?: ScreenFrame | null; access?: string; live?: unknown; fail?: string } = {}) {
  const ran: Array<{ tool: string; params: Record<string, unknown> }> = [];
  const windowCalls: Array<{ command: string; input?: unknown }> = [];
  const looked: string[] = [];
  let current = options.frame === undefined ? frame(1) : options.frame;
  const ports: ScreenRemotePorts = {
    target: () => options.target ?? TARGET,
    frame: () => current,
    run: async (_threadId, tool, params) => {
      ran.push({ tool, params });
      if (options.fail && tool.endsWith(options.fail)) return { isError: true, content: [{ type: "text", text: "Window is gone." }] };
      return tool.endsWith("get_window_state") ? { content: [{ type: "image", data: "PNG2" }], details: { screenshot_width: 800, screenshot_height: 600 } } : {};
    },
    looked: (threadId) => {
      looked.push(threadId);
      current = frame((current?.seq ?? 0) + 1);
    },
    callWindow: async (command, input) => {
      windowCalls.push({ command, ...(input === undefined ? {} : { input }) });
      if (command === "access") return options.access ?? "unavailable";
      if (command === "live-frame") return options.live ?? null;
      if (command === "shrink") return { data: "JPEG", width: (input as { maxWidth: number }).maxWidth, height: 150 };
      return undefined;
    },
    now: () => 0,
  };
  return { screen: new ScreenRemote(ports), ran, windowCalls, looked };
}

describe("input to the driven window from a device", () => {
  it("reads taps, scrolls, text and the keys a login needs, and nothing else", () => {
    expect(readScreenInput({ kind: "click", x: 0.5, y: 0.5 })).toEqual({ kind: "click", x: 0.5, y: 0.5 });
    expect(() => readScreenInput({ kind: "key", key: "Delete" })).toThrow(/may send/u);
    expect(() => readScreenInput({ kind: "click", x: -1, y: 0 })).toThrow(/between 0 and 1/u);
  });

  it("addresses the thread's window by pid and window id, in screenshot pixels", () => {
    expect(driverCalls({ kind: "click", x: 0.5, y: 0.25 }, TARGET, { width: 800, height: 600 }))
      .toEqual([{ tool: "computer_use_click", params: { pid: 4242, window_id: 7, x: 400, y: 150 } }]);
    expect(driverCalls({ kind: "key", key: "Backspace" }, TARGET, { width: 1, height: 1 })[0]?.params).toEqual({ pid: 4242, window_id: 7, key: "delete" });
    expect(driverCalls({ kind: "scroll", x: 0.5, y: 0.5, dx: 0, dy: -0.5 }, TARGET, { width: 800, height: 600 })[0]?.params)
      .toMatchObject({ direction: "up", amount: 5, x: 400, y: 300 });
    expect(driverCalls({ kind: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 0 }, TARGET, { width: 800, height: 600 })).toEqual([]);
  });

  it("runs the input through the thread's driver, then looks again so every device sees it", async () => {
    const { screen, ran, looked } = remote();
    await screen.input("t1", { kind: "text", text: "throwaway-e27" });
    expect(ran.map((call) => call.tool)).toEqual(["computer_use_type_text", "computer_use_get_window_state"]);
    expect(ran[0]?.params).toEqual({ pid: 4242, window_id: 7, text: "throwaway-e27" });
    expect(looked).toEqual(["t1"]);
  });

  it("says so when the window refused, and when there is no window or picture yet", async () => {
    await expect(remote({ fail: "click" }).screen.input("t1", { kind: "click", x: 0.1, y: 0.1 })).rejects.toThrow(/Window is gone/u);
    await expect(remote({ target: { pid: 1 } }).screen.input("t1", { kind: "key", key: "Enter" })).rejects.toThrow(/drives no window/u);
    await expect(remote({ frame: null }).screen.input("t1", { kind: "key", key: "Enter" })).rejects.toThrow(/no picture/u);
  });

  it("keeps a failed input from blocking the next", async () => {
    const { screen, ran } = remote({ fail: "click" });
    await expect(screen.input("t1", { kind: "click", x: 0.1, y: 0.1 })).rejects.toThrow();
    await screen.input("t1", { kind: "key", key: "Tab" });
    expect(ran.map((call) => call.tool)).toContain("computer_use_press_key");
  });
});

describe("frames of the driven window for a device", () => {
  it("sends the driver's picture at the asked width, and only an id while it is the same", async () => {
    const { screen, windowCalls } = remote();
    const first = await screen.frame("t1", { maxWidth: 390 });
    expect(first).toEqual({ id: "d1", data: "JPEG", width: 390, height: 150, mimeType: "image/jpeg" });
    await expect(screen.frame("t1", { maxWidth: 390, since: "d1" })).resolves.toEqual({ id: "d1", unchanged: true });
    expect(windowCalls.filter((call) => call.command === "shrink")).toHaveLength(1);
  });

  it("uses the live picture of that window where the Mac allows it", async () => {
    const { screen, windowCalls } = remote({ access: "granted", live: { seq: 3, url: "data:image/jpeg;base64,TElWRQ==", width: 320, height: 200 } });
    await expect(screen.frame("t1", { maxWidth: 640 })).resolves.toEqual({ id: "l7:3", data: "TElWRQ==", width: 320, height: 200, mimeType: "image/jpeg" });
    expect(windowCalls.map((call) => call.command)).toEqual(["access", "live-start", "live-frame"]);
    expect(windowCalls[1]?.input).toEqual({ windowId: 7 });
    screen.dispose();
  });

  it("has nothing to show before the agent looked at a window", async () => {
    await expect(remote({ frame: null }).screen.frame("t1", {})).resolves.toBeNull();
  });
});
