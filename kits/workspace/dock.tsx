import { useEffect, useSyncExternalStore } from "react";
import { useThreadStore, type RegionProps } from "tau";
import { useWorkspaceStore } from "./store-context.js";

/**
 * Keeps the kit's store following the workbench: which project, which thread,
 * whether a draft is still pending. Renders nothing; lives in an always-mounted region.
 */
export function WorkspaceFollower({ actions }: RegionProps) {
  const workspaceStore = useWorkspaceStore();
  const thread = actions.activeThread();
  const cwd = thread?.cwd;
  const workspaceId = thread?.workspaceId;
  const sessionId = thread?.sessionId;
  const draftPending = thread?.draftPending ?? false;
  useEffect(() => {
    workspaceStore.bind(actions);
  }, [actions, workspaceStore]);
  const threadStore = useThreadStore();
  // Another thread's turn in the draft's folder; a thread in a worktree has a folder of its own.
  const busyCheckout = useSyncExternalStore(threadStore.subscribe, () => draftPending && threadStore.getActivity().runningThreadIds.some((id) => {
    const other = id === sessionId ? undefined : threadStore.getThread(id);
    if (!other) return false;
    return other.workspaceId && workspaceId ? other.workspaceId === workspaceId : other.projectPath === cwd;
  }));
  // Before `follow`, which evaluates the suggestion for a draft that just opened.
  useEffect(() => { workspaceStore.followBusyCheckout(busyCheckout); }, [busyCheckout, workspaceStore]);
  useEffect(() => {
    workspaceStore.follow({ cwd, workspaceId, sessionId, draftPending });
  }, [cwd, workspaceId, sessionId, draftPending, workspaceStore]);
  useEffect(() => { void workspaceStore.loadEditors(); void workspaceStore.loadTerminals(); }, [workspaceStore]);
  return null;
}
