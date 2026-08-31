import type { UiPromptAttachment } from "../shared/contracts";
import { readComposerDraft, writeComposerDraft } from "./draft-store";

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
  revision?: number;
  updatedAt?: number;
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
  await runDraftWriteTransaction(database, (store) => store.put(scope), "save");
}

async function deletePersistedScope(key: string): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  await runDraftWriteTransaction(database, (store) => store.delete(key), "delete");
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

export interface ComposerScopeState {
  draft: string;
  revision: number;
  attachments: PendingAttachment[];
  error?: string;
  errorSubmissionId?: number;
  attachmentProcessing: Promise<void>;
  pendingSubmissions: Map<number, { attachmentIds: ReadonlySet<number>; revision: number }>;
  hydrationGeneration: number;
  persistenceQueue: Promise<void>;
  updatedAt: number;
  persistenceError?: string;
}

export interface ComposerScopeSnapshot {
  readonly draft: string;
  readonly revision: number;
  readonly attachments: readonly PendingAttachment[];
  readonly error?: string;
  readonly errorSubmissionId?: number;
  readonly attachmentProcessing: Promise<void>;
  readonly persistenceError?: string;
}

export class ComposerScopeStore {
  private readonly states = new Map<ComposerScope, ComposerScopeState>();
  private readonly snapshots = new Map<ComposerScope, ComposerScopeSnapshot>();
  private readonly listeners = new Map<ComposerScope, Set<() => void>>();

  constructor(private readonly persistence: ComposerScopePersistence = indexedDbPersistence) {}

  ensure(scope: ComposerScope): ComposerScopeState {
    const existing = this.states.get(scope);
    if (existing) return existing;
    const draft = readComposerDraft(window.localStorage, scope);
    const created: ComposerScopeState = {
      draft,
      revision: 0,
      attachments: [],
      attachmentProcessing: Promise.resolve(),
      pendingSubmissions: new Map(),
      hydrationGeneration: 0,
      persistenceQueue: Promise.resolve(),
      updatedAt: draft ? Date.now() : 0,
    };
    this.states.set(scope, created);
    return created;
  }

  getSnapshot(scope: ComposerScope): ComposerScopeSnapshot {
    const current = this.snapshots.get(scope);
    if (current) return current;
    const state = this.ensure(scope);
    const snapshot = this.snapshotFor(state);
    this.snapshots.set(scope, snapshot);
    return snapshot;
  }

  subscribe(scope: ComposerScope, listener: () => void): () => void {
    const listeners = this.listeners.get(scope) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(scope, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(scope);
    };
  }

  private snapshotFor(state: ComposerScopeState): ComposerScopeSnapshot {
    return {
      draft: state.draft,
      revision: state.revision,
      attachments: [...state.attachments],
      error: state.error,
      errorSubmissionId: state.errorSubmissionId,
      attachmentProcessing: state.attachmentProcessing,
      persistenceError: state.persistenceError,
    };
  }

  private notify(scope: ComposerScope): void {
    const state = this.ensure(scope);
    this.snapshots.set(scope, this.snapshotFor(state));
    for (const listener of this.listeners.get(scope) ?? []) listener();
  }

  hydrate(scope: ComposerScope, onError: (error: unknown) => void): void {
    const state = this.ensure(scope);
    const generation = ++state.hydrationGeneration;
    const revision = state.revision;
    const updatedAt = state.updatedAt;
    void this.persistence.load(scope).then((persisted) => {
      if (!persisted || state.hydrationGeneration !== generation || state.revision !== revision) return;
      const persistedUpdatedAt = persisted.updatedAt ?? 0;
      const persistedRevision = persisted.revision ?? 0;
      const hasLocalState = state.draft.length > 0 || state.attachments.length > 0 || revision > 0;
      const legacyRecord = persisted.revision === undefined && persisted.updatedAt === undefined;
      const persistedIsNewer = !hasLocalState || legacyRecord || persistedRevision > revision || persistedUpdatedAt > updatedAt;
      if (!persistedIsNewer) return;
      const keepLocalDraft = state.draft.length > 0 && state.updatedAt > persistedUpdatedAt;
      const nextAttachments = persisted.attachments.map((attachment) => {
        nextAttachmentId = Math.max(nextAttachmentId, attachment.id + 1);
        return { ...attachment, previewUrl: `data:${attachment.mimeType};base64,${attachment.data}` };
      });
      const changed = (!keepLocalDraft && state.draft !== persisted.draft)
        || state.attachments.length !== nextAttachments.length
        || state.attachments.some((attachment, index) => attachment.id !== nextAttachments[index]?.id);
      if (!keepLocalDraft) state.draft = persisted.draft;
      state.attachments = nextAttachments;
      state.updatedAt = Math.max(state.updatedAt, persistedUpdatedAt);
      state.revision = Math.max(state.revision, persistedRevision);
      if (changed) this.notify(scope);
    }).catch((error) => {
      state.persistenceError = error instanceof Error ? error.message : String(error);
      this.notify(scope);
      onError(error);
    });
  }

