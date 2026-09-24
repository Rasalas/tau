import { describe, expect, it } from "vitest";
import { HostBook, fallbackHostId, migratedPin, reachedHostEndpoints, sortHosts, type SavedHost, type SecureStore, type WonAddress } from "./hosts";
import { sameAddress } from "./pairing";

function memoryStore(): SecureStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (key) => data.get(key), set: async (key, value) => { data.set(key, value); }, remove: async (key) => { data.delete(key); } };
}

const host = (id: string, extra: Partial<SavedHost> = {}): SavedHost => ({ id, name: `Host ${id}`, endpoints: [{ url: `https://${id}.local:7788/`, kind: "mdns" }], access: "full", addedAt: "2026-09-01T00:00:00.000Z", ...extra });

describe("HostBook", () => {
  it("keeps each host with its token apart, and replaces a host paired again", async () => {
    const store = memoryStore();
    const book = new HostBook(store);
    await book.save(host("a"), "token-a");
    await book.save(host("b"), "token-b");
    await book.save(host("a", { name: "Studio" }), "token-a2");
    expect((await book.list()).map((entry) => entry.name)).toEqual(["Host b", "Studio"]);
    expect(await book.token("a")).toBe("token-a2");
    // The list itself never holds a token.
    expect(store.data.get("hosts.v1")).not.toContain("token-");
  });

  it("forgets a token without the host, and a host with its token", async () => {
    const book = new HostBook(memoryStore());
    await book.save(host("a"), "token-a");
    await book.forgetToken("a");
    expect(await book.get("a")).toBeDefined();
    expect(await book.token("a")).toBeUndefined();
    await book.save(host("b"), "token-b");
    await book.remove("b");
    expect(await book.get("b")).toBeUndefined();
    expect(await book.token("b")).toBeUndefined();
  });

  it("updates what a later connection learned and reads a damaged list as empty", async () => {
    const store = memoryStore();
    const book = new HostBook(store);
    await book.save(host("a"), "t");
    await book.update("a", { lastUsedAt: "2026-09-24T10:00:00.000Z" });
    expect((await book.get("a"))?.lastUsedAt).toBe("2026-09-24T10:00:00.000Z");
    await book.update("missing", { name: "x" });
    store.data.set("hosts.v1", "{not json");
    expect(await book.list()).toEqual([]);
    store.data.set("hosts.v1", JSON.stringify([{ id: "x" }, host("ok")]));
    expect((await book.list()).map((entry) => entry.id)).toEqual(["ok"]);
  });
});

describe("HostBook under concurrent changes", () => {
  it("keeps every one of several changes made at once", async () => {
    const book = new HostBook(memoryStore());
    await Promise.all([book.save(host("a"), "ta"), book.save(host("b"), "tb")]);
    await Promise.all([book.update("a", { lastUsedAt: "2026-09-24T10:00:00.000Z" }), book.update("a", { name: "Studio" }), book.update("b", { name: "Laptop" })]);
    const hosts = await book.list();
    expect(hosts.find((entry) => entry.id === "a")).toMatchObject({ name: "Studio", lastUsedAt: "2026-09-24T10:00:00.000Z" });
    expect(hosts.find((entry) => entry.id === "b")?.name).toBe("Laptop");
  });
});

describe("host helpers", () => {
  it("lists the most recently used first", () => {
    const sorted = sortHosts([host("old"), host("new", { lastUsedAt: "2026-09-20T00:00:00.000Z" }), host("mid", { addedAt: "2026-09-10T00:00:00.000Z" })]);
    expect(sorted.map((entry) => entry.id)).toEqual(["new", "mid", "old"]);
  });

  it("names a host that sent no id after its certificate, else its first address", () => {
    expect(fallbackHostId("AB:CD:EF:01:23:45:67:89:AA:BB", [])).toBe("unnamed-abcdef0123456789");
    expect(fallbackHostId(undefined, [{ url: "https://192.168.1.2:7788/" }])).toBe("unnamed-https-192-168-1-2-7788-");
  });
});

const FP = "AB:".repeat(31) + "AB";
const KEY = "EF:".repeat(31) + "EF";

describe("after a hello", () => {
  const won = (extra: Partial<WonAddress["candidate"]>, seen: WonAddress["seen"]): WonAddress => ({
    candidate: { url: "wss://192.168.1.2:7788/", rank: 0, trust: "pin", allowAuthority: false, ...extra },
    seen,
  });

  it("moves a certificate pin to the key the pinned certificate carried", () => {
    const old = host("a", { fingerprint: FP });
    expect(migratedPin(old, won({ fingerprint: FP }, { fingerprint: FP, publicKey: KEY }))).toEqual({ publicKey: KEY, fingerprint: undefined });
  });

  it("learns no key from a socket a CA let in, nor from one pinned by key already", () => {
    const old = host("a", { fingerprint: FP });
    // Tailscale Serve before the flag: the old pin gave way to the CA; that key is the proxy's.
    expect(migratedPin(old, won({ fingerprint: FP, allowAuthority: true }, { fingerprint: "CD", publicKey: "CD" }))).toBeUndefined();
    expect(migratedPin(old, won({ trust: "authority", proxied: true }, { fingerprint: "CD", publicKey: "CD" }))).toBeUndefined();
    expect(migratedPin(host("a", { publicKey: KEY }), won({ publicKey: KEY }, { fingerprint: FP, publicKey: KEY }))).toBeUndefined();
  });

  it("keeps every address the host lists, the Serve name flagged, plus the one it won with", () => {
    const bonjour = host("a", { publicKey: KEY, endpoints: [{ url: "https://192.168.1.2:7788/", kind: "lan" }] });
    const reach = { hostId: "a", endpoints: [
      { url: "https://192.168.1.2:7788/", kind: "lan" as const },
      { url: "https://100.64.0.2:7788/", kind: "tailscale" as const },
      { url: "https://mac.tail0000.ts.net/", kind: "magicdns" as const, trustedCertificate: true },
    ] };
    expect(reachedHostEndpoints(bonjour, reach, "wss://192.168.1.2:7788/", sameAddress)).toEqual(reach.endpoints);
    expect(reachedHostEndpoints({ ...bonjour, endpoints: reach.endpoints }, reach, "wss://192.168.1.2:7788/", sameAddress)).toBeUndefined();
    // A simulator reached the host on loopback, which the host never lists to a device.
    const simulator = host("a", { endpoints: [{ url: "https://127.0.0.1:52233/", kind: "loopback" }] });
    expect(reachedHostEndpoints(simulator, reach, "wss://127.0.0.1:52233/", sameAddress)?.at(-1)).toEqual({ url: "https://127.0.0.1:52233/", kind: "loopback" });
    expect(reachedHostEndpoints(bonjour, { ...reach, hostId: "b" }, undefined, sameAddress)).toBeUndefined();
    expect(reachedHostEndpoints(bonjour, { endpoints: [] }, undefined, sameAddress)).toBeUndefined();
  });
});
