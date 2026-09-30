import type { SecureStore } from "./hosts";
import { newPushKey } from "./push-crypto";

const INDEX_KEY = "push-keys.v1";
/** Also read by the Android app's messaging service (TauMessagingService.java). */
export const pushKeyStoreKey = (keyId: string) => `push-key.v1:${keyId}`;

/**
 * The key this phone gave each host for what its pushes say, in the secure
 * store: one per host, made the first time the host hears of it and kept
 * until the phone forgets the host.
 */
export class PushKeys {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: SecureStore) {}

  forHost(hostId: string): Promise<{ keyId: string; key: string }> {
    return this.serial(async () => {
      const index = await this.index();
      const known = index[hostId];
      const key = known ? await this.store.get(pushKeyStoreKey(known)) : undefined;
      if (known && key) return { keyId: known, key };
      const fresh = newPushKey();
      await this.store.set(pushKeyStoreKey(fresh.keyId), fresh.key);
      await this.store.set(INDEX_KEY, JSON.stringify({ ...index, [hostId]: fresh.keyId }));
      return fresh;
    });
  }

  key(keyId: string): Promise<string | undefined> {
    return this.store.get(pushKeyStoreKey(keyId));
  }

  /** The host's pushes no longer open here. */
  forget(hostId: string): Promise<void> {
    return this.serial(async () => {
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
    try {
      const parsed = JSON.parse((await this.store.get(INDEX_KEY)) ?? "{}") as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
    } catch {
      return {};
    }
  }
}
