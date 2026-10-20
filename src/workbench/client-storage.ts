/**
 * The workbench's key-value store. The browser's own store is one
 * implementation, built by the platform (`src/renderer/platform-electron.ts`);
 * a web or mobile client supplies its own. Nothing here may touch a browser
 * global (`client-storage-boundary.test.ts`).
 */
export interface ClientStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** Keys currently stored; `prefix` narrows to keys starting with it. */
  keys(prefix?: string): string[];
  /** Serializes persisted work across this client's windows. Absent where durable work cannot be coordinated. */
  withLock?<T>(key: string, work: () => Promise<T>): Promise<T>;
}

/**
 * Keys under this prefix belong to the device, not to the host it shows: a
 * client that keeps several hosts' state apart (the phone app) shares them
 * across hosts (API 1.30.0).
 */
export const DEVICE_STORAGE_PREFIX = "device:";

/** For tests and the browser preview, where no browser store exists or one must not leak between cases. */
export function createMemoryStorage(): ClientStorage {
  const store = new Map<string, string>();
  const locks = new Map<string, Promise<unknown>>();
  return {
    get: (key) => store.get(key) ?? null,
    set: (key, value) => { store.set(key, value); },
    remove: (key) => { store.delete(key); },
    keys: (prefix) => [...store.keys()].filter((key) => !prefix || key.startsWith(prefix)),
    withLock: (key, work) => {
      const result = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
      locks.set(key, result);
      const release = () => { if (locks.get(key) === result) locks.delete(key); };
      void result.then(release, release);
      return result;
    },
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
