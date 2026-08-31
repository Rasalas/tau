import type { SubmissionResult, UiPromptAttachment } from "../shared/contracts";
import {
  indexedDbPersistence,
  type ComposerScopePersistence,
  type PersistedScope,
} from "./composer-draft-persistence";
import { errorMessage } from "./error-message";

export { ComposerDraftPersistence, indexedDbPersistence } from "./composer-draft-persistence";
export type { ComposerScopePersistence, PersistedAttachment, PersistedScope } from "./composer-draft-persistence";

declare const draftKeyBrand: unique symbol;
export type DraftKey = string & { readonly [draftKeyBrand]: true };
export type ComposerScope = DraftKey;

export function createDraftKey(storageKey?: string): DraftKey {
  return (storageKey ?? "thread:default") as DraftKey;
}

export type PendingAttachment = UiPromptAttachment & { id: number; previewUrl: string };

let nextAttachmentId = 0;
export function allocateAttachmentId(): number { return nextAttachmentId++; }

export interface ComposerScopeState {
  draft: string;
  revision: number;
  attachments: PendingAttachment[];
  error?: string;
  errorSubmissionId?: number;
  attachmentProcessing: Promise<void>;
  attachmentProcessingReady: boolean;
  pendingSubmissions: Map<number, { attachmentIds: ReadonlySet<number>; revision: number; draft: string }>;
  hydrationGeneration: number;
  persistenceQueue: Promise<void>;
  updatedAt: number;
  persistenceError?: string;
  submissionBusy: boolean;
}

/** Opaque snapshot/settlement handle owned by one composer scope. */
export interface SubmissionHandle {
  readonly text: string;
  readonly attachments: readonly UiPromptAttachment[];
  /** Settles exactly once; the store applies the result to the captured scope. */
  settle(result: SubmissionResult): void;
  /** Ends an empty submission without changing the draft or displaying an error. */
  cancel(): void;
}

export interface SubmissionBusy {
  readonly busy: true;
}

export interface ComposerScopeSnapshot {
  readonly draft: string;
  readonly attachments: readonly PendingAttachment[];
  readonly error?: string;
  readonly errorSubmissionId?: number;
  readonly attachmentProcessing: Promise<void>;
  readonly persistenceError?: string;
  readonly submissionPending: boolean;
}

export class ComposerScopeStore {
  private readonly states = new Map<ComposerScope, ComposerScopeState>();
  private readonly snapshots = new Map<ComposerScope, ComposerScopeSnapshot>();
  private readonly listeners = new Map<ComposerScope, Set<() => void>>();
  private readonly pendingSubmissionPromises = new Map<ComposerScope, Promise<SubmissionHandle>>();
  private readonly activeSubmissionHandles = new Map<ComposerScope, SubmissionHandle>();

  private nextSubmissionId = 0;

  constructor(private readonly persistence: ComposerScopePersistence = indexedDbPersistence) {}