  persist(scope: ComposerScope, onError: (error: unknown) => void): void {
    const state = this.ensure(scope);
    const snapshot: PersistedScope = {
      key: scope,
      draft: state.draft,
      attachments: state.attachments.map(({ previewUrl: _previewUrl, ...attachment }) => attachment),
      revision: state.revision,
      updatedAt: state.updatedAt,
    };
    state.persistenceQueue = state.persistenceQueue.then(() => {
      if (!snapshot.draft && snapshot.attachments.length === 0) return this.persistence.delete(snapshot.key);
      return this.persistence.save(snapshot);
    }).then(() => {
      state.persistenceError = undefined;
      this.notify(scope);
    }).catch((error) => {
      state.persistenceError = error instanceof Error ? error.message : String(error);
      this.notify(scope);
      onError(error);
    });
  }

  setDraft(scope: ComposerScope, draft: string, onError: (error: unknown) => void): void {
    const state = this.ensure(scope);
    state.draft = draft;
    state.revision += 1;
    state.updatedAt = Date.now();
    state.persistenceError = undefined;
    try {
      writeComposerDraft(window.localStorage, scope, draft);
    } catch (error) {
      state.persistenceError = error instanceof Error ? error.message : String(error);
      onError(error);
    }
    this.notify(scope);
    this.persist(scope, onError);
  }

  setAttachments(scope: ComposerScope, attachments: PendingAttachment[], onError: (error: unknown) => void): void {
    const state = this.ensure(scope);
    state.attachments = attachments;
    state.revision += 1;
    state.updatedAt = Date.now();
    state.persistenceError = undefined;
    this.notify(scope);
    this.persist(scope, onError);
  }

  addAttachments(scope: ComposerScope, attachments: PendingAttachment[], maxAttachments: number, onError: (error: unknown) => void): void {
    const state = this.ensure(scope);
    this.setAttachments(scope, [...state.attachments, ...attachments].slice(0, maxAttachments), onError);
  }

  removeAttachment(scope: ComposerScope, attachmentId: number, onError: (error: unknown) => void): void {
    const state = this.ensure(scope);
    this.setAttachments(scope, state.attachments.filter((attachment) => attachment.id !== attachmentId), onError);
  }

  setError(scope: ComposerScope, error: string | undefined, submissionId: number | undefined): void {
    const state = this.ensure(scope);
    state.error = error;
    state.errorSubmissionId = submissionId;
    this.notify(scope);
  }

  setPersistenceError(scope: ComposerScope, error: unknown): void {
    const state = this.ensure(scope);
    state.persistenceError = error instanceof Error ? error.message : String(error);
    this.notify(scope);
  }

  setAttachmentProcessing(scope: ComposerScope, processing: Promise<void>): void {
    this.ensure(scope).attachmentProcessing = processing;
    this.notify(scope);
  }

  beginSubmission(scope: ComposerScope, id: number, attachmentIds: ReadonlySet<number>, revision: number): void {
    this.ensure(scope).pendingSubmissions.set(id, { attachmentIds, revision });
    this.notify(scope);
  }

  settleSubmission(scope: ComposerScope, id: number, result: SubmitResultForStore, onError: (error: unknown) => void): boolean {
    const state = this.ensure(scope);
    const pending = state.pendingSubmissions.get(id);
    if (!pending) return false;
    state.pendingSubmissions.delete(id);
    const sameRevision = state.revision === pending.revision;
    if (result.accepted) {
      state.attachments = state.attachments.filter((attachment) => !pending.attachmentIds.has(attachment.id));
      if (sameRevision) state.draft = "";
      if (state.errorSubmissionId === undefined || state.errorSubmissionId === id) {
        state.error = undefined;
        state.errorSubmissionId = undefined;
      }
    } else {
      state.error = result.message;
      state.errorSubmissionId = id;
    }
    state.revision += 1;
    state.updatedAt = Date.now();
    if (result.accepted && sameRevision) {
      try {
        writeComposerDraft(window.localStorage, scope, "");
      } catch (error) {
        state.persistenceError = error instanceof Error ? error.message : String(error);
        onError(error);
      }
    }
    this.persist(scope, onError);
    this.notify(scope);
    return true;
  }
}

export type SubmitResultForStore = { accepted: true } | { accepted: false; message: string };

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
