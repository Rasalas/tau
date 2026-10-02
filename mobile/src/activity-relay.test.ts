import { describe, expect, it, vi } from "vitest";
import { relayActivities } from "./activity-relay";
import type { ActivityPort, ActivityToken } from "./activities";
const token: ActivityToken = { hostId: "host", threadId: "thread", topic: "de.tbuck.tau", token: "ab".repeat(32) };
describe("purpose-bound activity registration", () => {
  it("installs a shared widget key and sends the host an activity handle", async () => {
    let native!: (token: ActivityToken) => void;
    const port: ActivityPort = { snapshot: vi.fn(), clear: vi.fn(), tokens: async (listener) => { native = listener; return () => undefined; } };
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
    const wrapped = relayActivities({ snapshot: vi.fn(), clear: vi.fn(), tokens: async (next) => { native = next; return () => undefined; } }, { url: "https://relay.invalid", authorized: async () => false, keys: { forHost: vi.fn() }, installKey: vi.fn(), fetch: fetcher });
    await wrapped.tokens!(listener); native(token); await Promise.resolve(); await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
  });
});

it.each(["wrong-purpose", "network"])("fails closed on %s without passing the activity token to a host", async (failure) => {
  let native!: (token: ActivityToken) => void;
  const fetcher = vi.fn(async () => { if (failure === "network") throw Error("offline"); return new Response(JSON.stringify({ handle: "h".repeat(64) })); });
  const listener = vi.fn();
  const wrapped = relayActivities({ snapshot: vi.fn(), clear: vi.fn(), tokens: async (next) => { native = next; return () => undefined; } }, { url: "https://relay.invalid", authorized: async () => true, keys: { forHost: async () => ({ keyId: "k".repeat(22), key: "k".repeat(43) }) }, installKey: vi.fn(async () => undefined), fetch: fetcher });
  await wrapped.tokens!(listener); native(token);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  await Promise.resolve(); await Promise.resolve();
  expect(listener).not.toHaveBeenCalled();
});

it("checks the generation captured before authorization and never installs a key after a concurrent clear", async () => {
  let native!: (token: ActivityToken) => void;
  let authorize!: (authorized: boolean) => void;
  const installKey = vi.fn(); const fetcher = vi.fn(); const listener = vi.fn(); const clear = vi.fn(async () => undefined);
  const wrapped = relayActivities({ snapshot: vi.fn(), clear, tokens: async (next) => { native = next; return () => undefined; } }, { url: "https://relay.invalid", authorized: () => new Promise((resolve) => { authorize = resolve; }), keys: { forHost: vi.fn() }, installKey, fetch: fetcher });
  await wrapped.tokens!(listener); native(token);
  await wrapped.clear("host"); authorize(true);
  await Promise.resolve(); await Promise.resolve();
  expect(installKey).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
});

it("serializes key removal behind an already pending key installation", async () => {
  let native!: (token: ActivityToken) => void;
  let finishInstall!: () => void;
  const operations: string[] = []; const listener = vi.fn(); const fetcher = vi.fn();
  const installKey = vi.fn(async () => { operations.push("install"); await new Promise<void>((resolve) => { finishInstall = resolve; }); });
  const wrapped = relayActivities({ snapshot: vi.fn(), clear: async () => { operations.push("clear"); }, tokens: async (next) => { native = next; return () => undefined; } }, { url: "https://relay.invalid", authorized: async () => true, keys: { forHost: async () => ({ keyId: "k".repeat(22), key: "k".repeat(43) }) }, installKey, fetch: fetcher });
  await wrapped.tokens!(listener); native(token);
  await vi.waitFor(() => expect(installKey).toHaveBeenCalledOnce());
  const cleared = wrapped.clear("host"); finishInstall(); await cleared;
  expect(operations).toEqual(["install", "clear"]); expect(fetcher).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
});

it("uses a raw activity token only for a host explicitly registered on its own APNs route", async () => {
  let native!: (token: ActivityToken) => void;
  const listener = vi.fn(); const fetcher = vi.fn(); const installKey = vi.fn();
  const wrapped = relayActivities({ snapshot: vi.fn(), clear: vi.fn(), tokens: async (next) => { native = next; return () => undefined; } }, { url: "https://relay.invalid", authorized: async () => true, direct: () => true, keys: { forHost: vi.fn() }, installKey, fetch: fetcher });
  await wrapped.tokens!(listener); native(token);
  await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(token));
  expect(fetcher).not.toHaveBeenCalled(); expect(installKey).not.toHaveBeenCalled();
});
