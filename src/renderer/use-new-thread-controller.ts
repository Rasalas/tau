import { useCallback, useRef, useState } from "react";
import { draftKey, readNewThreadDraft, writeNewThreadDraft, type NewThreadDraft } from "./draft-store";
import { createDraftKey, type DraftKey } from "./composer-scope-store";

export function useNewThreadController(storage: Storage) {
  const [pendingNewThread, setPendingNewThread] = useState<NewThreadDraft | undefined>(() => readNewThreadDraft(storage));
  const pendingRef = useRef(pendingNewThread);
  pendingRef.current = pendingNewThread;
  const requestRef = useRef(0);
  const awaitingPromotionRef = useRef<{ scope: DraftKey; requestId: number } | undefined>(undefined);

  const begin = useCallback((draft: NewThreadDraft) => {
    requestRef.current += 1;
    writeNewThreadDraft(storage, draft);
    setPendingNewThread(draft);
  }, [storage]);

  const invalidate = useCallback(() => {
    requestRef.current += 1;
    awaitingPromotionRef.current = undefined;
  }, []);

  const isCurrent = useCallback((pending: NewThreadDraft, scope: string | undefined, requestId: number): boolean => {
    const current = pendingRef.current;
    return requestRef.current === requestId
      && current !== undefined
      && draftKey(undefined, current) === scope
      && current.projectPath === pending.projectPath
      && current.sessionId === pending.sessionId;
  }, []);

  const markAwaitingPromotion = useCallback((pending: NewThreadDraft, scope: string | undefined, requestId: number) => {
    if (!isCurrent(pending, scope, requestId)) return false;
    awaitingPromotionRef.current = { scope: createDraftKey(scope), requestId };
    return true;
  }, [isCurrent]);

  const promoteFromHostReport = useCallback((sessionId: string, projectPath: string): boolean => {
    const current = pendingRef.current;
    const awaiting = awaitingPromotionRef.current;
    if (!current || !awaiting || current.projectPath !== projectPath || current.sessionId) return false;
    if (awaiting.requestId !== requestRef.current || awaiting.scope !== createDraftKey(draftKey(undefined, current))) return false;
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
