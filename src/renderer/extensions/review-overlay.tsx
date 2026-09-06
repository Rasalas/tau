import { lazy, Suspense, useCallback, useSyncExternalStore } from "react";
import type { OverlayProps } from "../extension-system";
import { LazyFeatureFallback } from "../components/LazyFeature";
import { getHostClient, useHostClient } from "../host-client-context";
import { usePreferences } from "../renderer-services-context";
import { automaticCommitMessages } from "./commit-messages";
import type { DiffLoadOptions, UiEditor, UiFileDiff, UiWorkspaceChanges, WorkspaceChangesQuery, WorkspaceInfo } from "../../shared/workspace-kit-types";

const LazyReview = lazy(() => import("../components/ReviewMode").then(({ ReviewMode }) => ({ default: ReviewMode })));

export const REVIEW_OVERLAY = "review.workspace";
/** Where Workspace Kit publishes its store; mirrored from `kits/workspace/protocol.ts`. */
export const WORKSPACE_STORE_SERVICE = "tau.workspace/store";

/**
 * What Review Kit needs from whoever owns the worktree. Workspace Kit's store
 * satisfies it; Review Kit never imports that kit, it only names the service.
 */
export interface ReviewWorkspaceStore {
  getSnapshot(): {
    cwd?: string;
    workspaceId?: string;
    changes: UiWorkspaceChanges;
    workspace?: WorkspaceInfo;
    committing: boolean;
    review?: { path?: string; primaryPush: boolean };
  };
  subscribe(listener: () => void): () => void;
  activeEditor(): UiEditor | undefined;
  openReview(path?: string, pushPrimary?: boolean): void;
  selectReviewPath(path: string): void;
  closeReview(): void;
  commit(message: string, push: boolean): Promise<void>;
  openInEditor(relPath?: string): Promise<void>;
  suggestCommitMessage(changes: UiWorkspaceChanges, diffs: readonly UiFileDiff[]): Promise<string | undefined>;
  registerCommitMessageSuggester(suggester: (request: {
    changes: UiWorkspaceChanges;
    diffs: readonly UiFileDiff[];
    actions: import("../extension-system").WorkbenchActions;
  }) => Promise<string>): () => void;
}

const WORKSPACE_EXTENSION_ID = "tau.workspace";

function workspaceInvoke(command: string, input?: unknown): Promise<unknown> {
  const client = getHostClient();
  if (!client) throw new Error("The Electron host is not available.");
  return client.invokeHostExtension(WORKSPACE_EXTENSION_ID, command, input);
}

/** Review Kit's full-workbench review of the live worktree, over Workspace Kit's state. */
export function ReviewOverlay({ onClose, workspace }: OverlayProps & { workspace: ReviewWorkspaceStore }) {
  const client = useHostClient();
  const preferences = usePreferences();
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, workspace.getSnapshot);
  const review = state.review ?? { primaryPush: false };
  const selectPath = useCallback((path: string) => workspace.selectReviewPath(path), [workspace]);
  const closeReview = useCallback(() => {
    workspace.closeReview();
    onClose();
  }, [onClose, workspace]);
  const commit = useCallback((message: string, push: boolean) => void workspace.commit(message, push), [workspace]);
  const openInEditor = useCallback((path: string) => void workspace.openInEditor(path), [workspace]);
  const suggestCommitMessage = useCallback(
    (changes: UiWorkspaceChanges, diffs: readonly UiFileDiff[]) => workspace.suggestCommitMessage(changes, diffs),
    [workspace],
  );
  const loadChanges = useCallback((query?: WorkspaceChangesQuery) => workspaceInvoke("changes", query === undefined ? undefined : { query }) as Promise<UiWorkspaceChanges>, []);
  const loadDiff = useCallback(async (path: string, options?: DiffLoadOptions) => client
    ? await workspaceInvoke("file-diff", { relPath: path, options }) as UiFileDiff
    : { path, added: 0, removed: 0, hunks: [], note: "Diffs require the Electron host." }, [client]);
  return (
    <Suspense fallback={<LazyFeatureFallback label="review" />}>
      <LazyReview
        changes={state.changes}
        selectedPath={review.path ?? state.changes.files[0]?.path}
        editor={workspace.activeEditor()}
        busy={state.committing}
        primaryPush={review.primaryPush}
        onSelect={selectPath}
        onBack={closeReview}
        onCommit={commit}
        onOpenInEditor={openInEditor}
        workspaceKey={state.workspaceId ?? state.cwd}
        autoSuggestCommitMessage={automaticCommitMessages(preferences)}
        suggestCommitMessage={suggestCommitMessage}
        loadChanges={client ? loadChanges : undefined}
        loadDiff={loadDiff}
      />
    </Suspense>
  );
}
