import type { DesktopExtension } from "./extension-system";
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
  /**
   * Desktop extensions the client is constructed with, beside the ones it
   * imports from the host. The desktop app hands over none — its kits arrive
   * from `dist-kits` like packages — but an embedder, and a kit's own tests,
   * hand over the halves they want the workbench to start with.
   */
  extensions?: readonly DesktopExtension[];
}

export function createRendererServices(extensions?: readonly DesktopExtension[]): RendererServices {
  const preferences = new PreferencesStore();
  return { preferences, workspaceStore: new WorkspaceStore(preferences), ...(extensions ? { extensions } : {}) };
}
