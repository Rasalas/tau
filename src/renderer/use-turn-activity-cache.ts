import { useEffect } from "react";
import type { ClientStorage } from "../workbench/client-storage";
import type { ThreadStore } from "../workbench/thread-store";
import type { ThreadViewStore } from "../workbench/thread-view-store";
import { followTurnActivity } from "../workbench/turn-activity";

export function useTurnActivityCache(source: ThreadViewStore, storage: ClientStorage, threads: ThreadStore): void {
  useEffect(() => followTurnActivity(source, storage, (flush) => {
    let running = threads.getActivity().runningThreadIds;
    let stopped = false;
    const persist = () => { source.flushToolOutput(); flush(); };
    const stopRuns = threads.subscribeToActivity(() => {
      const next = threads.getActivity().runningThreadIds;
      // Run state arrives before the view flushes its final tool output.
      const sessionId = source.getSnapshot()?.sessionId;
      if (sessionId && running.includes(sessionId) && !next.includes(sessionId)) {
        queueMicrotask(() => { if (!stopped) persist(); });
      }
      running = next;
    });
    const hide = () => { if (document.visibilityState === "hidden") persist(); };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", persist);
    return () => {
      stopped = true;
      stopRuns();
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", persist);
      persist();
    };
  }), [source, storage, threads]);
}
