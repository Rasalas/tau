import { useEffect } from "react";
import type { RowRequests } from "./requests.js";
import type { ThreadLinkRows } from "./thread-links-store.js";

/** Refresh the active checkout and its thread's links while their PR context is displayed. */
export function useRequestLifecycle(rows: RowRequests, links: ThreadLinkRows, workspace?: string, threadId?: string): void {
  useEffect(() => {
    const stopWorkspace = workspace ? rows.watch(workspace) : undefined;
    const stopThread = threadId ? links.watch(threadId) : undefined;
    return () => { stopWorkspace?.(); stopThread?.(); };
  }, [rows, links, workspace, threadId]);
}
