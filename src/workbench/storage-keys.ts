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
  reviewSidebarWidth: "tau:review-sidebar-width",
  reviewSidebarOpen: "tau:review-sidebar-open",
} as const;

/** `tau.stage.v1:<workspace>`; the tabs and the active one, per workspace identity. */
export function stageStateKey(workspace: string): string {
  return `${STORAGE_KEYS.stage}:${workspace}`;
}

/** `tau.dock.v1:<workspace>`; which panels are open, which one is on top, and how wide. */
export function dockStateKey(workspace: string): string {
  return `${STORAGE_KEYS.dock}:${workspace}`;
}

/** `tau.review.v1:<workspace>:<scope>`; `workspace` is a workspace id, or a path from an older host. */
export function reviewStateKey(workspace: string, scope: string): string {
  return `tau.review.v1:${workspace}:${scope}`;
}
