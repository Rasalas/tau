import { readComposerDraft, writeComposerDraft } from "./draft-store";

export interface PersistedAttachment {
  id: number;
  kind: "image";
  name: string;
  mimeType: string;
  data: string;
  size: number;
}

export interface PersistedScope {
  key: string;
  draft: string;
  attachments: PersistedAttachment[];
  revision?: number;
  textRevision?: number;
  attachmentRevision?: number;
  updatedAt?: number;
}

export interface ComposerScopePersistence {
  readLegacyDraft?(key: string): string;
  writeLegacyDraft?(key: string, text: string): void;
  load(key: string): Promise<PersistedScope | undefined>;
  save(scope: PersistedScope): Promise<void>;
  delete(key: string): Promise<void>;
}

const DATABASE_NAME = "tau-composer-scopes";
const DATABASE_VERSION = 1;
const STORE_NAME = "drafts";

function openDatabase(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === "undefined") return Promise.resolve(undefined);
  return new Promise<IDBDatabase | undefined>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open composer storage."));
  });
}

async function runDraftWriteTransaction(
  database: IDBDatabase,
  operation: (store: IDBObjectStore) => void,
  action: "save" | "delete",
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    try {
      operation(transaction.objectStore(STORE_NAME));
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error(`Could not ${action} composer storage.`));
    transaction.onabort = () => reject(transaction.error ?? new Error(`Could not ${action} composer storage.`));
  }).finally(() => database.close());
}

/** Durable draft persistence; migration from the legacy text-only localStorage lives here. */
export class ComposerDraftPersistence implements ComposerScopePersistence {
  readLegacyDraft(key: string): string {
    return readComposerDraft(window.localStorage, key);
  }

  writeLegacyDraft(key: string, text: string): void {
    writeComposerDraft(window.localStorage, key, text);
  }

  async load(key: string): Promise<PersistedScope | undefined> {
    const database = await openDatabase();
    if (!database) {
      const draft = this.readLegacyDraft(key);
      return draft ? { key, draft, attachments: [] } : undefined;
    }
    return new Promise<PersistedScope | undefined>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result as PersistedScope | undefined);
      request.onerror = () => reject(request.error ?? new Error("Could not read composer storage."));
    }).finally(() => database.close());
  }

  async save(scope: PersistedScope): Promise<void> {
    const database = await openDatabase();
    if (!database) {
      // localStorage is only a migration fallback. Image data is never written there.
      return;
    }
    await runDraftWriteTransaction(database, (store) => store.put(scope), "save");
  }

  async delete(key: string): Promise<void> {
    const database = await openDatabase();
    if (!database) return;
    await runDraftWriteTransaction(database, (store) => store.delete(key), "delete");
  }
}

export const indexedDbPersistence: ComposerScopePersistence = new ComposerDraftPersistence();
