import { useCallback, useRef, useState } from "react";
import { createNewThreadRequestId, type NewThreadRequestId } from "../shared/contracts";
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
  prompt: string;
}

export function useNewThreadController(storage: Storage) {
  const [pendingNewThread, setPendingNewThread] = useState<NewThreadDraft | undefined>(() => readNewThreadDraft(storage));
  const pendingRef = useRef(pendingNewThread);
  pendingRef.current = pendingNewThread;
  const requestRef = useRef<NewThreadRequestId>(newRequestIdentity());
  const awaitingPromotionRef = useRef<{ scope: DraftKey; requestId: NewThreadRequestId; prompt: string } | undefined>(undefined);

  const begin = useCallback((draft: NewThreadDraft) => {
    requestRef.current = newRequestIdentity();
    const scopedDraft = { ...draft, draftId: draft.draftId ?? newDraftIdentity() };
    writeNewThreadDraft(storage, scopedDraft);
    setPendingNewThread(scopedDraft);
  }, [storage]);

  const invalidate = useCallback(() => {
    requestRef.current = newRequestIdentity();
    awaitingPromotionRef.current = undefined;
  }, []);

  const isCurrent = useCallback((pending: NewThreadDraft, scope: DraftKey | undefined, requestId: NewThreadRequestId): boolean => {
    const current = pendingRef.current;
    return requestRef.current === requestId
      && current !== undefined
      && draftKey(undefined, current) === scope
      && current.projectPath === pending.projectPath
      && current.sessionId === pending.sessionId;
  }, []);

  const markAwaitingPromotion = useCallback((context: NewThreadPromotionContext) => {
    if (!isCurrent(context.pending, context.scope, context.requestId)) return false;
    awaitingPromotionRef.current = { scope: createDraftKey(context.scope), requestId: context.requestId, prompt: context.prompt };
    return true;
  }, [isCurrent]);

  const promoteFromHostReport = useCallback((sessionId: string, projectPath: string, prompt: string, requestId?: NewThreadRequestId): boolean => {
    const current = pendingRef.current;
    const awaiting = awaitingPromotionRef.current;
    if (!current || !awaiting || current.projectPath !== projectPath || current.sessionId) return false;
    if (awaiting.requestId !== requestRef.current
      || awaiting.scope !== createDraftKey(draftKey(undefined, current))
      || prompt !== awaiting.prompt
      || requestId !== awaiting.requestId) return false;
    awaitingPromotionRef.current = undefined;
    writeNewThreadDraft(storage);
    setPendingNewThread(undefined);
    return Boolean(sessionId);
  }, [storage]);

  return {
    pendingNewThread,
    setPendingNewThread,
    requestId: requestRef,
    begin,
    invalidate,
    isCurrent,
    markAwaitingPromotion,
    promoteFromHostReport,
  };
}
