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
  turnActivityCache: "tau.turn-activity.v1",
  /** Prefix; `stageStateKey` adds the workspace. */
  stage: "tau.stage.v1",
  /** Prefix; `dockStateKey` adds the workspace. */
  dock: "tau.dock.v1",
  dockWidth: "tau:dock-width",
  sidebarOpen: "tau:sidebar-open",
  sidebarWidth: "tau:sidebar-width",
  drawerHeight: "tau:drawer-height",
  reviewSidebarWidth: "tau:review-sidebar-width",
  reviewSidebarOpen: "tau:review-sidebar-open",
  composerFold: "tau:composer-fold",
} as const;

/**
 * Keys that hold one host's state. A page showing another machine keeps its
 * own copy of each (ADR 0025); stage, dock and review keys already carry a
 * workspace id, which includes the host's.
 */
export const HOST_STORAGE_KEYS: readonly string[] = [
  STORAGE_KEYS.bootstrapCache,
  ...STORAGE_KEYS.bootstrapCacheLegacy,
  STORAGE_KEYS.composerDrafts,
  STORAGE_KEYS.activeNewThread,
  STORAGE_KEYS.turnActivityCache,
];

/** `tau.stage.v1:<workspace>`; `workspace` is a workspace id, or a path from a host that mints none. */
export function stageStateKey(workspace: string): string {
  return `${STORAGE_KEYS.stage}:${workspace}`;
}

/** `tau.dock.v1:<workspace>`; which panels are open, which one is on top, and how wide. Same `workspace` as above. */
export function dockStateKey(workspace: string): string {
  return `${STORAGE_KEYS.dock}:${workspace}`;
}

/** `tau.review.v1:<workspace>:<scope>`; `workspace` is a workspace id, or a path from an older host. */
export function reviewStateKey(workspace: string, scope: string): string {
  return `tau.review.v1:${workspace}:${scope}`;
}
