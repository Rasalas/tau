import { useEffect } from "react";
import { useSyncExternalStore } from "react";
import type { ComposerControlProps, RegionProps } from "tau";
import { WorkspaceBar } from "./WorkspaceBar.js";
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

/** Worktree and branch for a thread that has not started, below the composer. */
export function WorkspaceBarControl({ snapshot }: ComposerControlProps) {
  const workspaceStore = useWorkspaceStore();
  const state = useSyncExternalStore(workspaceStore.subscribe, workspaceStore.getSnapshot, workspaceStore.getSnapshot);
  // Once a thread has a conversation its head names the branch; only one that has none still chooses where it runs.
  if (!state.draftPending && (snapshot?.messages.length ?? 0) > 0) return null;
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
