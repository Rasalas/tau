import { describe, expect, it } from "vitest";
import { HostBook, fallbackHostId, sortHosts, type SavedHost, type SecureStore } from "./hosts";

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
