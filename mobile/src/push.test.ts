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
const DAY = 24 * 60 * 60 * 1000;
const RELAYED = { registered: true, ready: true, route: "relay" };

describe("push registration", () => {
  it("asks the platform for the token once, and hands it only to a host that sends with keys of its own", async () => {
    const platform = port();
    const invokeHostExtension = vi.fn(async (_kit: string, _command: string, input?: unknown) => ((input as { host: string }).host === "host-2" && !(input as { token?: string }).token
      ? { registered: true, ready: false, route: "direct", needsToken: true }
      : RELAYED));
    const registrar = createPushRegistrar(platform);
    await expect(registrar.register({ host: HOST, client: { invokeHostExtension } })).resolves.toEqual({ state: "registered" });
    await registrar.register({ host: { ...HOST, id: "host-2" }, client: { invokeHostExtension } });
    expect(platform.requestPermission).toHaveBeenCalledTimes(2);
    expect(platform.token).toHaveBeenCalledTimes(1);
    expect(invokeHostExtension.mock.calls).toEqual([
      ["tau.push", "register", { platform: "ios", host: "host-1", topic: "de.tbuck.tau" }],
      ["tau.push", "register", { platform: "ios", host: "host-2", topic: "de.tbuck.tau" }],
      ["tau.push", "register", { platform: "ios", token: "ab".repeat(32), host: "host-2", topic: "de.tbuck.tau" }],
    ]);
  });

  it("gives a host older than the relay the token it cannot do without", async () => {
    const invokeHostExtension = vi.fn(async (_kit: string, _command: string, input?: unknown) => {
      if (!(input as { token?: string }).token) throw new Error("That is not an APNs device token.");
      return { registered: true };
    });
    await expect(createPushRegistrar(port()).register({ host: HOST, client: { invokeHostExtension } })).resolves.toEqual({ state: "registered" });
    expect(invokeHostExtension.mock.calls.map((call) => (call[2] as { token?: string }).token)).toEqual([undefined, "ab".repeat(32)]);
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
  const sentRelay = (invoke: ReturnType<typeof vi.fn>) => invoke.mock.calls.map((call) => ((call as unknown[])[2] as { relay?: { handle: string; keyId: string; key: string } }).relay);

  it("gives each host its own handle and key, kept across app starts, and never the token", async () => {
    const store = memoryStore();
    let count = 0;
    const relay = { register: vi.fn(async () => `${HANDLE}${count += 1}`) };
    const invokeHostExtension = vi.fn(async () => RELAYED);
    const registrar = createPushRegistrar(port({ permission: async () => "granted" }), { relay, keys: new PushKeys(store) });
    await registrar.register({ host: HOST, client: { invokeHostExtension } });
    await registrar.register({ host: { ...HOST, id: "host-2" }, client: { invokeHostExtension } });
    // The app starts again.
    await createPushRegistrar(port({ permission: async () => "granted" }), { relay, keys: new PushKeys(store) }).register({ host: HOST, client: { invokeHostExtension } });
    expect(relay.register).toHaveBeenCalledTimes(2);
    expect(relay.register).toHaveBeenCalledWith("ios", "ab".repeat(32));
    const sent = sentRelay(invokeHostExtension);
    expect(sent.map((entry) => entry!.handle)).toEqual([`${HANDLE}1`, `${HANDLE}2`, `${HANDLE}1`]);
    expect(sent[0]).toEqual(sent[2]);
    expect(sent[1]!.keyId).not.toBe(sent[0]!.keyId);
    expect(JSON.stringify(invokeHostExtension.mock.calls)).not.toContain("ab".repeat(32));
    // The Android service finds the key under this name.
    expect(store.values.get(pushKeyStoreKey(sent[0]!.keyId))).toBe(sent[0]!.key);
  });

  it("renews a host's handle after 30 days, for a new token, and when the host says the relay refused it", async () => {
    let now = 1_700_000_000_000;
    let count = 0;
    const relay = { register: vi.fn(async () => `${HANDLE}${count += 1}`) };
    const token = vi.fn(async () => "ab".repeat(32));
    const keys = new PushKeys(memoryStore());
    const start = () => createPushRegistrar(port({ permission: async () => "granted", token }), { relay, keys, now: () => now });
    let refuse = "";
    const invokeHostExtension = vi.fn(async (_kit: string, _command: string, input?: unknown) => ((input as { relay?: { handle: string } }).relay?.handle === refuse ? { ...RELAYED, ready: false, renewHandle: true } : RELAYED));
    await start().register({ host: HOST, client: { invokeHostExtension } });
    now += 29 * DAY;
    await start().register({ host: HOST, client: { invokeHostExtension } });
    now += 2 * DAY;
    await start().register({ host: HOST, client: { invokeHostExtension } });
    token.mockResolvedValue("cd".repeat(32));
    await start().register({ host: HOST, client: { invokeHostExtension } });
    refuse = `${HANDLE}3`;
    await start().register({ host: HOST, client: { invokeHostExtension } });
    expect(sentRelay(invokeHostExtension).map((entry) => entry!.handle)).toEqual([`${HANDLE}1`, `${HANDLE}1`, `${HANDLE}2`, `${HANDLE}3`, `${HANDLE}3`, `${HANDLE}4`]);
    expect(relay.register.mock.calls.map((call) => (call as unknown[])[1])).toEqual(["ab".repeat(32), "ab".repeat(32), "cd".repeat(32), "cd".repeat(32)]);
  });

  it("keeps using a saved handle while the relay is out of reach, and registers without one when none is left", async () => {
    let now = 1_700_000_000_000;
    const relay = { register: vi.fn().mockResolvedValueOnce(HANDLE).mockRejectedValue(new Error("offline")) };
    const keys = new PushKeys(memoryStore());
    const registrar = createPushRegistrar(port({ permission: async () => "granted" }), { relay, keys, now: () => now });
    const invokeHostExtension = vi.fn(async () => RELAYED);
    await registrar.register({ host: HOST, client: { invokeHostExtension } });
    now += 45 * DAY;
    await expect(registrar.register({ host: HOST, client: { invokeHostExtension } })).resolves.toEqual({ state: "registered" });
    now += 20 * DAY;
    await registrar.register({ host: HOST, client: { invokeHostExtension } });
    expect(sentRelay(invokeHostExtension).map((entry) => entry?.handle)).toEqual([HANDLE, HANDLE, undefined]);
    expect((invokeHostExtension.mock.calls[2] as unknown[])[2]).toEqual({ platform: "ios", host: "host-1", topic: "de.tbuck.tau" });
  });

  it("opens a tapped relay push's link with the host's key, until the phone forgets the host", async () => {
    const store = memoryStore();
    const keys = new PushKeys(store);
    const registrar = createPushRegistrar(port({ permission: async () => "granted" }), { relay: { register: async () => HANDLE }, keys });
    const key = await keys.forHost("host-1");
    const sealed = sealPush(key, { title: "Tau", body: "Done", url: "tau://thread?host=host-1&thread=t1" });
    await expect(sealedTapRoute({ sealed, aps: {} }, keys)).resolves.toEqual({ view: "workbench", hostId: "host-1", threadId: "t1" });
    await registrar.register({ host: HOST, client: { invokeHostExtension: async () => RELAYED } });
    expect(await keys.handle("host-1")).toMatchObject({ handle: HANDLE });
    await registrar.forget("host-1");
    await expect(sealedTapRoute({ sealed }, keys)).resolves.toBeUndefined();
    expect([...store.values.keys()].sort()).toEqual(["push-handles.v1", "push-keys.v1"]);
    expect(await keys.handle("host-1")).toBeUndefined();
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
