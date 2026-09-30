import { validBrowserConnectSession, type BrowserConnectSession } from "./offer";

const DATABASE = "tau.browser-connect.v1";
interface Sealed { iv: Uint8Array; bytes: ArrayBuffer }
/** Browser credentials use an origin-bound, non-exportable WebCrypto key. */
export class BrowserConnectStorage {
  private database?: Promise<IDBDatabase>;
  private open(): Promise<IDBDatabase> {
    if (!globalThis.isSecureContext || !globalThis.crypto?.subtle || !globalThis.indexedDB) return Promise.reject(new Error("Saving Tau Connect requires HTTPS and browser storage."));
    return this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("credentials");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("The browser could not open its secure Connect storage."));
      request.onblocked = () => reject(new Error("Another Tau tab is blocking Connect storage. Close it and try again."));
    });
  }
  private async read<T>(id: string): Promise<T | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("credentials", "readonly"); const request = transaction.objectStore("credentials").get(id);
      transaction.oncomplete = () => resolve(request.result as T | undefined);
      transaction.onabort = () => reject(new Error("The browser could not read its Connect credentials."));
    });
  }
  private async key(): Promise<CryptoKey> {
    const existing = await this.read<CryptoKey>("key"); if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    // A second tab may have generated a key too. Pick the first one inside
    // the serialized read/write transaction, so it cannot overwrite the key.
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("credentials", "readwrite"); const store = transaction.objectStore("credentials");
      const request = store.get("key"); let chosen = key;
      request.onsuccess = () => { if (request.result) chosen = request.result as CryptoKey; else store.put(key, "key"); };
      transaction.oncomplete = () => resolve(chosen); transaction.onabort = () => reject(new Error("The browser could not save its Connect encryption key."));
    });
  }
  async load(): Promise<BrowserConnectSession | undefined> {
    const sealed = await this.read<Sealed>("session"); if (!sealed) return undefined;
    try {
      const key = await this.read<CryptoKey>("key"); if (!key) throw new Error("missing key");
      const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv, additionalData: new TextEncoder().encode(DATABASE) }, key, sealed.bytes);
      const session: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!validBrowserConnectSession(session)) throw new Error("invalid record");
      return session;
    } catch { await this.remove(); throw new Error("The browser's saved Connect credentials could not be verified. Pair again."); }
  }
  async save(session: BrowserConnectSession, current = () => true): Promise<boolean> {
    if (!validBrowserConnectSession(session)) throw new Error("Invalid Connect credentials.");
    const key = await this.key(); const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(DATABASE) }, key, new TextEncoder().encode(JSON.stringify(session)));
    if (!current()) return false;
    await this.write({ iv, bytes });
    return true;
  }
  remove(): Promise<void> { return this.write(); }
  private async write(sealed?: Sealed): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("credentials", "readwrite"); const store = transaction.objectStore("credentials");
      if (sealed) store.put(sealed, "session"); else store.delete("session");
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(new Error("The browser could not save its Connect credentials."));
    });
  }
}