  ensure(scope: ComposerScope): ComposerScopeState {
    const existing = this.states.get(scope);
    if (existing) return existing;
    const draft = this.persistence.readLegacyDraft?.(scope) ?? "";
    const created: ComposerScopeState = {
      draft,
      revision: 0,
      attachments: [],
      attachmentProcessing: Promise.resolve(),
      attachmentProcessingReady: true,
      pendingSubmissions: new Map(),
      hydrationGeneration: 0,
      persistenceQueue: Promise.resolve(),
      updatedAt: draft ? Date.now() : 0,
      submissionBusy: false,
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
      attachments: [...state.attachments],
      error: state.error,
      errorSubmissionId: state.errorSubmissionId,
      attachmentProcessing: state.attachmentProcessing,
      persistenceError: state.persistenceError,
      submissionPending: state.submissionBusy,
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
      // The legacy localStorage record contains text only. It must never erase
      // images that were added while its asynchronous migration was pending.
      const nextAttachments = legacyRecord && state.attachments.length > 0
        ? state.attachments
        : persisted.attachments.map((attachment) => {
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
      state.persistenceError = errorMessage(error);
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
      state.persistenceError = errorMessage(error);
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
      this.persistence.writeLegacyDraft?.(scope, draft);
    } catch (error) {
      state.persistenceError = errorMessage(error);
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
    state.persistenceError = errorMessage(error);
    this.notify(scope);
  }

  setAttachmentProcessing(scope: ComposerScope, processing: Promise<void>): void {
    const state = this.ensure(scope);
    state.attachmentProcessing = processing;
    state.attachmentProcessingReady = false;
    void processing.then(() => {
      if (state.attachmentProcessing === processing) state.attachmentProcessingReady = true;
    }, () => {
      if (state.attachmentProcessing === processing) state.attachmentProcessingReady = true;
    });
    this.notify(scope);
  }

  beginSubmission(scope: ComposerScope, onError: (error: unknown) => void = () => {}): SubmissionHandle | Promise<SubmissionHandle> | SubmissionBusy {
    const state = this.ensure(scope);
    const active = this.activeSubmissionHandles.get(scope);
    if (active) return { busy: true };
    const existing = this.pendingSubmissionPromises.get(scope);
    if (existing || state.submissionBusy) return { busy: true };
    state.submissionBusy = true;
    this.notify(scope);
    if (!state.attachmentProcessingReady) {
      const pending = state.attachmentProcessing.then(() => this.createSubmission(scope, onError));
      const owned = pending.catch((error) => {
        if (this.pendingSubmissionPromises.get(scope) === owned) this.pendingSubmissionPromises.delete(scope);
        state.submissionBusy = false;
        this.notify(scope);
        throw error;
      });
      this.pendingSubmissionPromises.set(scope, owned);
      return owned;
    }
    return this.createSubmission(scope, onError);
  }

  private createSubmission(scope: ComposerScope, onError: (error: unknown) => void): SubmissionHandle {
    const state = this.ensure(scope);
    const id = this.nextSubmissionId++;
    const revision = state.revision;
    const attachmentIds = new Set(state.attachments.map((attachment) => attachment.id));
    const text = state.draft;
    const attachments = state.attachments.map(({ id: _id, previewUrl: _previewUrl, ...attachment }) => attachment);
    state.pendingSubmissions.set(id, { attachmentIds, revision, draft: text });
    this.pendingSubmissionPromises.delete(scope);
    this.notify(scope);
    let settled = false;
    const handle: SubmissionHandle = {
      text,
      attachments,
      settle: (result) => {
        if (settled) return;
        settled = true;
        try {
          this.settleSubmission(scope, id, result, onError);
        } finally {
          if (this.activeSubmissionHandles.get(scope) === handle) this.activeSubmissionHandles.delete(scope);
          this.ensure(scope).submissionBusy = false;
          this.notify(scope);
        }
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        this.ensure(scope).pendingSubmissions.delete(id);
        this.activeSubmissionHandles.delete(scope);
        this.ensure(scope).submissionBusy = false;
        this.notify(scope);
      },
    };
    this.activeSubmissionHandles.set(scope, handle);
    return handle;
  }

  private settleSubmission(scope: ComposerScope, id: number, result: SubmissionResult, onError: (error: unknown) => void): void {
    const state = this.ensure(scope);
    const pending = state.pendingSubmissions.get(id);
    if (!pending) return;
    state.pendingSubmissions.delete(id);
    const sameRevision = state.revision === pending.revision;
    const sameDraft = state.draft === pending.draft;
    if (result.accepted) {
      state.attachments = state.attachments.filter((attachment) => !pending.attachmentIds.has(attachment.id));
      if (sameRevision || sameDraft) state.draft = "";
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
    if (result.accepted && (sameRevision || sameDraft)) {
      try {
        this.persistence.writeLegacyDraft?.(scope, "");
      } catch (error) {
        state.persistenceError = errorMessage(error);
        onError(error);
      }
    }
    this.persist(scope, onError);
    this.notify(scope);
  }
}
