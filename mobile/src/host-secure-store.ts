import type { SecureStore } from "./hosts";

/** UTF-8 hex keeps ids and keys separate and matches the native notification reader. */
export function hostSecureStore(store: SecureStore, hostId: string): SecureStore {
  if (!hostId) throw new Error("A secure store needs a machine identity.");
  const hex = (text: string) => Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const prefix = `host.v2:${hex(hostId)}:`;
  const scoped = (key: string) => `${prefix}${hex(key)}`;
  return {
    get: (key) => store.get(scoped(key)),
    set: (key, value) => store.set(scoped(key), value),
    remove: (key) => store.remove(scoped(key)),
  };
}

/** Move a legacy secret once; the global entry is no longer readable afterward. */
export async function migrateHostSecret(store: SecureStore, hostId: string, key: string, legacy: string): Promise<string | undefined> {
  const scoped = hostSecureStore(store, hostId);
  let value = await scoped.get(key);
  if (value === undefined) {
    value = await store.get(legacy);
    if (value !== undefined) await scoped.set(key, value);
  }
  await store.remove(legacy);
  return value;
}
