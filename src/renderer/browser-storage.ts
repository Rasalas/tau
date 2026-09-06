import type { ClientStorage } from "../workbench/client-storage";

/**
 * `localStorage` as the workbench's key-value store. Electron's renderer is a
 * browser like any other, so the desktop client and the web client share this
 * one adapter; only what they do with the clipboard and with files differs.
 */
export function createLocalStorageAdapter(): ClientStorage {
  return {
    get: (key) => localStorage.getItem(key),
    set: (key, value) => localStorage.setItem(key, value),
    remove: (key) => localStorage.removeItem(key),
    keys: (prefix) => {
      const result: string[] = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key && (!prefix || key.startsWith(prefix))) result.push(key);
      }
      return result;
    },
  };
}
