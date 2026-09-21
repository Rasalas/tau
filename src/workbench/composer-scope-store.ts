import type { SubmissionResult, UiPromptAttachment, UiPromptImageAttachment } from "../shared/contracts";

declare const draftKeyBrand: unique symbol;
export type DraftKey = string & { readonly [draftKeyBrand]: true };
export type ComposerScope = DraftKey;

export function createDraftKey(storageKey?: string): DraftKey {
  return (storageKey ?? "thread:default") as DraftKey;
}

/** The composer itself holds images only; files arrive through an extension's own send hook. */
export type PendingAttachment = UiPromptImageAttachment & { id: number; previewUrl: string };
export interface ComposerScopeReference { scope: ComposerScope }

let nextAttachmentId = 0;
export function allocateAttachmentId(): number { return nextAttachmentId++; }

export interface ComposerScopeState {
  draft: string;
  revision: number;
  textRevision: number;
  attachmentRevision: number;
  attachments: PendingAttachment[];
  error?: ComposerError;
  attachmentProcessing: Promise<void>;
  attachmentProcessingReady: boolean;
  attachmentGeneration: number;
  pendingSubmissions: Map<number, { attachmentIds: ReadonlySet<number>; textRevision: number; attachmentRevision: number; attachmentGeneration: number; draft: string }>;
  submissionBusy: boolean;
}

export type ComposerError =
  | { kind: "attachment"; generation: number; message: string }
  | { kind: "submission"; submissionId: number; message: string };

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
  readonly attachmentProcessing: Promise<void>;
  readonly submissionPending: boolean;
}

export interface ComposerAttachmentSnapshot {
  readonly attachments: readonly PendingAttachment[];
}

export class ComposerScopeStore {
  private readonly states = new Map<ComposerScope, ComposerScopeState>();
  private readonly snapshots = new Map<ComposerScope, ComposerScopeSnapshot>();
  private readonly attachmentSnapshots = new Map<ComposerScope, { source: PendingAttachment[]; snapshot: ComposerAttachmentSnapshot }>();
  private readonly listeners = new Map<ComposerScope, Set<() => void>>();
  private readonly pendingSubmissionPromises = new Map<ComposerScope, Promise<SubmissionHandle>>();
  private readonly activeSubmissionHandles = new Map<ComposerScope, SubmissionHandle>();
  private readonly submissionScopeRefs = new Map<SubmissionHandle | Promise<SubmissionHandle>, { scope: ComposerScope }>();
  private readonly operationScopeRefs = new Set<ComposerScopeReference>();

  private nextSubmissionId = 0;

