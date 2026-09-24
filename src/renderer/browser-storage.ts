import type { ClientStorage } from "../workbench/client-storage";
import { environmentStorageKey } from "../shared/environments";
import { HOST_STORAGE_KEYS } from "../workbench/storage-keys";

/**
 * `localStorage` as the workbench's key-value store. Electron's renderer is a
 * browser like any other, so the desktop client and the web client share this
 * one adapter; only what they do with the clipboard and with files differs.
 * `environment` names the machine a desktop page shows when it is not the
 * window's own (ADR 0025): that host's keys then get a copy of their own.
 */
export function createLocalStorageAdapter(environment?: string): ClientStorage {
  const key = (name: string) => environmentStorageKey(name, environment, HOST_STORAGE_KEYS);
  /** The name a stored key has for this page, or undefined when it is another machine's copy. */
  const visible = (stored: string): string | undefined => {
    const at = stored.lastIndexOf("@");
    if (at > 0) {
      const name = stored.slice(0, at);
      const owner = stored.slice(at + 1);
      if (environmentStorageKey(name, owner, HOST_STORAGE_KEYS) === stored) return owner === environment ? name : undefined;
    }
    return key(stored) === stored ? stored : undefined;
  };
  return {
    get: (name) => localStorage.getItem(key(name)),
    set: (name, value) => localStorage.setItem(key(name), value),
    remove: (name) => localStorage.removeItem(key(name)),
    keys: (prefix) => {
      const result: string[] = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const stored = localStorage.key(index);
        const name = stored ? visible(stored) : undefined;
        if (name !== undefined && (!prefix || name.startsWith(prefix))) result.push(name);
      }
      return result;
    },
  };
}
