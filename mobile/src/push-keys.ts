import type { SecureStore } from "./hosts";
import { newPushKey } from "./push-crypto";
import { hostSecureStore } from "./host-secure-store";

const INDEX_KEY = "push-keys.v1";
const HANDLES_KEY = "push-handles.v1";
/** Legacy entry, migrated when its machine's key is read. */
export const pushKeyStoreKey = (keyId: string) => `push-key.v1:${keyId}`;

/** The relay's handle for one host, the token it seals, and when the phone got it (ms). */
export interface SavedHandle {
  handle: string;
  token: string;
  at: number;
}

/**
 * The key this phone gave each host for what its pushes say, in the secure
 * store: one per host, made the first time the host hears of it and kept
 * until the phone forgets the host. Each host's relay handle is kept beside it.
 */
export class PushKeys {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: SecureStore) {}

  forHost(hostId: string): Promise<{ keyId: string; key: string }> {
    return this.serial(async () => {
      const index = await this.index();
      const secrets = hostSecureStore(this.store, hostId);
      const known = Object.hasOwn(index, hostId) ? index[hostId] : undefined;
      const key = known ? await this.readHostKey(hostId, known) : undefined;
      if (known && key) return { keyId: known, key };
      const fresh = newPushKey();
      await secrets.set("push-key", JSON.stringify(fresh));
      await this.store.set(INDEX_KEY, JSON.stringify({ ...index, [hostId]: fresh.keyId }));
      return fresh;
    });
  }

  handle(hostId: string): Promise<SavedHandle | undefined> {
    return this.serial(async () => {
      const secrets = hostSecureStore(this.store, hostId);
      const handles = await this.read(HANDLES_KEY);
      const text = await secrets.get("push-handle");
      let saved: Partial<SavedHandle> | undefined;
      try { saved = text ? JSON.parse(text) as Partial<SavedHandle> : handles[hostId] as Partial<SavedHandle> | undefined; } catch { return undefined; }
      if (saved && !text) await secrets.set("push-handle", JSON.stringify(saved));
      if (Object.hasOwn(handles, hostId)) {
        const { [hostId]: _gone, ...others } = handles;
        await this.store.set(HANDLES_KEY, JSON.stringify(others));
      }
      return typeof saved?.handle === "string" && typeof saved.token === "string" && typeof saved.at === "number" ? saved as SavedHandle : undefined;
    });
  }

  saveHandle(hostId: string, saved: SavedHandle): Promise<void> {
    return this.serial(async () => {
      await hostSecureStore(this.store, hostId).set("push-handle", JSON.stringify(saved));
      const { [hostId]: _gone, ...others } = await this.read(HANDLES_KEY);
      await this.store.set(HANDLES_KEY, JSON.stringify(others));
    });
  }

  key(keyId: string): Promise<string | undefined> {
    return this.serial(async () => {
      const hostId = Object.entries(await this.index()).find(([, id]) => id === keyId)?.[0];
      return hostId ? this.readHostKey(hostId, keyId) : undefined;
    });
  }

  private async readHostKey(hostId: string, keyId: string): Promise<string | undefined> {
    const secrets = hostSecureStore(this.store, hostId);
    const text = await secrets.get("push-key");
    if (text) {
      try {
        const saved = JSON.parse(text) as { keyId?: string; key?: string };
        if (saved.keyId === keyId && typeof saved.key === "string") {
          await this.store.remove(pushKeyStoreKey(keyId));
          return saved.key;
        }
      } catch { /* An unreadable key is replaced when this machine registers again. */ }
      return undefined;
    }
    const key = await this.store.get(pushKeyStoreKey(keyId));
    if (key) {
      await secrets.set("push-key", JSON.stringify({ keyId, key }));
      await this.store.remove(pushKeyStoreKey(keyId));
    }
    return key;
  }

  /** The host's pushes no longer open here. */
  forget(hostId: string): Promise<void> {
    return this.serial(async () => {
      const secrets = hostSecureStore(this.store, hostId);
      await secrets.remove("push-handle");
      await secrets.remove("push-key");
      const handles = await this.read(HANDLES_KEY);
      if (hostId in handles) {
        const { [hostId]: _gone, ...others } = handles;
        await this.store.set(HANDLES_KEY, JSON.stringify(others));
      }
      const { [hostId]: keyId, ...rest } = await this.index();
      if (!keyId) return;
      await this.store.remove(pushKeyStoreKey(keyId));
      await this.store.set(INDEX_KEY, JSON.stringify(rest));
    });
  }

  private serial<T>(change: () => Promise<T>): Promise<T> {
    const next = this.queue.then(change, change);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async index(): Promise<Record<string, string>> {
    return await this.read(INDEX_KEY) as Record<string, string>;
  }

  private async read(key: string): Promise<Record<string, unknown>> {
    try {
      const parsed = JSON.parse((await this.store.get(key)) ?? "{}") as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
}
