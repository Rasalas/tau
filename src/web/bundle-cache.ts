import type { DesktopExtensionBundle } from "../shared/contracts";
import type { HostClient } from "../workbench/host-client";

/**
 * The packages' desktop halves a browser or the phone app was sent, kept in
 * IndexedDB by their digest. The next start names the digests it holds and
 * the host sends only the bundles that changed: on a slow network that is the
 * difference between seconds and a moment before the packages' pages, panels
 * and settings are there. IndexedDB, not the Cache API: a tab on a tailnet
 * address over plain HTTP is not a secure context.
 */
export interface BundleStore {
  digests(): Promise<string[]>;
  get(digest: string): Promise<Pick<DesktopExtensionBundle, "code" | "styles"> | undefined>;
  put(digest: string, bundle: Pick<DesktopExtensionBundle, "code" | "styles">): Promise<void>;
  /** Forgets every bundle but these. */
  keep(digests: readonly string[]): Promise<void>;
}

const STORE = "bundles";

function request<T>(run: (store: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode, db: IDBDatabase): Promise<T> {
  return new Promise((resolve, reject) => {
    const call = run(db.transaction(STORE, mode).objectStore(STORE));
    call.onsuccess = () => resolve(call.result);
    call.onerror = () => reject(call.error ?? new Error("IndexedDB request failed"));
  });
}

/** The browser's own store; undefined where it has none. */
export function indexedBundleStore(factory: IDBFactory | undefined = globalThis.indexedDB, name = "tau-bundles"): BundleStore | undefined {
  if (!factory) return undefined;
  let opened: Promise<IDBDatabase> | undefined;
  const open = () => opened ??= new Promise((resolve, reject) => {
    const call = factory.open(name, 1);
    call.onupgradeneeded = () => { call.result.createObjectStore(STORE); };
    call.onsuccess = () => resolve(call.result);
    call.onerror = () => reject(call.error ?? new Error("IndexedDB did not open"));
  });
  return {
    digests: async () => (await request((store) => store.getAllKeys(), "readonly", await open())).map(String),
    get: async (digest) => request((store) => store.get(digest) as IDBRequest<Pick<DesktopExtensionBundle, "code" | "styles"> | undefined>, "readonly", await open()),
    put: async (digest, bundle) => { await request((store) => store.put({ code: bundle.code, ...(bundle.styles === undefined ? {} : { styles: bundle.styles }) }, digest), "readwrite", await open()); },
    keep: async (digests) => {
      const db = await open();
      const wanted = new Set(digests);
      const stale = (await request((store) => store.getAllKeys(), "readonly", db)).filter((key) => !wanted.has(String(key)));
      await Promise.all(stale.map((key) => request((store) => store.delete(key), "readwrite", db)));
    },
  };
}

/**
 * A host client whose package loads name the bundles this client holds and
 * fill in what the host left out. A bundle the store lost in between is asked
 * for again, whole; a store that fails costs only the saving.
 */
export function withBundleStore(client: HostClient, store: BundleStore | undefined): HostClient {
  if (!store) return client;
  return {
    ...client,
    loadDesktopExtensions: async (cwd, sharedExports, only) => {
      const held = await store.digests().catch(() => [] as string[]);
      const result = await client.loadDesktopExtensions(cwd, sharedExports, only, held);
      const missing: string[] = [];
      const bundles = await Promise.all(result.bundles.map(async (bundle) => {
        if (!bundle.hash) return bundle;
        if (!bundle.cached) {
          void store.put(bundle.hash, bundle).catch(() => undefined);
          return bundle;
        }
        const kept = await store.get(bundle.hash).catch(() => undefined);
        if (!kept) missing.push(bundle.id);
        return kept ? { ...bundle, ...kept, cached: false } : bundle;
      }));
      if (missing.length > 0) {
        const again = await client.loadDesktopExtensions(cwd, sharedExports, missing, []);
        for (const fresh of again.bundles) {
          const at = bundles.findIndex((bundle) => bundle.id === fresh.id);
          if (at >= 0) bundles[at] = fresh;
          if (fresh.hash) void store.put(fresh.hash, fresh).catch(() => undefined);
        }
      }
      // A partial load (`only`) keeps the rest; a whole one leaves only what it named.
      if (!only) void store.keep(bundles.flatMap((bundle) => bundle.hash ?? [])).catch(() => undefined);
      return { ...result, bundles: bundles.filter((bundle) => !bundle.cached) };
    },
  };
}
