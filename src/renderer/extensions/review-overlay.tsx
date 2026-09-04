import { lazy, Suspense, useCallback } from "react";
import type { OverlayProps } from "../extension-system";
import { LazyFeatureFallback } from "../components/LazyFeature";
import { workspaceKit } from "./workspace-kit-client";
import { automaticCommitMessages } from "./commit-messages";
import type { DiffLoadOptions, UiFileDiff, UiWorkspaceChanges, WorkspaceChangesQuery } from "../../shared/workspace-kit-types";
import { useWorkspaceKit, workspaceStore } from "./workspace-store";

const LazyReview = lazy(() => import("../components/ReviewMode").then(({ ReviewMode }) => ({ default: ReviewMode })));

export const REVIEW_OVERLAY = "review.workspace";

/** Review Kit's full-workbench review of the live worktree, over Workspace Kit's state. */
export function ReviewOverlay({ onClose }: OverlayProps) {
  const state = useWorkspaceKit();
  const review = state.review ?? { primaryPush: false };
  const selectPath = useCallback((path: string) => workspaceStore.selectReviewPath(path), []);
  const closeReview = useCallback(() => {
    workspaceStore.closeReview();
    onClose();
  }, [onClose]);
  const commit = useCallback((message: string, push: boolean) => void workspaceStore.commit(message, push), []);
  const openInEditor = useCallback((path: string) => void workspaceStore.openInEditor(path), []);
  const suggestCommitMessage = useCallback(
    (changes: UiWorkspaceChanges, diffs: readonly UiFileDiff[]) => workspaceStore.suggestCommitMessage(changes, diffs),
    [],
  );
  const loadChanges = useCallback((query?: WorkspaceChangesQuery) => workspaceKit.getChanges(query), []);
  const loadDiff = useCallback(async (path: string, options?: DiffLoadOptions) => window.tau
    ? workspaceKit.getFileDiff(path, options)
    : { path, added: 0, removed: 0, hunks: [], note: "Diffs require the Electron host." }, []);
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
        autoSuggestCommitMessage={automaticCommitMessages()}
        suggestCommitMessage={suggestCommitMessage}
        loadChanges={window.tau ? loadChanges : undefined}
        loadDiff={loadDiff}
      />
    </Suspense>
  );
}
