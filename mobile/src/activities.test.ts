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
