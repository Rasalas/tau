import { describe, expect, it, vi } from "vitest";
import type { HostEvent } from "../../src/shared/contracts";
import { followActivities, type ActivityPort } from "./activities";
import type { UsageLimitAccount } from "../../kits/usage/protocol";

const NOW = 1_800_000;
const account = (patch: Partial<UsageLimitAccount> = {}): UsageLimitAccount => ({ id: "private-id", runtime: "codex", label: "Codex", checkedAt: NOW, windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 40 }], identity: { provider: "openai", key: "hashed-account" }, ...patch });
const port = (): ActivityPort => ({ snapshot: vi.fn(async () => undefined), clear: vi.fn(async () => undefined) });

describe("activity delivery lifecycle", () => {
  it("keeps host routing and clears queued writes on revoke", async () => {
    vi.useFakeTimers();
    try {
      let event!: (event: HostEvent) => void;
      const off = vi.fn();
      const native = port();
      const follow = followActivities("host-a", { onHostEvent: (listener) => { event = listener; return off; }, bootstrap: vi.fn(async () => { throw Error("offline"); }), invokeHostExtension: vi.fn(async () => { throw Error("missing kit"); }) }, native, () => NOW);
      event({ type: "agent-status", sessionId: "thread-1", running: true });
      await vi.advanceTimersByTimeAsync(500);
      expect(native.snapshot).toHaveBeenCalledWith(expect.objectContaining({ hostId: "host-a", threads: [expect.objectContaining({ id: "thread-1", state: "running" })] }));
      event({ type: "agent-status", sessionId: "thread-2", running: true });
      await follow.revoke();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(native.snapshot).toHaveBeenCalledTimes(1);
      expect(native.clear).toHaveBeenCalledWith("host-a"); expect(off).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});

describe("widget snapshots", () => {
  it("hands the phone one debounced snapshot per host with machine, accounts and threads", async () => {
    vi.useFakeTimers();
    try {
      let event!: (event: HostEvent) => void;
      let clock = NOW;
      const native = port();
      const limits = { checkedAt: NOW, accounts: [account({ plan: "ChatGPT Plus", windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 91 }] })], sources: [] };
      const follow = followActivities("host-a", {
        onHostEvent: (listener) => { event = listener; return () => undefined; },
        bootstrap: vi.fn(async () => ({ threadIndex: { projects: [], sessions: [{ id: "t1", title: "Fix flaky pairing test", projectName: "tau", path: "", modifiedAt: NOW, projectPath: "", messageCount: 2 }], runs: { t1: NOW - 600_000 } } }) as never),
        invokeHostExtension: vi.fn(async (extension: string) => { if (extension === "tau.usage") return limits; throw Error("missing kit"); }),
      }, native, () => clock, "Mac mini");
      await vi.advanceTimersByTimeAsync(500);
      expect(native.snapshot).toHaveBeenCalledOnce();
      expect(native.snapshot).toHaveBeenLastCalledWith({
        version: 3, hostId: "host-a", machine: "Mac mini", updatedAt: NOW,
        accounts: [expect.objectContaining({ label: "Codex", plan: "ChatGPT Plus", tone: "openai", mark: "codex", windows: [expect.objectContaining({ short: "wk", level: "warn" })] })],
        threads: [{ id: "t1", title: "Fix flaky pairing test", project: "tau", state: "running", startedAt: NOW - 600_000 }],
      });
      clock += 60_000;
      event({ type: "extension-ui-prompt", sessionId: "t1", prompt: { id: "p", sessionId: "t1", kind: "confirm", title: "Allow edit?" } });
      await vi.advanceTimersByTimeAsync(500);
      expect(native.snapshot).toHaveBeenCalledTimes(2);
      expect(native.snapshot).toHaveBeenLastCalledWith(expect.objectContaining({ threads: [expect.objectContaining({ id: "t1", state: "waiting", reason: "Allow edit?", askedAt: clock })] }));
      // The two-minute beat writes again, so a Live Activity followed from the app never reads as stale.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(vi.mocked(native.snapshot).mock.calls.length).toBeGreaterThanOrEqual(3);
      follow.stop();
    } finally { vi.useRealTimers(); }
  });
});
