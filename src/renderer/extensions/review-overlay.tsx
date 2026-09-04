import { lazy, Suspense, useCallback } from "react";
import type { OverlayProps } from "../extension-system";
import { LazyFeatureFallback } from "../components/LazyFeature";
import { useHostClient } from "../host-client-context";
import { usePreferences, useWorkspaceStore } from "../renderer-services-context";
import { workspaceKit } from "./workspace-kit-client";
import { automaticCommitMessages } from "./commit-messages";
import type { DiffLoadOptions, UiFileDiff, UiWorkspaceChanges, WorkspaceChangesQuery } from "../../shared/workspace-kit-types";
import { useWorkspaceKit } from "./workspace-store";

const LazyReview = lazy(() => import("../components/ReviewMode").then(({ ReviewMode }) => ({ default: ReviewMode })));

export const REVIEW_OVERLAY = "review.workspace";

/** Review Kit's full-workbench review of the live worktree, over Workspace Kit's state. */
export function ReviewOverlay({ onClose }: OverlayProps) {
  const client = useHostClient();
  const preferences = usePreferences();
  const workspaceStore = useWorkspaceStore();
  const state = useWorkspaceKit();
  const review = state.review ?? { primaryPush: false };
  const selectPath = useCallback((path: string) => workspaceStore.selectReviewPath(path), [workspaceStore]);
  const closeReview = useCallback(() => {
    workspaceStore.closeReview();
    onClose();
  }, [onClose, workspaceStore]);
  const commit = useCallback((message: string, push: boolean) => void workspaceStore.commit(message, push), [workspaceStore]);
  const openInEditor = useCallback((path: string) => void workspaceStore.openInEditor(path), [workspaceStore]);
  const suggestCommitMessage = useCallback(
    (changes: UiWorkspaceChanges, diffs: readonly UiFileDiff[]) => workspaceStore.suggestCommitMessage(changes, diffs),
    [workspaceStore],
  );
  const loadChanges = useCallback((query?: WorkspaceChangesQuery) => workspaceKit.getChanges(query), []);
  const loadDiff = useCallback(async (path: string, options?: DiffLoadOptions) => client
    ? workspaceKit.getFileDiff(path, options)
    : { path, added: 0, removed: 0, hunks: [], note: "Diffs require the Electron host." }, [client]);
  return (
    <Suspense fallback={<LazyFeatureFallback label="review" />}>
      <LazyReview
        changes={state.changes}
        selectedPath={review.path ?? state.changes.files[0]?.path}
        editor={workspaceStore.activeEditor()}
        busy={state.committing}
        primaryPush={review.primaryPush}
        onSelect={selectPath}
        onBack={closeReview}
        onCommit={commit}
        onOpenInEditor={openInEditor}
        workspaceKey={state.cwd}
        autoSuggestCommitMessage={automaticCommitMessages(preferences)}
        suggestCommitMessage={suggestCommitMessage}
        loadChanges={client ? loadChanges : undefined}
        loadDiff={loadDiff}
      />
    </Suspense>
  );
}
