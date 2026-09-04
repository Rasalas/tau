import { PreferencesStore } from "./preferences";
import { WorkspaceStore } from "./extensions/workspace-store";

/**
 * The renderer's non-component singletons, created once at the composition
 * point (`main.tsx`, or `renderApp` in tests) instead of at module scope.
 * `preferences` keeps its own public API; `workspaceStore` is Workspace
 * Kit's state, not core's.
 */
export interface RendererServices {
  preferences: PreferencesStore;
  workspaceStore: WorkspaceStore;
}

export function createRendererServices(): RendererServices {
  const preferences = new PreferencesStore();
  return { preferences, workspaceStore: new WorkspaceStore(preferences) };
}
