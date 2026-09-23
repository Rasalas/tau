import { describe, expect, it } from "vitest";
import { isOfferedMode, threadModeFromEntries, THREAD_MODE_ENTRY } from "../shared/thread-mode.js";
import { runtimeExtensionModes } from "./host-extensions.js";
import { decodeNewThreadConfiguration } from "./ipc-input.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { PiThreadRuntimeBackend } from "./thread-runtime-backend.js";

function piBackend(modes: readonly string[]) {
  const entries: unknown[] = [];
  const sessionManager = {
    getBranch: () => entries,
    appendCustomEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
  };
  const backend = new PiThreadRuntimeBackend({ session: { sessionManager } } as never, PI_AGENT_RUNTIME_ADAPTER, {
    mapMessages: () => [],
    modes: () => modes,
  });
  return { backend, entries };
}

describe("thread modes", () => {
  it("reads the last mode entry of a branch, default without one", () => {
    expect(threadModeFromEntries([])).toBe("default");
    expect(threadModeFromEntries([
      { type: "custom", customType: THREAD_MODE_ENTRY, data: { mode: "plan" } },
      { type: "message" },
    ])).toBe("plan");
    expect(threadModeFromEntries([
      { type: "custom", customType: THREAD_MODE_ENTRY, data: { mode: "plan" } },
      { type: "custom", customType: THREAD_MODE_ENTRY, data: { mode: "default" } },
    ])).toBe("default");
    expect(isOfferedMode("default", undefined)).toBe(true);
    expect(isOfferedMode("plan", ["plan"])).toBe(true);
    expect(isOfferedMode("plan", [])).toBe(false);
  });

  it("offers each mode runtime extensions declare once", () => {
    const factory = () => undefined;
    expect(runtimeExtensionModes([
      { name: "a", factory, modes: ["plan"] },
      { name: "b", factory },
      { name: "c", factory, modes: ["plan", "default"] },
    ])).toEqual(["plan"]);
  });

  it("records a Pi thread's mode in its journal and refuses one nobody offers", async () => {
    const { backend, entries } = piBackend(["plan"]);
    const mode = backend.capabilities.mode!;
    expect(mode.modes()).toEqual(["plan"]);
    expect(mode.current()).toBe("default");
    await mode.set("plan");
    await mode.set("plan");
    expect(entries).toEqual([{ type: "custom", customType: THREAD_MODE_ENTRY, data: { mode: "plan" } }]);
    expect(mode.current()).toBe("plan");
    await expect(mode.set("review")).rejects.toThrow(/no "review" mode/u);
    await mode.set("default");
    expect(mode.current()).toBe("default");
  });

  it("decodes the mode a new thread starts in", () => {
    expect(decodeNewThreadConfiguration("new-session", "configuration", { mode: "plan" })).toEqual({ mode: "plan" });
    expect(decodeNewThreadConfiguration("new-session", "configuration", { model: { provider: "p", id: "m" }, mode: "plan" }))
      .toEqual({ model: { provider: "p", id: "m" }, mode: "plan" });
    expect(() => decodeNewThreadConfiguration("new-session", "configuration", { mode: 3 })).toThrow();
  });
});
