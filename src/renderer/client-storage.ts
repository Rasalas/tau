/**
 * The renderer's key-value store. `localStorage` is one implementation; a web
 * or mobile client supplies its own. Everything reaches storage through this
 * interface, never through `localStorage` directly (enforced by
 * `client-storage-boundary.test.ts`).
 */
export interface ClientStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** Keys currently stored; `prefix` narrows to keys starting with it. */
  keys(prefix?: string): string[];
}

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

/** For tests and the browser preview, where `localStorage` is unavailable or must not leak between cases. */
export function createMemoryStorage(): ClientStorage {
  const store = new Map<string, string>();
  return {
    get: (key) => store.get(key) ?? null,
    set: (key, value) => { store.set(key, value); },
    remove: (key) => { store.delete(key); },
    keys: (prefix) => [...store.keys()].filter((key) => !prefix || key.startsWith(prefix)),
  };
}

let ambientStorage: ClientStorage | undefined;

/**
 * `main.tsx` calls this once, before the first render, so module-scope
 * singletons created outside the component tree (Workspace Kit's store) can
 * still reach the active storage without prop-drilling through every extension.
 */
export function setClientStorage(storage: ClientStorage | undefined): void {
  ambientStorage = storage;
}

/** The storage `setClientStorage` last installed, for non-component modules. */
export function getClientStorage(): ClientStorage | undefined {
  return ambientStorage;
}
