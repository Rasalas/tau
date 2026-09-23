import { createNewThreadRequestId, type NewThreadRequestId } from "../shared/contracts";
import type { ClientStorage } from "./client-storage";
import { draftKey, readNewThreadDraft, writeNewThreadDraft, type NewThreadDraft } from "./draft-store";
import { createDraftKey, type DraftKey } from "./composer-scope-store";

let draftIdentityCounter = 0;
let requestIdentityCounter = 0;
function newDraftIdentity(): string {
  return `${Date.now()}-${++draftIdentityCounter}`;
}

function newRequestIdentity(): NewThreadRequestId {
  return createNewThreadRequestId(`new-thread-${Date.now()}-${++requestIdentityCounter}`);
}

export interface NewThreadPromotionContext {
  pending: NewThreadDraft;
  scope: DraftKey | undefined;
  requestId: NewThreadRequestId;
}

export type NewThreadPendingUpdate = (pending: NewThreadDraft | undefined) => NewThreadDraft | undefined;

/**
 * Owns the pending new-thread draft and its promotion rules. The value moves
 * with the setter, not with rendering: a submission that awaits the host
 * reads what is pending now, not what was last rendered.
 */
export class NewThreadController {
  private pending: NewThreadDraft | undefined;
  private request: NewThreadRequestId;
  private awaitingPromotion: { scope: DraftKey; requestId: NewThreadRequestId } | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly storage: ClientStorage;

  constructor(storage: ClientStorage) {
    this.storage = storage;
    this.pending = readNewThreadDraft(storage);
    this.request = newRequestIdentity();
  }

  current = (): NewThreadDraft | undefined => this.pending;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Accepts a plain value or an update function over the current pending draft. */
  set = (value: NewThreadDraft | undefined | NewThreadPendingUpdate): void => {
    const next = typeof value === "function" ? value(this.pending) : value;
    this.pending = next;
    for (const listener of this.listeners) listener();
  };

  requestId = (): NewThreadRequestId => this.request;

  begin = (draft: NewThreadDraft): void => {
    this.request = newRequestIdentity();
    const scopedDraft = { ...draft, draftId: draft.draftId ?? newDraftIdentity() };
    writeNewThreadDraft(this.storage, scopedDraft);
    this.set(scopedDraft);
  };

  invalidate = (): void => {
    this.request = newRequestIdentity();
    this.awaitingPromotion = undefined;
  };

  isCurrent = (pending: NewThreadDraft, scope: DraftKey | undefined, requestId: NewThreadRequestId): boolean => {
    const pendingDraft = this.pending;
    return this.request === requestId
      && pendingDraft !== undefined
      && draftKey(undefined, pendingDraft) === scope
      && pendingDraft.projectPath === pending.projectPath
      && pendingDraft.sessionId === pending.sessionId;
  };

  markAwaitingPromotion = (context: NewThreadPromotionContext): boolean => {
    if (!this.isCurrent(context.pending, context.scope, context.requestId)) return false;
    this.awaitingPromotion = { scope: createDraftKey(context.scope), requestId: context.requestId };
    return true;
  };

  /**
   * The request id is the authoritative correlation for a host-reported
   * thread. Prompt text is not compared: skill and template expansion can
   * change what the runtime persists.
   */
  promoteFromHostReport = (sessionId: string, projectPath: string, requestId?: NewThreadRequestId): boolean => {
    const pendingDraft = this.pending;
    const awaiting = this.awaitingPromotion;
    if (!pendingDraft || !awaiting || pendingDraft.projectPath !== projectPath || pendingDraft.sessionId) return false;
    if (awaiting.requestId !== this.request
      || awaiting.scope !== createDraftKey(draftKey(undefined, pendingDraft))
      || requestId !== awaiting.requestId) return false;
    this.awaitingPromotion = undefined;
    writeNewThreadDraft(this.storage);
    this.set(undefined);
    return Boolean(sessionId);
  };

  /**
   * A persisted user-message is stronger evidence than a blank lifecycle
   * detail. It can arrive before the newSession IPC response, so promote the
   * draft from that correlated event without waiting for catalog discovery.
   */
  promoteFromUserMessage = (sessionId: string, projectPath: string): DraftKey | undefined => {
    const pendingDraft = this.pending;
    if (!sessionId || !pendingDraft || pendingDraft.sessionId || pendingDraft.projectPath !== projectPath) return undefined;
    const scope = draftKey(undefined, pendingDraft);
    if (!scope) return undefined;
    this.awaitingPromotion = undefined;
    writeNewThreadDraft(this.storage);
    this.set(undefined);
    return scope;
  };

  /** A draft keeps the model for the thread it becomes; `runtime` is the one it was chosen from. */
  setModel = async (
    provider: string,
    id: string,
    fallbackSetModel?: (p: string, id: string) => Promise<unknown>,
    resolveName?: (p: string, id: string) => string | undefined,
    runtime?: string,
  ): Promise<void> => {
    const pending = this.pending;
    if (!pending || pending.sessionId) {
      if (fallbackSetModel) await fallbackSetModel(provider, id);
      return;
    }
    const name = resolveName?.(provider, id) ?? id;
    // A level chosen for another model or runtime may not exist for this one.
    this.store({ ...withoutSelection(pending), model: { provider, id, name }, ...selectionRuntime(runtime) });
  };

  /** A draft keeps the thinking level for the thread it becomes. */
  setThinking = async (level: string, fallbackSetThinking?: (level: string) => Promise<unknown>, runtime?: string): Promise<void> => {
    const pending = this.pending;
    if (!pending || pending.sessionId) {
      if (fallbackSetThinking) await fallbackSetThinking(level);
      return;
    }
    const model = (pending.selectionRuntime ?? "pi") === (runtime ?? "pi") ? pending.model : undefined;
    this.store({ ...withoutSelection(pending), ...(model ? { model } : {}), thinkingLevel: level, ...selectionRuntime(runtime) });
  };

  private store(next: NewThreadDraft): void {
    writeNewThreadDraft(this.storage, next);
    this.set(next);
  }
}

function selectionRuntime(runtime: string | undefined): { selectionRuntime?: string } {
  return runtime && runtime !== "pi" ? { selectionRuntime: runtime } : {};
}

function withoutSelection(pending: NewThreadDraft): NewThreadDraft {
  const { model: _model, thinkingLevel: _level, selectionRuntime: _runtime, ...rest } = pending;
  return rest;
}
