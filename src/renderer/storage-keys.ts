/**
 * Every literal storage key the renderer writes, in one place. Bump the
 * version suffix when a key's shape changes incompatibly.
 */
export const STORAGE_KEYS = {
  preferences: "tau.preferences",
  bootstrapCache: "tau.bootstrap-cache.v6",
  bootstrapCacheLegacy: ["tau.bootstrap-cache.v4", "tau.bootstrap-cache.v3"] as const,
  workspaceTurnBaseline: "tau.workspace.turn-baseline.v1",
  composerDrafts: "tau.composer-drafts.v1",
  activeNewThread: "tau.active-new-thread.v1",
  turnActivityCache: "tau.turn-activity.v1",
  dockWidth: "tau:dock-width",
  reviewSidebarWidth: "tau:review-sidebar-width",
  reviewSidebarOpen: "tau:review-sidebar-open",
} as const;

/** `tau.review.v1:<workspace>:<scope>`, scoped per workspace and review scope. */
export function reviewStateKey(workspace: string, scope: string): string {
  return `tau.review.v1:${workspace}:${scope}`;
}

/** `tau.project-actions:<cwd>`, scoped per project. */
export function projectActionsKey(cwd?: string): string {
  return `tau.project-actions:${cwd ?? "unknown"}`;
}
