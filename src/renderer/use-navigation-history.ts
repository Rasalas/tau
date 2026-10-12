import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadStore } from "../workbench/thread-store";
import { NavigationHistory, type NavigationEntry } from "../workbench/navigation-history";
import type { OpenConversationView } from "./use-app-overlays";

/** Back and forward over the threads and conversation views this window showed (T3 Code's ⌘[ and ⌘]). */
export function useNavigationHistory({ threadId, view, threads, switchSession, showView }: {
  /** The thread on screen; a draft has none. */
  threadId: string | undefined;
  view: OpenConversationView | undefined;
  /** Without them the history is kept but never stepped. */
  threads: Pick<ThreadStore, "getSnapshot"> | undefined;
  switchSession: ((path: string) => Promise<boolean>) | undefined;
  showView(view: OpenConversationView | undefined): void;
}) {
  const [history] = useState(() => new NavigationHistory());
  const here: NavigationEntry | undefined = threadId ? { threadId, ...(view ? { view: { id: view.id, params: view.params } } : {}) } : undefined;
  const hereRef = useRef(here);
  hereRef.current = here;
  // The screen passes through other states while a step switches threads; those are not visits.
  const stepping = useRef(false);
  useEffect(() => {
    if (!stepping.current && hereRef.current) history.visit(hereRef.current);
  }, [history, threadId, view]);

  return useCallback(async (direction: -1 | 1): Promise<boolean> => {
    if (stepping.current || !threads || !switchSession) return false;
    const from = hereRef.current;
    const pathOf = (id: string) => threads.getSnapshot().threads.find((thread) => thread.id === id)?.path;
    const target = history.step(direction, from, (id) => id === from?.threadId || Boolean(pathOf(id)));
    if (!target) return false;
    const shown = target.view ? { sessionId: target.threadId, ...target.view } : undefined;
    if (target.threadId === from?.threadId) {
      showView(shown);
      return true;
    }
    stepping.current = true;
    showView(shown);
    try {
      return await switchSession(pathOf(target.threadId)!);
    } finally {
      stepping.current = false;
    }
  }, [history, showView, switchSession, threads]);
}
