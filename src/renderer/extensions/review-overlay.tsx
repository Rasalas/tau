import { lazy, Suspense } from "react";
import type { OverlayProps } from "../extension-system";
import { LazyFeatureFallback } from "../components/LazyFeature";
import { workspaceKit } from "./workspace-kit-client";
import { useWorkspaceKit, workspaceStore } from "./workspace-store";

const LazyReview = lazy(() => import("../components/ReviewMode").then(({ ReviewMode }) => ({ default: ReviewMode })));

export const REVIEW_OVERLAY = "review.workspace";

/** Review Kit's full-workbench review of the live worktree, over Workspace Kit's state. */
export function ReviewOverlay({ onClose }: OverlayProps) {
  const state = useWorkspaceKit();
  const review = state.review ?? { primaryPush: false };
  return (
    <Suspense fallback={<LazyFeatureFallback label="review" />}>
      <LazyReview
        changes={state.changes}
        selectedPath={review.path ?? state.changes.files[0]?.path}
        editor={workspaceStore.activeEditor()}
        busy={state.committing}
        primaryPush={review.primaryPush}
        onSelect={(path) => workspaceStore.selectReviewPath(path)}
        onBack={() => { workspaceStore.closeReview(); onClose(); }}
        onCommit={(message, push) => void workspaceStore.commit(message, push)}
        onOpenInEditor={(path) => void workspaceStore.openInEditor(path)}
        workspaceKey={state.cwd}
        loadChanges={window.tau ? (query) => workspaceKit.getChanges(query) : undefined}
        loadDiff={async (path, options) => window.tau
          ? workspaceKit.getFileDiff(path, options)
          : { path, added: 0, removed: 0, hunks: [], note: "Diffs require the Electron host." }}
      />
    </Suspense>
  );
}
