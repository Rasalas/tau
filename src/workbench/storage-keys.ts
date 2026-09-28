/**
 * Every literal storage key the renderer writes, in one place. Bump the
 * version suffix when a key's shape changes incompatibly.
 */
export const STORAGE_KEYS = {
  preferences: "tau.preferences.v1",
  preferencesLegacy: "tau.preferences",
  bootstrapCache: "tau.bootstrap-cache.v7",
  bootstrapCacheLegacy: ["tau.bootstrap-cache.v6", "tau.bootstrap-cache.v4", "tau.bootstrap-cache.v3"] as const,
  composerDrafts: "tau.composer-drafts.v1",
  activeNewThread: "tau.active-new-thread.v1",
  /** New threads' drafts the user left with text in them. */
  keptDrafts: "tau.kept-drafts.v1",
  turnActivityCache: "tau.turn-activity.v1",
  /** Prefix of the stage kept per project before K72; read once, to hand it to a thread. */
  stage: "tau.stage.v1",
  /** Prefix; `threadStageKey` adds the thread or draft. */
  threadStage: "tau.stage.v2",
  /** Prefix; `dockStateKey` adds the workspace. */
  dock: "tau.dock.v1",
  dockWidth: "tau:dock-width",
  sidebarOpen: "tau:sidebar-open",
  sidebarWidth: "tau:sidebar-width",
  drawerHeight: "tau:drawer-height",
  chatWidth: "tau:chat-width",
  reviewSidebarWidth: "tau:review-sidebar-width",
  reviewSidebarOpen: "tau:review-sidebar-open",
  composerFold: "tau:composer-fold",
} as const;

/**
 * Keys that hold one host's state. A page showing another machine keeps its
 * own copy of each (ADR 0025); dock and review keys already carry a
 * workspace id, which includes the host's.
 */
export const HOST_STORAGE_KEYS: readonly string[] = [
  STORAGE_KEYS.threadStage,
  STORAGE_KEYS.bootstrapCache,
  ...STORAGE_KEYS.bootstrapCacheLegacy,
  STORAGE_KEYS.composerDrafts,
  STORAGE_KEYS.activeNewThread,
  STORAGE_KEYS.keptDrafts,
  STORAGE_KEYS.turnActivityCache,
];

/** `tau.stage.v1:<workspace>`, the old per-project stage; `workspace` is a workspace id, or a path from a host that mints none. */
export function stageStateKey(workspace: string): string {
  return `${STORAGE_KEYS.stage}:${workspace}`;
}

/** `tau.stage.v2:<owner>`; `owner` is `thread:<id>` or `draft:<draftId>` (`stageOwner`). */
export function threadStageKey(owner: string): string {
  return `${STORAGE_KEYS.threadStage}:${owner}`;
}

/** `tau.dock.v1:<workspace>`; which panels were mounted, the last one picked, and how wide. Same `workspace` as above. */
export function dockStateKey(workspace: string): string {
  return `${STORAGE_KEYS.dock}:${workspace}`;
}

/** `tau.review.v1:<workspace>:<scope>`; `workspace` is a workspace id, or a path from an older host. */
export function reviewStateKey(workspace: string, scope: string): string {
  return `tau.review.v1:${workspace}:${scope}`;
}
