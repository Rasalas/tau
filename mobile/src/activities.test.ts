import { describe, expect, it, vi } from "vitest";
import type { HostEvent } from "../../src/shared/contracts";
import { followActivities, type ActivityPort } from "./activities";
import type { UsageLimitAccount } from "../../kits/usage/protocol";

const NOW = 1_800_000;
const account = (patch: Partial<UsageLimitAccount> = {}): UsageLimitAccount => ({ id: "private-id", runtime: "codex", label: "Codex", checkedAt: NOW, windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 40 }], identity: { provider: "openai", key: "hashed-account" }, ...patch });
describe("activity delivery lifecycle", () => {
  it("keeps host and thread routing, retains needs-input at turn completion and clears queued writes on revoke", async () => {
    let event!: (event: HostEvent) => void;
    const off = vi.fn();
    const port: ActivityPort = { update: vi.fn(async () => undefined), usage: vi.fn(async () => undefined), clear: vi.fn(async () => undefined) };
    const follow = followActivities("host-a", { onHostEvent: (listener) => { event = listener; return off; }, bootstrap: vi.fn(async () => { throw Error("offline"); }), invokeHostExtension: vi.fn(async () => { throw Error("missing kit"); }) }, port, () => NOW);
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
  it("writes the host's threads once per burst of events, and the usage snapshot with the machine's name", async () => {
    vi.useFakeTimers();
    try {
      let event!: (event: HostEvent) => void;
      const port: ActivityPort = { threads: vi.fn(async () => undefined), usage: vi.fn(async () => undefined), clear: vi.fn(async () => undefined) };
      const limits = { checkedAt: NOW, accounts: [account()], sources: [] };
      const follow = followActivities("host-a", {
        onHostEvent: (listener) => { event = listener; return () => undefined; },
        bootstrap: vi.fn(async () => ({ threadIndex: { projects: [], sessions: [{ id: "t1", title: "Fix flaky pairing test", projectName: "tau", path: "", modifiedAt: 0, projectPath: "", messageCount: 1 }], runs: { t1: NOW - 60_000 } } }) as never),
        invokeHostExtension: vi.fn(async (extension: string) => { if (extension === "tau.usage") return limits; throw Error("missing kit"); }),
      }, port, () => NOW, "Mac mini");
      await vi.advanceTimersByTimeAsync(0);
      event({ type: "extension-ui-prompt", sessionId: "t1", prompt: { id: "p", sessionId: "t1", kind: "confirm", title: "Allow edit?" } });
      await vi.advanceTimersByTimeAsync(500);
      expect(port.threads).toHaveBeenCalledOnce();
      expect(port.threads).toHaveBeenCalledWith({ version: 1, hostId: "host-a", machine: "Mac mini", updatedAt: NOW, threads: [expect.objectContaining({ id: "t1", state: "waiting", reason: "Allow edit?", startedAt: NOW - 60_000 })] });
      expect(port.usage).toHaveBeenCalledWith(expect.objectContaining({ version: 2, hostId: "host-a", machine: "Mac mini", accounts: [expect.objectContaining({ label: "Codex", tone: "openai" })] }));
      // The two-minute beat writes again, so a Live Activity followed from the app never reads as stale.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(port.threads).toHaveBeenCalledTimes(2);
      follow.stop();
    } finally { vi.useRealTimers(); }
  });
});
