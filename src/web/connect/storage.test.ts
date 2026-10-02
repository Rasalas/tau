// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserConnectStorage } from "./storage";
import type { BrowserConnectSession } from "./offer";

const session: BrowserConnectSession = { route: { relay: "https://relay.example", id: "3ee8aef8-dcee-47b3-90dc-4f37309bab35", token: "r".repeat(43), url: "wss://inner.example/host", pin: "ab".repeat(32), key: true }, token: "tauc.private-host-token", name: "Home" };
beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("isSecureContext", true); });
afterEach(() => vi.unstubAllGlobals());

async function record<T>(id: string, value?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("tau.browser-connect.v1", 1);
    open.onsuccess = () => {
      const db = open.result; const tx = db.transaction("credentials", value === undefined ? "readonly" : "readwrite"); const store = tx.objectStore("credentials");
      const request = value === undefined ? store.get(id) : store.put(value, id);
      tx.oncomplete = () => { db.close(); resolve(request.result as T); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
    open.onerror = () => reject(open.error);
  });
}

describe("browser Connect credentials", () => {
  it("persists encrypted credentials across instances with a non-exportable key and forgets them", async () => {
    await new BrowserConnectStorage().save(session);
    const sealed = await record<{ iv: Uint8Array; bytes: ArrayBuffer }>("session");
    expect(sealed.iv.byteLength).toBe(12);
    expect(new TextDecoder().decode(sealed.bytes)).not.toContain(session.token);
    expect(new TextDecoder().decode(sealed.bytes)).not.toContain(session.route.token);
    const key = await record<CryptoKey>("key");
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
    expect(await new BrowserConnectStorage().load()).toEqual(session);
    await new BrowserConnectStorage().remove();
    expect(await new BrowserConnectStorage().load()).toBeUndefined();
  });

  it("authenticates stored ciphertext and deletes a corrupted credential", async () => {
    const storage = new BrowserConnectStorage(); await storage.save(session);
    const sealed = await record<{ iv: Uint8Array; bytes: ArrayBuffer }>("session");
    new Uint8Array(sealed.bytes)[0] ^= 1;
    await record("session", sealed);
    await expect(storage.load()).rejects.toThrow("could not be verified");
    expect(await storage.load()).toBeUndefined();
  });

  it("chooses one encryption key when two tabs save their first credential concurrently", async () => {
    const first = new BrowserConnectStorage(); const second = new BrowserConnectStorage();
    await Promise.all([first.save(session), second.save({ ...session, token: "tauc.second" })]);
    const restored = await first.load();
    expect([session.token, "tauc.second"]).toContain(restored?.token);
    expect(await second.load()).toEqual(restored);
  });

  it("fails closed outside a secure browser context", async () => {
    vi.stubGlobal("isSecureContext", false);
    await expect(new BrowserConnectStorage().save(session)).rejects.toThrow("requires HTTPS");
  });

  it("does not save credentials for an attempt cancelled during encryption", async () => {
    const storage = new BrowserConnectStorage();
    expect(await storage.save(session, () => false)).toBe(false);
    expect(await storage.load()).toBeUndefined();
  });
});
