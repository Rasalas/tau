import { useCallback, useRef, useState } from "react";
import { draftKey, readNewThreadDraft, writeNewThreadDraft, type NewThreadDraft } from "./draft-store";

export function useNewThreadController(storage: Storage) {
  const [pendingNewThread, setPendingNewThread] = useState<NewThreadDraft | undefined>(() => readNewThreadDraft(storage));
  const pendingRef = useRef(pendingNewThread);
  pendingRef.current = pendingNewThread;
  const requestRef = useRef(0);

  const begin = useCallback((draft: NewThreadDraft) => {
    requestRef.current += 1;
    writeNewThreadDraft(storage, draft);
    setPendingNewThread(draft);
  }, [storage]);

  const invalidate = useCallback(() => {
    requestRef.current += 1;
  }, []);

  const isCurrent = useCallback((pending: NewThreadDraft, scope: string | undefined, requestId: number): boolean => {
    const current = pendingRef.current;
    return requestRef.current === requestId
      && current !== undefined
      && draftKey(undefined, current) === scope
      && current.projectPath === pending.projectPath
      && current.sessionId === pending.sessionId;
  }, []);

  return {
    pendingNewThread,
    setPendingNewThread,
    requestId: requestRef,
    begin,
    invalidate,
    isCurrent,
  };
}
