import { useCallback, useRef, useState, type SetStateAction } from "react";
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

export function useNewThreadController(storage: ClientStorage) {
  const [pendingNewThread, setPendingState] = useState<NewThreadDraft | undefined>(() => readNewThreadDraft(storage));
  const pendingRef = useRef(pendingNewThread);
  // The ref moves with the setter, not with rendering: a submission that
  // awaits the host reads what is pending now, not what was last rendered.
  const setPendingNewThread = useCallback((value: SetStateAction<NewThreadDraft | undefined>) => {
    pendingRef.current = typeof value === "function" ? value(pendingRef.current) : value;
    setPendingState(pendingRef.current);
  }, []);
  const current = useCallback(() => pendingRef.current, []);
  const requestRef = useRef<NewThreadRequestId>(newRequestIdentity());
  const awaitingPromotionRef = useRef<{ scope: DraftKey; requestId: NewThreadRequestId } | undefined>(undefined);

  const begin = useCallback((draft: NewThreadDraft) => {
    requestRef.current = newRequestIdentity();
    const scopedDraft = { ...draft, draftId: draft.draftId ?? newDraftIdentity() };
    writeNewThreadDraft(storage, scopedDraft);
    setPendingNewThread(scopedDraft);
  }, [setPendingNewThread, storage]);

  const invalidate = useCallback(() => {
    requestRef.current = newRequestIdentity();
    awaitingPromotionRef.current = undefined;
  }, []);

  const isCurrent = useCallback((pending: NewThreadDraft, scope: DraftKey | undefined, requestId: NewThreadRequestId): boolean => {
    const pendingDraft = pendingRef.current;
    return requestRef.current === requestId
      && pendingDraft !== undefined
      && draftKey(undefined, pendingDraft) === scope
      && pendingDraft.projectPath === pending.projectPath
      && pendingDraft.sessionId === pending.sessionId;
  }, []);

  const markAwaitingPromotion = useCallback((context: NewThreadPromotionContext) => {
    if (!isCurrent(context.pending, context.scope, context.requestId)) return false;
    awaitingPromotionRef.current = { scope: createDraftKey(context.scope), requestId: context.requestId };
    return true;
  }, [isCurrent]);

  /**
   * The request id is the authoritative correlation for a host-reported
   * thread. Prompt text is not compared: skill and template expansion can
   * change what the runtime persists.
   */
  const promoteFromHostReport = useCallback((sessionId: string, projectPath: string, requestId?: NewThreadRequestId): boolean => {
    const pendingDraft = pendingRef.current;
    const awaiting = awaitingPromotionRef.current;
    if (!pendingDraft || !awaiting || pendingDraft.projectPath !== projectPath || pendingDraft.sessionId) return false;
    if (awaiting.requestId !== requestRef.current
      || awaiting.scope !== createDraftKey(draftKey(undefined, pendingDraft))
      || requestId !== awaiting.requestId) return false;
    awaitingPromotionRef.current = undefined;
    writeNewThreadDraft(storage);
    setPendingNewThread(undefined);
    return Boolean(sessionId);
  }, [setPendingNewThread, storage]);

  /**
   * A persisted user-message is stronger evidence than a blank lifecycle
   * detail. It can arrive before the newSession IPC response, so promote the
   * draft from that correlated event without waiting for catalog discovery.
   */
  const promoteFromUserMessage = useCallback((sessionId: string, projectPath: string): DraftKey | undefined => {
    const pendingDraft = pendingRef.current;
    if (!sessionId || !pendingDraft || pendingDraft.sessionId || pendingDraft.projectPath !== projectPath) return undefined;
    const scope = draftKey(undefined, pendingDraft);
    if (!scope) return undefined;
    awaitingPromotionRef.current = undefined;
    writeNewThreadDraft(storage);
    setPendingNewThread(undefined);
    return scope;
  }, [setPendingNewThread, storage]);

  return {
    pendingNewThread,
    setPendingNewThread,
    current,
    requestId: requestRef,
    begin,
    invalidate,
    isCurrent,
    markAwaitingPromotion,
    promoteFromHostReport,
    promoteFromUserMessage,
  };
}
