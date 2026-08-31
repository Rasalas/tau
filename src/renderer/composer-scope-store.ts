import type { UiPromptAttachment } from "../shared/contracts";
import { readComposerDraft } from "./draft-store";

declare const draftKeyBrand: unique symbol;
export type DraftKey = string & { readonly [draftKeyBrand]: true };
export type ComposerScope = DraftKey;

export function createDraftKey(storageKey?: string): DraftKey {
  return (storageKey ?? "thread:default") as DraftKey;
}

export type PendingAttachment = UiPromptAttachment & { id: number; previewUrl: string };

let nextAttachmentId = 0;
export function allocateAttachmentId(): number { return nextAttachmentId++; }

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

async function loadPersistedScope(key: string): Promise<PersistedScope | undefined> {
  const database = await openDatabase();
  if (!database) return undefined;
  return new Promise<PersistedScope | undefined>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result as PersistedScope | undefined);
    request.onerror = () => reject(request.error ?? new Error("Could not read composer storage."));
  }).finally(() => database.close());
}

async function savePersistedScope(scope: PersistedScope): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(scope);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save composer storage."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Could not save composer storage."));
  }).finally(() => database.close());
}

async function deletePersistedScope(key: string): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not delete composer storage."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Could not delete composer storage."));
  }).finally(() => database.close());
}

export interface ComposerScopeState {
  draft: string;
  revision: number;
  attachments: PendingAttachment[];
  error?: string;
  errorSubmissionId?: number;
  queue: Promise<void>;
  pendingSubmissions: Map<number, { attachmentIds: ReadonlySet<number>; revision: number }>;
  hydrationGeneration: number;
  persistenceQueue: Promise<void>;
}

export class ComposerScopeStore {
  private readonly states = new Map<ComposerScope, ComposerScopeState>();

  constructor(private readonly persistence: ComposerScopePersistence = indexedDbPersistence) {}

  ensure(scope: ComposerScope): ComposerScopeState {
    const existing = this.states.get(scope);
    if (existing) return existing;
    const created: ComposerScopeState = {
      draft: readComposerDraft(window.localStorage, scope),
      revision: 0,
      attachments: [],
      queue: Promise.resolve(),
      pendingSubmissions: new Map(),
      hydrationGeneration: 0,
      persistenceQueue: Promise.resolve(),
    };
    this.states.set(scope, created);
    return created;
  }

  hydrate(scope: ComposerScope, onChange: () => void, onError: (error: unknown) => void): void {
    const state = this.ensure(scope);
    const generation = ++state.hydrationGeneration;
    const revision = state.revision;
    void this.persistence.load(scope).then((persisted) => {
      if (!persisted || state.hydrationGeneration !== generation || state.revision !== revision) return;
      state.draft = persisted.draft;
      state.attachments = persisted.attachments.map((attachment) => {
        nextAttachmentId = Math.max(nextAttachmentId, attachment.id + 1);
        return { ...attachment, previewUrl: `data:${attachment.mimeType};base64,${attachment.data}` };
      });
      onChange();
    }).catch(onError);
  }

  persist(scope: ComposerScope, onError: (error: unknown) => void): void {
    const state = this.ensure(scope);
    const snapshot: PersistedScope = {
      key: scope,
      draft: state.draft,
      attachments: state.attachments.map(({ previewUrl: _previewUrl, ...attachment }) => attachment),
    };
    state.persistenceQueue = state.persistenceQueue.then(() => {
      if (!snapshot.draft && snapshot.attachments.length === 0) return this.persistence.delete(snapshot.key);
      return this.persistence.save(snapshot);
    }).catch(onError);
  }
}

export interface ComposerScopePersistence {
  load(key: string): Promise<PersistedScope | undefined>;
  save(scope: PersistedScope): Promise<void>;
  delete(key: string): Promise<void>;
}

const indexedDbPersistence: ComposerScopePersistence = {
  load: loadPersistedScope,
  save: savePersistedScope,
  delete: deletePersistedScope,
};
