import { useCallback, useSyncExternalStore } from "react";
import type { ThreadStore } from "../workbench/thread-store";
import type { UiSession } from "../shared/contracts";
import { useThreadStore } from "./workbench-context";

/** One thread's index entry. Re-renders only when that entry changes, not the whole index. */
export function useThreadShell(sessionId: string): UiSession | undefined {
  return useThreadEntry(useThreadStore(), sessionId);
}

/** Also usable by App before it installs the workbench context. */
export function useThreadEntry(store: ThreadStore, sessionId: string): UiSession | undefined {
  return useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribeToThread(sessionId, listener), [sessionId, store]),
    useCallback(() => store.getThread(sessionId), [sessionId, store]),
  );
}
