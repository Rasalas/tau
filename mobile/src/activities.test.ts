import { describe, expect, it, vi } from "vitest";
import type { HostEvent } from "../../src/shared/contracts";
import { followActivities, widgetAccounts, type ActivityPort } from "./activities";
import type { UsageLimitAccount } from "../../kits/usage/protocol";

const NOW = 1_800_000;
const account = (patch: Partial<UsageLimitAccount> = {}): UsageLimitAccount => ({ id: "private-id", runtime: "codex", label: "Codex", checkedAt: NOW, windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 40 }], identity: { provider: "openai", key: "hashed-account" }, ...patch });
describe("native account snapshots", () => {
  it("pools one subscription using its freshest read, excludes signed out and stale accounts, and strips identifiers", () => {
    const result = widgetAccounts([account(), account({ runtime: "pi", checkedAt: NOW + 10, windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 55 }] }), account({ checkedAt: 0 }), account({ unavailable: { reason: "signed-out" } })], NOW + 10);
    expect(result).toHaveLength(1);
    expect(result[0]?.windows[0]?.usedPercent).toBe(55);
    expect(JSON.stringify(result)).not.toContain("private-id");
  });
  it("does not pool accounts with no known identity", () => {
    expect(widgetAccounts([account({ identity: undefined, id: "a" }), account({ identity: undefined, id: "b" })], NOW)).toHaveLength(2);
  });
});
describe("activity delivery lifecycle", () => {
  it("keeps host and thread routing, retains needs-input at turn completion and clears queued writes on revoke", async () => {
    let event!: (event: HostEvent) => void;
    const off = vi.fn();
    const port: ActivityPort = { update: vi.fn(async () => undefined), usage: vi.fn(async () => undefined), clear: vi.fn(async () => undefined) };
    const follow = followActivities("host-a", { onHostEvent: (listener) => { event = listener; return off; }, bootstrap: vi.fn(async () => { throw Error("offline"); }), invokeHostExtension: vi.fn(async () => { throw Error("missing kit"); }) }, port, { now: () => NOW });
    event({ type: "agent-status", sessionId: "thread-1", running: true });
    await vi.waitFor(() => expect(port.update).toHaveBeenCalledWith(expect.objectContaining({ hostId: "host-a", threadId: "thread-1", state: "running" })));
    event({ type: "error", sessionId: "thread-1", message: "Needs a login" });
    event({ type: "agent-status", sessionId: "thread-1", running: false });
    await vi.waitFor(() => expect(port.update).toHaveBeenLastCalledWith(expect.objectContaining({ state: "needs-input" })));
    event({ type: "agent-status", sessionId: "thread-2", running: true });
    await follow.revoke();
    expect(port.update).not.toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread-2" }));
    expect(port.clear).toHaveBeenCalledWith("host-a"); expect(off).toHaveBeenCalledOnce();
  });
});
describe("widget snapshots", () => {
  it("hands the widgets one debounced snapshot per host with its threads, machine and accounts", async () => {
    vi.useFakeTimers();
    try {
      let event!: (event: HostEvent) => void;
      let clock = NOW;
      const snapshot = vi.fn(async () => undefined);
      const port: ActivityPort = { update: vi.fn(async () => undefined), usage: vi.fn(async () => undefined), clear: vi.fn(async () => undefined), snapshot };
      const limits = { accounts: [account({ plan: "ChatGPT Plus", windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 91 }] })] };
      const follow = followActivities("host-a", {
        onHostEvent: (listener) => { event = listener; return () => undefined; },
        bootstrap: vi.fn(async () => ({ threadIndex: { projects: [], sessions: [{ id: "t1", title: "Fix flaky pairing test", projectName: "tau", modifiedAt: NOW, messageCount: 2 }], runs: { t1: NOW - 600_000 } } }) as never),
        invokeHostExtension: vi.fn(async (_id: string, command: string) => command === "limits" ? limits : undefined),
      }, port, { now: () => clock, machine: "Mac mini" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(snapshot).toHaveBeenCalledOnce();
      expect(snapshot).toHaveBeenLastCalledWith(expect.objectContaining({
        version: 2, hostId: "host-a", machine: "Mac mini",
        accounts: [expect.objectContaining({ label: "Codex", plan: "ChatGPT Plus", tone: "openai", mark: "codex" })],
        threads: [expect.objectContaining({ id: "t1", title: "Fix flaky pairing test", project: "tau", state: "running", since: NOW - 600_000 })],
      }));
      clock += 60_000;
      event({ type: "extension-ui-prompt", sessionId: "t1", prompt: { id: "p", sessionId: "t1", kind: "confirm", title: "Edit src/routes/orders.ts?" } });
      event({ type: "agent-status", sessionId: "t1", running: false });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(snapshot).toHaveBeenCalledTimes(2);
      expect(snapshot).toHaveBeenLastCalledWith(expect.objectContaining({ threads: [expect.objectContaining({ state: "question", detail: "Edit src/routes/orders.ts?", since: clock })] }));
      event({ type: "extension-ui-resolved", id: "p", sessionId: "t1" });
      event({ type: "error", sessionId: "t1", message: "Rate limited" });
      event({ type: "agent-status", sessionId: "t1", running: false });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(snapshot).toHaveBeenLastCalledWith(expect.objectContaining({ threads: [expect.objectContaining({ state: "failed" })] }));
      event({ type: "agent-status", sessionId: "t2", running: true });
      await follow.revoke();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(snapshot).toHaveBeenCalledTimes(3);
      expect(port.clear).toHaveBeenCalledWith("host-a");
    } finally { vi.useRealTimers(); }
  });
});
