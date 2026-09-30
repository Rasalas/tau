import { describe, expect, it, vi } from "vitest";
import { relayActivities } from "./activity-relay";
import type { ActivityPort, ActivityToken } from "./activities";
const token: ActivityToken = { hostId: "host", threadId: "thread", topic: "de.tbuck.tau", token: "ab".repeat(32) };
describe("purpose-bound activity registration", () => {
  it("installs a shared widget key and sends the host an activity handle", async () => {
    let native!: (token: ActivityToken) => void;
    const port: ActivityPort = { update: vi.fn(), usage: vi.fn(), clear: vi.fn(), tokens: async (listener) => { native = listener; return () => undefined; } };
    const installKey = vi.fn(async () => undefined); const listener = vi.fn();
    const options = { url: "https://relay.invalid", authorized: async () => true, keys: { forHost: async () => ({ keyId: "key".repeat(7), key: "k".repeat(43) }) }, installKey,
      fetch: vi.fn(async () => new Response(JSON.stringify({ purpose: "activity", handle: "h".repeat(64) }))) as unknown as typeof fetch };
    const wrapped = relayActivities(port, options); const off = await wrapped.tokens!(listener);
    native(token);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(expect.objectContaining({ relay: expect.objectContaining({ handle: "h".repeat(64) }) })));
    expect(installKey).toHaveBeenCalledWith(expect.objectContaining({ hostId: "host" }));
    expect(JSON.parse((options.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1].body)).toMatchObject({ purpose: "activity", token: token.token });
    off();
  });
  it("does not register a host that this phone forgot", async () => {
    let native!: (token: ActivityToken) => void;
    const fetcher = vi.fn(); const listener = vi.fn();
    const wrapped = relayActivities({ update: vi.fn(), usage: vi.fn(), clear: vi.fn(), tokens: async (next) => { native = next; return () => undefined; } }, { url: "https://relay.invalid", authorized: async () => false, keys: { forHost: vi.fn() }, installKey: vi.fn(), fetch: fetcher });
    await wrapped.tokens!(listener); native(token); await Promise.resolve(); await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
  });
});
