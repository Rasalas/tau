import { describe, expect, it, vi } from "vitest";
import { sealPush } from "../../kits/push/relay";
import type { SavedHost, SecureStore } from "./hosts";
import { createPushRegistrar, createRelayPort, sealedTapRoute, tapRoute, type PushPort } from "./push";
import { PushKeys, pushKeyStoreKey } from "./push-keys";

const HOST: SavedHost = { id: "host-1", name: "Mac mini", endpoints: [], access: "full", addedAt: "2026-09-24T10:00:00.000Z" };

function port(overrides: Partial<PushPort> = {}): PushPort & { token: ReturnType<typeof vi.fn> } {
  return {
    platform: "ios",
    available: async () => true,
    permission: async () => "prompt",
    requestPermission: vi.fn(async () => "granted" as const),
    token: vi.fn(async () => "ab".repeat(32)),
    topic: async () => "de.tbuck.tau",
    onTap: () => () => undefined,
    ...overrides,
  } as PushPort & { token: ReturnType<typeof vi.fn> };
}

function memoryStore(): SecureStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, get: async (key) => values.get(key), set: async (key, value) => { values.set(key, value); }, remove: async (key) => { values.delete(key); } };
}

const HANDLE = "h".repeat(64);

describe("push registration", () => {
  it("asks the platform for the token once and hands it, with its own id for the host, to each host's Push Kit", async () => {
    const platform = port();
    const invokeHostExtension = vi.fn(async () => ({ registered: true }));
    const registrar = createPushRegistrar(platform);
    await expect(registrar.register({ host: HOST, client: { invokeHostExtension } })).resolves.toEqual({ state: "registered" });
    await registrar.register({ host: { ...HOST, id: "host-2" }, client: { invokeHostExtension } });
    expect(platform.requestPermission).toHaveBeenCalledTimes(2);
    expect(platform.token).toHaveBeenCalledTimes(1);
    expect(invokeHostExtension.mock.calls).toEqual([
      ["tau.push", "register", { platform: "ios", token: "ab".repeat(32), host: "host-1", topic: "de.tbuck.tau" }],
      ["tau.push", "register", { platform: "ios", token: "ab".repeat(32), host: "host-2", topic: "de.tbuck.tau" }],
    ]);
  });

  it("does nothing without permission or without a Firebase project in an Android build", async () => {
    const invokeHostExtension = vi.fn();
    await expect(createPushRegistrar(port({ permission: async () => "denied" })).register({ host: HOST, client: { invokeHostExtension } })).resolves.toEqual({ state: "denied" });
    await expect(createPushRegistrar(port({ platform: "android", available: async () => false })).register({ host: HOST, client: { invokeHostExtension } })).resolves.toEqual({ state: "unavailable" });
    expect(invokeHostExtension).not.toHaveBeenCalled();
  });

  it("carries on when the host will not take the token", async () => {
    const invokeHostExtension = vi.fn(async () => { throw new Error("Host extension tau.push is not installed."); });
    await expect(createPushRegistrar(port({ permission: async () => "granted" })).register({ host: HOST, client: { invokeHostExtension } }))
      .resolves.toEqual({ state: "refused", detail: "Host extension tau.push is not installed." });
  });

  it("asks the platform for a token again after it failed once", async () => {
    const token = vi.fn().mockRejectedValueOnce(new Error("no network")).mockResolvedValue("cd".repeat(32));
    const registrar = createPushRegistrar(port({ permission: async () => "granted", token }));
    const invokeHostExtension = vi.fn(async () => undefined);
    await expect(registrar.register({ host: HOST, client: { invokeHostExtension } })).rejects.toThrow("no network");
    await expect(registrar.register({ host: HOST, client: { invokeHostExtension } })).resolves.toEqual({ state: "registered" });
  });

  it("opens the thread a tapped notification names, and nothing for anything else", () => {
    expect(tapRoute({ url: "tau://thread?host=host-1&thread=t1", kind: "completed" })).toEqual({ view: "workbench", hostId: "host-1", threadId: "t1" });
    expect(tapRoute({ url: "https://example.com" })).toBeUndefined();
    expect(tapRoute({})).toBeUndefined();
  });
});

