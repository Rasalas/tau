import type { DesktopExtension } from "./extension-system";
import { PreferencesStore } from "./preferences";
import { AppUpdateStore } from "./app-update";

/**
 * The renderer's non-component singletons, created once at the composition
 * point (`main.tsx`, or `renderApp` in tests) instead of at module scope. A
 * kit's own state is not here: a kit creates it in `activate` and publishes it
 * with `provideService` (ADR 0014).
 */
export interface RendererServices {
  preferences: PreferencesStore;
  /** The Tau release the host downloaded, for the toast and the sidebar's foot; `createRendererServices` makes one. */
  appUpdate?: AppUpdateStore;
  /**
   * Desktop extensions the client is constructed with, beside the ones it
   * imports from the host. The desktop app hands over none — its kits arrive
   * from `dist-kits` like packages — but an embedder, and a kit's own tests,
   * hand over the halves they want the workbench to start with.
   */
  extensions?: readonly DesktopExtension[];
}

export function createRendererServices(extensions?: readonly DesktopExtension[]): RendererServices {
  return { preferences: new PreferencesStore(), appUpdate: new AppUpdateStore(), ...(extensions ? { extensions } : {}) };
}
