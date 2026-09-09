import { useCallback, useSyncExternalStore } from "react";
import {
  HostUnavailableError,
  ReviewMode,
  type DesktopExtensionContext,
  type DiffLoadOptions,
  type OverlayProps,
  type UiFileDiff,
  type UiWorkspaceChanges,
  type WorkspaceChangesQuery,
} from "tau";
import { automaticCommitMessages } from "./commit-messages.js";
import type { WorkspaceStoreApi } from "./protocol.js";
import type { WorkspaceChangesReader } from "./workspace.js";

/** Review Kit's full-workbench review of the live worktree, over Workspace Kit's state. */
export function createReviewOverlay(plugin: DesktopExtensionContext, workspace: WorkspaceChangesReader, store: WorkspaceStoreApi) {
  return function ReviewOverlay({ onClose }: OverlayProps) {
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const review = state.review ?? { primaryPush: false };
    const selectPath = useCallback((path: string) => store.selectReviewPath(path), []);
    const closeReview = useCallback(() => { store.closeReview(); onClose(); }, [onClose]);
    const commit = useCallback(async (message: string, push: boolean) => {
      if (await store.commit(message, push)) closeReview();
    }, [closeReview]);
    const openInEditor = useCallback((path: string) => void store.openInEditor(path), []);
    const suggestCommitMessage = useCallback(
      (changes: UiWorkspaceChanges, diffs: readonly UiFileDiff[]) => store.suggestCommitMessage(changes, diffs),
      [],
    );
    const loadChanges = useCallback((query?: WorkspaceChangesQuery) => workspace.changes(query), []);
    // A client without an Electron host has no worktree to diff; say so in the
    // one place the answer is read instead of failing the whole view.
    const loadDiff = useCallback(async (path: string, options?: DiffLoadOptions): Promise<UiFileDiff> => {
      try {
        return await workspace.fileDiff(path, options);
      } catch (error) {
        if (!(error instanceof HostUnavailableError)) throw error;
        return { path, added: 0, removed: 0, hunks: [], note: "Diffs require the Electron host." };
      }
    }, []);
    return (
      <ReviewMode
        changes={state.changes}
        selectedPath={review.path ?? state.changes.files[0]?.path}
        editor={store.activeEditor()}
        busy={state.committing}
        primaryPush={review.primaryPush}
        onSelect={selectPath}
        onBack={closeReview}
        onCommit={commit}
        onOpenInEditor={openInEditor}
        workspaceKey={state.workspaceId ?? state.cwd}
        autoSuggestCommitMessage={automaticCommitMessages(plugin.preferences)}
        suggestCommitMessage={suggestCommitMessage}
        loadChanges={loadChanges}
        loadDiff={loadDiff}
      />
    );
  };
}
