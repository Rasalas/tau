import { DEVICE_STORAGE_PREFIX, type ClientStorage } from "../../src/workbench/client-storage";

/**
 * One host's view of the page's store. The workbench keeps drafts, the
 * bootstrap cache and layout under fixed keys; with several hosts in one app
 * each needs its own, or one host's threads would flash up for another.
 * `device:` keys are the phone's own and stay shared.
 */
export function hostStorage(base: ClientStorage, hostId: string): ClientStorage {
  const prefix = `host:${hostId}:`;
  const scoped = (key: string) => key.startsWith(DEVICE_STORAGE_PREFIX) ? key : prefix + key;
  return {
    get: (key) => base.get(scoped(key)),
    set: (key, value) => base.set(scoped(key), value),
    remove: (key) => base.remove(scoped(key)),
    keys: (narrow) => narrow?.startsWith(DEVICE_STORAGE_PREFIX)
      ? base.keys(narrow)
      : base.keys(prefix + (narrow ?? "")).map((key) => key.slice(prefix.length)),
  };
}

/** Everything a host left in the page's store, when the phone forgets it. */
export function clearHostStorage(base: ClientStorage, hostId: string): void {
  for (const key of base.keys(`host:${hostId}:`)) base.remove(key);
}
