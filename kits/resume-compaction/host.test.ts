import { describe, expect, it, vi } from "vitest";
import type { HostConfigChange, RuntimeExtensionFactory } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import compactAtExtension from "./host.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

async function harness(values: Record<string, string>, projects: Record<string, Record<string, string>> = {}) {
  let factory: RuntimeExtensionFactory | undefined;
  let changed: ((change: HostConfigChange) => void) | undefined;
  const settings = { options: {}, values: { ...values } };
  await activateHostKit(compactAtExtension, {
    settings: (async (_id: string, cwd?: string) => (cwd && projects[cwd] ? { options: {}, values: { ...settings.values, ...projects[cwd] } } : settings)) as never,
    observeConfigChanges: (listener) => { changed = listener; return () => undefined; },
    registerRuntimeExtension: (_name, next) => { factory = next; return () => undefined; },
  });
  const handlers: Record<string, Handler> = {};
  factory!({ on: (event: string, handler: Handler) => { handlers[event] = handler; } } as never, { sessionId: "s1", cwd: "/project" });
  // The kit reads the project's settings when its runtime opens.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const settle = (percent: number | null) => {
    const compact = vi.fn();
    handlers.agent_settled!({ type: "agent_settled" }, { getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent }), compact });
    return compact;
  };
  const set = async (value: string) => {
    settings.values = { "compact-at": value };
    changed!({ kind: "config" } as HostConfigChange);
    // The kit reads its settings again before it applies them.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { settle, set, beforeCompact: (reason: string) => handlers.session_before_compact!({ type: "session_before_compact", reason }, {}) };
}

describe("Compact context (General → Threads)", () => {
  it("compacts a settled Pi thread past 80% by default, not below", async () => {
    const { settle } = await harness({});
    expect(settle(79)).not.toHaveBeenCalled();
    expect(settle(80)).toHaveBeenCalledOnce();
    expect(settle(null)).not.toHaveBeenCalled();
  });

  it("follows a change to 60%, and Never cancels only Pi's own threshold compaction", async () => {
    const { settle, set, beforeCompact } = await harness({ "compact-at": "60" });
    expect(settle(61)).toHaveBeenCalledOnce();
    expect(beforeCompact("threshold")).toBeUndefined();
    await set("never");
    expect(settle(99)).not.toHaveBeenCalled();
    expect(beforeCompact("threshold")).toEqual({ cancel: true });
    expect(beforeCompact("overflow")).toBeUndefined();
    expect(beforeCompact("manual")).toBeUndefined();
  });

  it("takes the threshold from the project the thread runs in", async () => {
    const { settle } = await harness({ "compact-at": "80" }, { "/project": { "compact-at": "60" } });
    expect(settle(65)).toHaveBeenCalledOnce();
  });
});
