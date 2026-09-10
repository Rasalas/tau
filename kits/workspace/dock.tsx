import { useEffect, useMemo } from "react";
import { useSyncExternalStore } from "react";
import { useWorkbench, type ComposerControlProps, type RegionProps } from "tau";
import { ChangedFiles } from "./ChangedFiles.js";
import { WorkspaceBar } from "./WorkspaceBar.js";
import { useWorkspaceKit, useWorkspaceStore } from "./store-context.js";

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
  useEffect(() => { void workspaceStore.loadEditors(); }, [workspaceStore]);
  return null;
}

/**
 * The files the running turn touched, shown under the transcript as its live
 * preview. A finished turn belongs to its checkpoint card in the transcript,
 * so the dock is bound to the turn actually running and nothing else: an idle
 * thread must not draw a stale baseline diff next to the card that replaces it.
 */
export function TurnChangesDock() {
  const workspaceStore = useWorkspaceStore();
  const state = useWorkspaceKit();
  const { tools, snapshot } = useWorkbench();
  const turnChanges = useMemo(() => workspaceStore.turnChanges(tools), [state.changes, state.turnBaseline, tools, workspaceStore]);
  if (state.draftPending || state.turnSettled || !snapshot?.isStreaming || turnChanges.files.length === 0) return null;
  return (
    <div className="conversation-files-dock">
      <ChangedFiles changes={turnChanges} onOpenDiff={(path) => workspaceStore.openReview(path)} />
    </div>
  );
}

/** Worktree and branch switching, below the composer. */
export function WorkspaceBarControl(_props: ComposerControlProps) {
  const workspaceStore = useWorkspaceStore();
  const state = useSyncExternalStore(workspaceStore.subscribe, workspaceStore.getSnapshot, workspaceStore.getSnapshot);
  return (
    <WorkspaceBar
      info={state.workspace}
      busy={state.workspaceBusy}
      {...(state.draftPending ? { mode: state.workspaceMode, onModeChange: (mode) => workspaceStore.setWorkspaceMode(mode) } : {})}
      base={state.worktreeBase}
      onOpenWorktree={(path) => workspaceStore.openWorktree(path)}
      onCreateWorktree={(branch, baseRef) => workspaceStore.createWorktree(branch, baseRef)}
      onSwitchRef={(ref) => workspaceStore.switchRef(ref)}
      onLoadWorktreeStatuses={async () => {
        // One opening of the picker: the statuses and the base it offers.
        void workspaceStore.loadWorktreeBase();
        return workspaceStore.host.getWorktreeStatuses(state.cwd);
      }}
      onSuggestName={state.canNameWorktrees ? (hint) => workspaceStore.suggestWorktreeName(hint) : undefined}
      onPreviewRemoval={(tree) => workspaceStore.host.getWorktreeRemoval(tree.path, state.cwd)}
      onRemoveWorktree={(tree) => workspaceStore.removeWorktree(tree.path, tree.branch)}
    />
  );
}
