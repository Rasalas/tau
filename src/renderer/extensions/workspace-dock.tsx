import { useEffect, useMemo } from "react";
import { useSyncExternalStore } from "react";
import type { ComposerControlProps, RegionProps } from "../extension-system";
import { useWorkbench } from "../workbench-context";
import { ChangedFiles } from "../components/ChangedFiles";
import { WorkspaceBar } from "../components/WorkspaceBar";
import { workspaceKit } from "./workspace-kit-client";
import { useWorkspaceKit, workspaceStore } from "./workspace-store";

/**
 * Keeps the kit's store following the workbench: which project, which thread,
 * whether a draft is still pending. Renders nothing; lives in an always-mounted region.
 */
export function WorkspaceFollower({ actions }: RegionProps) {
  const thread = actions.activeThread();
  const cwd = thread?.cwd;
  const sessionId = thread?.sessionId;
  const draftPending = thread?.draftPending ?? false;
  useEffect(() => {
    workspaceStore.bind(actions);
  }, [actions]);
  useEffect(() => {
    workspaceStore.follow({ cwd, sessionId, draftPending });
  }, [cwd, sessionId, draftPending]);
  useEffect(() => { void workspaceStore.loadEditors(); }, []);
  return null;
}

/** The files a running turn touched, shown under the transcript until a checkpoint replaces it. */
export function TurnChangesDock() {
  const state = useWorkspaceKit();
  const { tools } = useWorkbench();
  const turnChanges = useMemo(() => workspaceStore.turnChanges(tools), [state.changes, state.turnBaseline, tools]);
  if (state.draftPending || state.turnSettled || turnChanges.files.length === 0) return null;
  return (
    <div className="conversation-files-dock">
      <ChangedFiles changes={turnChanges} onOpenDiff={(path) => workspaceStore.openReview(path)} />
    </div>
  );
}

/** Worktree and branch switching, below the composer. */
export function WorkspaceBarControl(_props: ComposerControlProps) {
  const state = useSyncExternalStore(workspaceStore.subscribe, workspaceStore.getSnapshot, workspaceStore.getSnapshot);
  return (
    <WorkspaceBar
      info={state.workspace}
      busy={state.workspaceBusy}
      onOpenWorktree={(path) => workspaceStore.openWorktree(path)}
      onCreateWorktree={(branch, baseRef) => workspaceStore.createWorktree(branch, baseRef)}
      onSwitchRef={(ref) => workspaceStore.switchRef(ref)}
      onLoadWorktreeStatuses={() => workspaceKit.getWorktreeStatuses(state.cwd)}
    />
  );
}
