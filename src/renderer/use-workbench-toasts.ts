import { useEffect, useRef } from "react";
import type { ThreadViewStore } from "../workbench/thread-view-store";
import type { ToastStore } from "../workbench/toast-store";
import { noticeHeadline } from "./components/notice-text";

/** Every notice as a toast: the headline to read, the whole text to copy when it failed or was cut short. */
export function showNoticesAsToasts(view: ThreadViewStore, toasts: ToastStore): () => void {
  return view.subscribeToNotice(() => {
    const notice = view.getNotice();
    if (!notice) return;
    const headline = noticeHeadline(notice.message);
    toasts.show({
      // The same text again restarts its toast rather than stacking a copy.
      id: `notice:${notice.message}`,
      type: notice.level,
      description: headline,
      ...(notice.level !== "info" || headline !== notice.message.trim() ? { copyText: notice.message } : {}),
    });
  });
}

/** Core's own toasts: the notices, and the restart a downloaded update waits for; closed, the sidebar's foot still offers it. */
export function useWorkbenchToasts({ view, toasts, updateReady, onRestart }: {
  view: ThreadViewStore;
  toasts: ToastStore;
  updateReady?: string;
  onRestart(): void;
}): void {
  useEffect(() => showNoticesAsToasts(view, toasts), [toasts, view]);
  const handlers = useRef({ onRestart });
  handlers.current = { onRestart };
  useEffect(() => {
    if (!updateReady) return;
    toasts.show({
      id: "tau.update",
      title: `Tau ${updateReady} downloaded`,
      description: "Restart to install it.",
      timeoutMs: 0,
      actions: [{ label: "Restart", run: () => handlers.current.onRestart() }],
    });
  }, [toasts, updateReady]);
}
