import { describe, expect, it } from "vitest";
import type { HostClientCallOptions } from "tau/host-extension";
import { pinnedWindowCalls } from "./pinned-calls.js";

function services(windows: string[]) {
  const sent: Array<{ command: string; options?: HostClientCallOptions }> = [];
  return {
    sent,
    windows,
    clientWindow: () => windows.at(-1),
    callClient: async (command: string, _input?: unknown, options?: HostClientCallOptions) => {
      sent.push({ command, ...(options ? { options } : {}) });
      if (options?.window && options.window !== "host" && !windows.includes(options.window)) throw new Error("The window this was pinned to is gone.");
      return options?.window;
    },
  };
}

describe("window calls pinned to one window", () => {
  it("keeps asking the first window even when a newer one appears", async () => {
    const host = services(["w1"]);
    const calls = pinnedWindowCalls(host);
    await calls.call("open-view");
    host.windows.push("w2");
    await expect(calls.call("capture")).resolves.toBe("w1");
  });

  it("moves to the newest window once the pinned one is gone", async () => {
    const host = services(["w1"]);
    const calls = pinnedWindowCalls(host);
    await calls.call("open-view");
    host.windows.splice(0, 1, "w2");
    await expect(calls.call("capture")).resolves.toBe("w2");
    expect(host.sent.map((entry) => entry.options?.window)).toEqual(["w1", "w1", "w2"]);
  });

  it("lets the kit rebuild its view in the new window before the call that noticed", async () => {
    const host = services(["w1"]);
    const calls: ReturnType<typeof pinnedWindowCalls> = pinnedWindowCalls(host, { onMoved: async () => { await calls.call("open-view"); } });
    await calls.call("open-view");
    host.windows.splice(0, 1, "w2");
    await calls.call("capture");
    expect(host.sent.map((entry) => `${entry.command}@${entry.options?.window}`)).toEqual(["open-view@w1", "capture@w1", "open-view@w2", "capture@w2"]);
  });

  it("asks the host's window unpinned on a host that names none", async () => {
    const host = services([]);
    const calls = pinnedWindowCalls(host);
    await calls.call("open-view");
    expect(host.sent).toEqual([{ command: "open-view", options: { window: "host" } }]);
  });

  it("does not retry a failure of the window itself", async () => {
    const calls = pinnedWindowCalls({
      clientWindow: () => "w1",
      callClient: async () => { throw new Error("This window cannot draw a preview."); },
    });
    await expect(calls.call("open-view")).rejects.toThrow(/cannot draw/u);
  });
});
