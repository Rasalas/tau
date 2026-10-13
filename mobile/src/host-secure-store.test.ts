import { describe, expect, it } from "vitest";
import { hostSecureStore, migrateHostSecret } from "./host-secure-store";
import { HostBook, type SavedHost } from "./hosts";
import { PushKeys } from "./push-keys";

function memory() {
  const data = new Map<string, string>();
  return { data, get: async (key: string) => data.get(key), set: async (key: string, value: string) => { data.set(key, value); }, remove: async (key: string) => { data.delete(key); } };
}

describe("per-machine secure storage", () => {
  it("cannot read, overwrite or remove another machine's keys, including separators in ids", async () => {
    const store = memory();
    const a = hostSecureStore(store, "a");
    const b = hostSecureStore(store, 'a/ä","token"]');
    await a.set("token", "secret-a");
    expect(await b.get("token")).toBeUndefined();
    await b.set("token", "secret-b");
    await b.remove("token");
    expect(await a.get("token")).toBe("secret-a");
    expect(await a.get('..:token.v1:b')).toBeUndefined();
    expect(() => hostSecureStore(store, "")).toThrow();
  });

  it("migrates old tokens and relay credentials without replacing a current secret", async () => {
    const store = memory();
    const book = new HostBook(store);
    await store.set("token.v1:a", "old-a");
    await store.set("token.v1:b", "old-b");
    expect(await book.token("a")).toBe("old-a");
    expect(await store.get("token.v1:a")).toBeUndefined();
    expect(await hostSecureStore(store, "b").get("token")).toBeUndefined();
    await hostSecureStore(store, "a").set("token", "new-a");
    await store.set("token.v1:a", "stale-a");
    expect(await migrateHostSecret(store, "a", "token", "token.v1:a")).toBe("new-a");
    expect(await book.token("b")).toBe("old-b");
    const host: SavedHost = { id: "a", name: "A", endpoints: [], access: "full", addedAt: "now" };
    await book.save(host, "paired", { url: "wss://relay.test", relay: "https://relay.test", id: "a".repeat(36), token: "relay-a" });
    expect(await hostSecureStore(store, "a").get("connect")).toContain("relay-a");
    expect(await hostSecureStore(store, "b").get("connect")).toBeUndefined();
    await book.remove("a");
    expect(await book.token("a")).toBeUndefined();
    expect(await hostSecureStore(store, "a").get("connect")).toBeUndefined();
  });

  it("keeps relay handles and push keys in each machine's namespace and deletes only that machine", async () => {
    const store = memory();
    const keys = new PushKeys(store);
    const a = await keys.forHost("a");
    const b = await keys.forHost("b");
    await keys.saveHandle("a", { handle: "handle-a", token: "token-a", at: 1 });
    await keys.saveHandle("b", { handle: "handle-b", token: "token-b", at: 2 });
    expect(await hostSecureStore(store, "a").get("push-key")).toContain(a.key);
    expect(await hostSecureStore(store, "b").get("push-key")).not.toContain(a.key);
    expect(await store.get("push-handles.v1")).not.toContain("token-a");
    await keys.forget("a");
    expect(await hostSecureStore(store, "a").get("push-key")).toBeUndefined();
    expect(await keys.handle("a")).toBeUndefined();
    expect(await keys.handle("b")).toMatchObject({ token: "token-b" });
    expect(await keys.key(b.keyId)).toBe(b.key);
  });

  it("migrates legacy push keys and handles without copying another machine's secrets", async () => {
    const store = memory();
    await store.set("push-keys.v1", JSON.stringify({ a: "key-a", b: "key-b" }));
    await store.set("push-key.v1:key-a", "secret-a");
    await store.set("push-key.v1:key-b", "secret-b");
    await store.set("push-handles.v1", JSON.stringify({ a: { handle: "handle-a", token: "token-a", at: 1 }, b: { handle: "handle-b", token: "token-b", at: 2 } }));
    const keys = new PushKeys(store);
    expect(await keys.key("key-a")).toBe("secret-a");
    expect(await store.get("push-key.v1:key-a")).toBeUndefined();
    expect(await keys.handle("a")).toMatchObject({ token: "token-a" });
    expect(await store.get("push-handles.v1")).not.toContain("token-a");
    expect(await hostSecureStore(store, "b").get("push-key")).toBeUndefined();
    expect(await store.get("push-key.v1:key-b")).toBe("secret-b");
  });
});