describe("push through Tau's relay", () => {
  it("hands each host the relay's handle and a key for that host alone, asking the relay once per token", async () => {
    const store = memoryStore();
    const relay = { register: vi.fn(async () => HANDLE) };
    const registrar = createPushRegistrar(port({ permission: async () => "granted" }), { relay, keys: new PushKeys(store) });
    const invokeHostExtension = vi.fn(async () => ({ registered: true }));
    await registrar.register({ host: HOST, client: { invokeHostExtension } });
    await registrar.register({ host: { ...HOST, id: "host-2" }, client: { invokeHostExtension } });
    await registrar.register({ host: HOST, client: { invokeHostExtension } });
    expect(relay.register).toHaveBeenCalledTimes(1);
    expect(relay.register).toHaveBeenCalledWith("ios", "ab".repeat(32));
    const sent = invokeHostExtension.mock.calls.map((call) => (call as unknown[])[2] as { relay: { handle: string; keyId: string; key: string } });
    expect(sent[0]!.relay.handle).toBe(HANDLE);
    expect(sent[0]!.relay).toEqual(sent[2]!.relay);
    expect(sent[1]!.relay.keyId).not.toBe(sent[0]!.relay.keyId);
    // The Android service finds the key under this name.
    expect(store.values.get(pushKeyStoreKey(sent[0]!.relay.keyId))).toBe(sent[0]!.relay.key);
  });

  it("registers with the token alone when the relay is out of reach, and asks it again next time", async () => {
    const relay = { register: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(HANDLE) };
    const registrar = createPushRegistrar(port({ permission: async () => "granted" }), { relay, keys: new PushKeys(memoryStore()) });
    const invokeHostExtension = vi.fn(async () => ({ registered: true }));
    await expect(registrar.register({ host: HOST, client: { invokeHostExtension } })).resolves.toEqual({ state: "registered" });
    expect(invokeHostExtension.mock.calls[0]).toEqual(["tau.push", "register", { platform: "ios", token: "ab".repeat(32), host: "host-1", topic: "de.tbuck.tau" }]);
    await registrar.register({ host: HOST, client: { invokeHostExtension } });
    expect((invokeHostExtension.mock.calls[1] as unknown[])[2]).toMatchObject({ relay: { handle: HANDLE } });
  });

  it("opens a tapped relay push's link with the host's key, until the phone forgets the host", async () => {
    const store = memoryStore();
    const keys = new PushKeys(store);
    const registrar = createPushRegistrar(port({ permission: async () => "granted" }), { relay: { register: async () => HANDLE }, keys });
    const key = await keys.forHost("host-1");
    const sealed = sealPush(key, { title: "Tau", body: "Done", url: "tau://thread?host=host-1&thread=t1" });
    await expect(sealedTapRoute({ sealed, aps: {} }, keys)).resolves.toEqual({ view: "workbench", hostId: "host-1", threadId: "t1" });
    await registrar.forget("host-1");
    await expect(sealedTapRoute({ sealed }, keys)).resolves.toBeUndefined();
    expect([...store.values.keys()]).toEqual(["push-keys.v1"]);
  });

  it("asks the relay for a handle over HTTPS and refuses an answer that is not one", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ handle: HANDLE }), { status: 200 }));
    await expect(createRelayPort("https://relay.test/relay", fetcher as typeof fetch).register("android", "fcm-token")).resolves.toBe(HANDLE);
    expect(fetcher.mock.calls[0]![0]).toBe("https://relay.test/relay/register");
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({ platform: "android", token: "fcm-token" });
    const refusing = async () => new Response(JSON.stringify({ error: "rate-limited" }), { status: 429 });
    await expect(createRelayPort("https://relay.test/relay", refusing as typeof fetch).register("android", "fcm-token")).rejects.toThrow(/rate-limited/u);
  });
});
