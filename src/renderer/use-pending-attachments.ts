import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { ComposerAttachmentHandle } from "./components/useComposerAttachments";

/** Files for a thread that did not come on screen by then are dropped, not attached later by surprise. */
export const PENDING_ATTACHMENT_MS = 10_000;

/**
 * `actions.attachFiles`: files go to the composer the way a drop on the
 * thread puts them there. Named for a thread, they wait until that thread's
 * composer is the mounted one, so a kit can open a thread and hand it files.
 */
export function usePendingAttachments(attachmentRef: RefObject<ComposerAttachmentHandle | null>, activeSessionId: string | undefined, now: () => number = Date.now) {
  const pending = useRef<{ files: File[]; sessionId?: string; at: number } | undefined>(undefined);
  const active = useRef(activeSessionId);
  active.current = activeSessionId;

  const flush = useCallback(() => {
    const next = pending.current;
    if (!next) return;
    if (now() - next.at > PENDING_ATTACHMENT_MS) { pending.current = undefined; return; }
    if (next.sessionId !== undefined && next.sessionId !== active.current) return;
    pending.current = undefined;
    void attachmentRef.current?.addFiles(next.files);
  }, [attachmentRef, now]);

  // After the commit that mounted the thread's composer, its handle is the new one.
  useEffect(flush, [activeSessionId, flush]);

  return useCallback((files: readonly File[], options?: { sessionId?: string }) => {
    if (files.length === 0) return;
    pending.current = { files: [...files], at: now(), ...(options?.sessionId ? { sessionId: options.sessionId } : {}) };
    flush();
  }, [flush, now]);
}
