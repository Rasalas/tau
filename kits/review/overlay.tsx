import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  HostUnavailableError,
  ReviewMode,
  type DesktopExtensionContext,
  type DiffLoadOptions,
  type OverlayProps,
  type UiFileDiff,
  type UiWorkspaceChanges,
  type WorkbenchActions,
  type WorkspaceChangesQuery,
} from "tau";
import { automaticCommitMessages } from "./commit-messages.js";
import { COLLAPSED_OPTION, diffWordWrap, SPLIT_OPTION, WHITESPACE_OPTION, WRAP_OPTION } from "./diff-settings.js";
import { CommentsPanel, CommentsToolbar, handOffComments, useCommentLines } from "./comment-views.js";
import type { ReviewCommentStore } from "./comments.js";
import { REVIEW_HOST_EXTENSION_ID, type ChangesSectionProps, type ComposerContextChips, type WorkspaceStoreApi } from "./protocol.js";
import type { WorkspaceChangesReader } from "./workspace.js";

export { COLLAPSED_OPTION, SPLIT_OPTION, WHITESPACE_OPTION } from "./diff-settings.js";

/** Review of the live worktree, with commit, staging and request controls in its sidebar. */
export function createReviewOverlay(
  plugin: DesktopExtensionContext,
  workspace: WorkspaceChangesReader,
  store: WorkspaceStoreApi,
  comments: ReviewCommentStore,
  chips: () => ComposerContextChips | undefined,
  embedded = false,
) {
  const { stageFile, unstageFile, stageAll, revertFile } = store;
  const fileActions = stageFile && unstageFile && revertFile ? {
    stage: (path: string) => stageFile.call(store, path),
    unstage: (path: string) => unstageFile.call(store, path),
    revert: (path: string) => revertFile.call(store, path),
    ...(stageAll ? { stageAll: () => stageAll.call(store) } : {}),
  } : undefined;
  const option = (id: string) => plugin.preferences.optionValue(REVIEW_HOST_EXTENSION_ID, id, false);
  return function ReviewOverlay({ actions, onClose }: OverlayProps) {
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    useSyncExternalStore(plugin.preferences.subscribe, plugin.preferences.getSnapshot, plugin.preferences.getSnapshot);
    const commentState = useSyncExternalStore(comments.subscribe, comments.getSnapshot, comments.getSnapshot);
    const workspaceKey = state.workspaceId ?? state.cwd;
    useEffect(() => { comments.open(workspaceKey ?? "workspace"); }, [workspaceKey]);
    const lines = useCommentLines(comments, commentState);
    const review = state.review ?? { primaryPush: embedded && Boolean(state.workspace?.upstream) };
    useEffect(() => { if (embedded) void store.refresh(); }, [workspaceKey]);
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
        const diff = await workspace.fileDiff(path, options);
        comments.recordDiff(path, diff, (options?.hunkOffset ?? 0) > 0);
        return diff;
      } catch (error) {
        if (!(error instanceof HostUnavailableError)) throw error;
        return { path, added: 0, removed: 0, hunks: [], note: "Diffs require the Electron host." };
      }
    }, []);
    // Request controls share the review sidebar.
    const sections = state.changesSections;
    // A request opened from the list becomes the active stage tab.
    const listHeader = useMemo(() => {
      if (!sections?.length) return undefined;
      const tabActions: WorkbenchActions = { ...actions, openStageTab: (...open) => { closeReview(); return actions.openStageTab(...open); } };
      return ({ message, committed, composing, offer }: { message: string; committed(): void; composing: boolean; offer: ChangesSectionProps["offer"] }) => sections.map((Section, index) => <Section key={index} actions={tabActions} message={message} committed={committed} composing={composing} {...offer ? { offer } : {}} />);
    }, [actions, closeReview, sections]);
    const send = useCallback(() => {
      const handed = comments.getSnapshot().comments;
      closeReview();
      handOffComments(handed, { chips: chips(), actions, remove: (ids) => comments.remove(ids) });
    }, [actions, closeReview]);
    return (
      <ReviewMode
        key={workspaceKey ?? "workspace"}
        changes={state.changes}
        embedded={embedded}
        selectedPath={review.path ?? state.changes.files[0]?.path}
        editor={store.activeEditor()}
        busy={state.committing}
        primaryPush={review.primaryPush}
        onSelect={selectPath}
        onBack={closeReview}
        onCommit={commit}
        onOpenInEditor={openInEditor}
        workspaceKey={workspaceKey}
        autoSuggestCommitMessage={automaticCommitMessages(plugin.preferences)}
        suggestCommitMessage={suggestCommitMessage}
        loadChanges={loadChanges}
        loadDiff={loadDiff}
        layout={option(SPLIT_OPTION) ? "split" : "unified"}
        onLayoutChange={(layout) => plugin.preferences.setOption(REVIEW_HOST_EXTENSION_ID, SPLIT_OPTION, layout === "split")}
        ignoreWhitespace={option(WHITESPACE_OPTION)}
        onIgnoreWhitespaceChange={(ignore) => plugin.preferences.setOption(REVIEW_HOST_EXTENSION_ID, WHITESPACE_OPTION, ignore)}
        filesStartCollapsed={option(COLLAPSED_OPTION)}
        wordWrap={diffWordWrap(plugin.preferences)}
        onWordWrapChange={(wrap) => plugin.preferences.setOption(REVIEW_HOST_EXTENSION_ID, WRAP_OPTION, wrap)}
        lines={lines}
        toolbar={<CommentsToolbar store={comments} state={commentState} onSend={send} />}
        aside={<CommentsPanel store={comments} state={commentState} onSend={send} />}
        {...(fileActions ? { fileActions } : {})}
        {...(listHeader ? { listHeader } : {})}
        onRefresh={() => void store.refresh()}
      />
    );
  };
}
