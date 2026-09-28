import { useEffect } from "react";
import type { RegionProps } from "tau";
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
  useEffect(() => {
    workspaceStore.follow({ cwd, workspaceId, sessionId, draftPending });
  }, [cwd, workspaceId, sessionId, draftPending, workspaceStore]);
  useEffect(() => { void workspaceStore.loadEditors(); void workspaceStore.loadTerminals(); }, [workspaceStore]);
  return null;
}
