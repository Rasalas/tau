import { useCallback, useSyncExternalStore } from "react";
import type { UiSession } from "../shared/contracts";
import { useThreadStore } from "./workbench-context";

/** One thread's index entry. Re-renders only when that entry changes, not the whole index. */
export function useThreadShell(sessionId: string): UiSession | undefined {
  const store = useThreadStore();
  return useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribeToThread(sessionId, listener), [sessionId, store]),
    useCallback(() => store.getThread(sessionId), [sessionId, store]),
  );
}