  ensure(scope: ComposerScope): ComposerScopeState {
    const existing = this.states.get(scope);
    if (existing) return existing;
    const created: ComposerScopeState = {
      draft: "",
      revision: 0,
      textRevision: 0,
      attachmentRevision: 0,
      attachments: [],
      attachmentProcessing: Promise.resolve(),
      attachmentProcessingReady: true,
      attachmentGeneration: 0,
      pendingSubmissions: new Map(),
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

  getAttachmentSnapshot(scope: ComposerScope): ComposerAttachmentSnapshot {
    const state = this.ensure(scope);
    const current = this.attachmentSnapshots.get(scope);
    if (current?.source === state.attachments) return current.snapshot;
    const snapshot = { attachments: state.attachments as readonly PendingAttachment[] };
    this.attachmentSnapshots.set(scope, { source: state.attachments, snapshot });
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

  /** Move a pending draft atomically when a correlated new thread gets an id. */
  moveScope(from: ComposerScope, to: ComposerScope): void {
    if (from === to) return;
    const source = this.states.get(from);
    if (!source) return;
    const destination = this.states.get(to);
    if (!destination || (destination.draft === "" && destination.attachments.length === 0)) {
      this.states.set(to, source);
      this.states.delete(from);
      this.snapshots.delete(from);
      this.snapshots.delete(to);
      this.attachmentSnapshots.delete(from);
      this.attachmentSnapshots.delete(to);
      const pending = this.pendingSubmissionPromises.get(from);
      if (pending) {
        this.pendingSubmissionPromises.delete(from);
        this.pendingSubmissionPromises.set(to, pending);
        const scopeRef = this.submissionScopeRefs.get(pending);
        if (scopeRef) scopeRef.scope = to;
      }
      const active = this.activeSubmissionHandles.get(from);
      if (active) {
        this.activeSubmissionHandles.delete(from);
        this.activeSubmissionHandles.set(to, active);
        const scopeRef = this.submissionScopeRefs.get(active);
        if (scopeRef) scopeRef.scope = to;
      }
      for (const scopeRef of this.operationScopeRefs) if (scopeRef.scope === from) scopeRef.scope = to;
      this.notify(to);
    }
  }

  /**
   * Transfer only editor state while a not-yet-submitted draft changes
   * projects. Submission handles belong to the old semantic scope and must
   * never make a fresh draft appear busy.
   */
  transferDraft(from: ComposerScope, to: ComposerScope): void {
    if (from === to) return;
    const source = this.states.get(from);
    if (!source) return;
    const destination = this.states.get(to);
    if (destination && (destination.draft !== "" || destination.attachments.length > 0)) return;
    const attachmentError = source.error?.kind === "attachment" ? source.error : undefined;
    this.states.set(to, {
      ...source,
      attachments: [...source.attachments],
      error: attachmentError,
      pendingSubmissions: new Map(),
      submissionBusy: false,
    });
    this.states.delete(from);
    this.snapshots.delete(from);
    this.snapshots.delete(to);
    this.attachmentSnapshots.delete(from);
    this.attachmentSnapshots.delete(to);
    for (const scopeRef of this.operationScopeRefs) if (scopeRef.scope === from) scopeRef.scope = to;
    this.notify(to);
  }

  createScopeReference(scope: ComposerScope): ComposerScopeReference {
    const reference = { scope };
    this.operationScopeRefs.add(reference);
    return reference;
  }

  releaseScopeReference(reference: ComposerScopeReference): void {
    this.operationScopeRefs.delete(reference);
  }

  private snapshotFor(state: ComposerScopeState): ComposerScopeSnapshot {
    return {
      draft: state.draft,
      attachments: [...state.attachments],
      error: state.error?.message,
      attachmentProcessing: state.attachmentProcessing,
      submissionPending: state.submissionBusy,
    };
  }

  private notify(scope: ComposerScope): void {
    const state = this.ensure(scope);
    this.snapshots.set(scope, this.snapshotFor(state));
    const attachmentSnapshot = this.attachmentSnapshots.get(scope);
    if (attachmentSnapshot?.source !== state.attachments) this.attachmentSnapshots.delete(scope);
    for (const listener of this.listeners.get(scope) ?? []) listener();
  }

  setDraft(scope: ComposerScope, draft: string): void {
    const state = this.ensure(scope);
    state.draft = draft;
    state.revision += 1;
    state.textRevision += 1;
    this.notify(scope);
  }

  setAttachments(scope: ComposerScope, attachments: PendingAttachment[]): void {
    const state = this.ensure(scope);
    state.attachments = attachments;
    state.revision += 1;
    state.attachmentRevision += 1;
    this.notify(scope);
  }

  addAttachments(scope: ComposerScope, attachments: PendingAttachment[], maxAttachments: number): void {
    const state = this.ensure(scope);
    this.setAttachments(scope, [...state.attachments, ...attachments].slice(0, maxAttachments));
  }

  removeAttachment(scope: ComposerScope, attachmentId: number): void {
    const state = this.ensure(scope);
    this.setAttachments(scope, state.attachments.filter((attachment) => attachment.id !== attachmentId));
  }

  setAttachmentError(scope: ComposerScope, message: string | undefined, generation: number): void {
    const state = this.ensure(scope);
    if (generation !== state.attachmentGeneration) return;
    if (message) {
      state.error = { kind: "attachment", generation, message };
    } else if (state.error?.kind === "attachment" && state.error.generation <= generation) {
      state.error = undefined;
    }
    this.notify(scope);
  }

  setAttachmentProcessing(scope: ComposerScope, processing: Promise<void>): number {
    const state = this.ensure(scope);
    state.attachmentGeneration += 1;
    const generation = state.attachmentGeneration;
    state.attachmentProcessing = processing;
    state.attachmentProcessingReady = false;
    void processing.then(() => {
      if (state.attachmentProcessing === processing) state.attachmentProcessingReady = true;
    }, () => {
      if (state.attachmentProcessing === processing) state.attachmentProcessingReady = true;
    });
    this.notify(scope);
    return generation;
  }

  getAttachmentGeneration(scope: ComposerScope): number {
    return this.ensure(scope).attachmentGeneration;
  }

  beginSubmission(scope: ComposerScope): SubmissionHandle | Promise<SubmissionHandle> | SubmissionBusy {
    const state = this.ensure(scope);
    const active = this.activeSubmissionHandles.get(scope);
    if (active) return { busy: true };
    const existing = this.pendingSubmissionPromises.get(scope);
    if (existing || state.submissionBusy) return { busy: true };
    state.submissionBusy = true;
    this.notify(scope);
    if (!state.attachmentProcessingReady) {
      const scopeRef = { scope };
      const pending = state.attachmentProcessing.then(() => this.createSubmission(scopeRef));
      const owned = pending.catch((error) => {
        if (this.pendingSubmissionPromises.get(scopeRef.scope) === owned) this.pendingSubmissionPromises.delete(scopeRef.scope);
        const current = this.ensure(scopeRef.scope);
        current.submissionBusy = false;
        this.notify(scopeRef.scope);
        throw error;
      });
      this.pendingSubmissionPromises.set(scope, owned);
      this.submissionScopeRefs.set(owned, scopeRef);
      return owned;
    }
    return this.createSubmission({ scope });
  }

  private createSubmission(scopeRef: { scope: ComposerScope }): SubmissionHandle {
    const scope = scopeRef.scope;
    const state = this.ensure(scope);
    const id = this.nextSubmissionId++;
    const textRevision = state.textRevision;
    const attachmentRevision = state.attachmentRevision;
    const attachmentGeneration = state.attachmentGeneration;
    const attachmentIds = new Set(state.attachments.map((attachment) => attachment.id));
    const text = state.draft;
    const attachments = state.attachments.map(({ id: _id, previewUrl: _previewUrl, ...attachment }) => attachment);
    state.pendingSubmissions.set(id, { attachmentIds, textRevision, attachmentRevision, attachmentGeneration, draft: text });
    this.pendingSubmissionPromises.delete(scope);
    // A submitted message leaves the editor immediately. Keep its captured
    // draft on the submission so a rejection can restore it without making a
    // slow host call look like the message is still unsent.
    state.draft = "";
    state.revision += 1;
    // textRevision tracks user edits; leaving it unchanged lets settlement
    // distinguish this lifecycle clear from text entered for the next message.
    this.notify(scope);
    let settled = false;
    const finalize = (result?: SubmissionResult) => {
      try {
        if (result) this.settleSubmission(scopeRef.scope, id, result);
        else this.ensure(scopeRef.scope).pendingSubmissions.delete(id);
      } finally {
        if (this.activeSubmissionHandles.get(scopeRef.scope) === handle) this.activeSubmissionHandles.delete(scopeRef.scope);
        this.submissionScopeRefs.delete(handle);
        const current = this.ensure(scopeRef.scope);
        current.submissionBusy = false;
        this.notify(scopeRef.scope);
      }
    };
    const handle: SubmissionHandle = {
      text,
      attachments,
      settle: (result) => {
        if (settled) return;
        settled = true;
        finalize(result);
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        finalize();
      },
    };
    this.activeSubmissionHandles.set(scope, handle);
    this.submissionScopeRefs.set(handle, scopeRef);
    return handle;
  }

  private settleSubmission(scope: ComposerScope, id: number, result: SubmissionResult): void {
    const state = this.ensure(scope);
    const pending = state.pendingSubmissions.get(id);
    if (!pending) return;
    state.pendingSubmissions.delete(id);
    const sameTextRevision = state.textRevision === pending.textRevision;
    if (result.accepted) {
      if (state.attachmentRevision >= pending.attachmentRevision) {
        state.attachments = state.attachments.filter((attachment) => !pending.attachmentIds.has(attachment.id));
      }
      if (sameTextRevision) state.draft = "";
      const clearsSubmissionError = state.error?.kind === "submission" && state.error.submissionId <= id;
      if (state.error === undefined || clearsSubmissionError) {
        state.error = undefined;
      }
    } else {
      if (sameTextRevision) {
        state.draft = pending.draft;
      } else if (pending.draft && state.draft !== pending.draft && !state.draft.includes(pending.draft)) {
        const separator = pending.draft.endsWith("\n") || state.draft.startsWith("\n") ? "" : "\n\n";
        state.draft = `${pending.draft}${separator}${state.draft}`;
      }
      const newerAttachmentError = state.error?.kind === "attachment"
        && state.error.generation > pending.attachmentGeneration;
      const newerSubmissionError = state.error?.kind === "submission"
        && state.error.submissionId > id;
      if (!newerAttachmentError && !newerSubmissionError) {
        state.error = { kind: "submission", submissionId: id, message: result.message };
      }
    }
    state.revision += 1;
    this.notify(scope);
  }
}
