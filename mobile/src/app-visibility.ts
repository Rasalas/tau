import type { Visibility } from "./machines";
import type { AppStateEvents } from "./wakes";

interface AppVisibilityEvents extends AppStateEvents {
  getState(): Promise<{ isActive: boolean }>;
}

/** Native activity state also governs polling and widgets when the web view stays visible. */
export async function nativeAppVisibility(app: AppVisibilityEvents): Promise<Visibility & { dispose(): void }> {
  let active = true;
  let changed = false;
  let disposed = false;
  const listeners = new Set<() => void>();
  const handle = await app.addListener("appStateChange", ({ isActive }) => {
    if (disposed) return;
    changed = true;
    if (active === isActive) return;
    active = isActive;
    for (const listener of [...listeners]) listener();
  });
  // Listen first. A native transition wins over an older asynchronous read.
  const initial = await app.getState().catch(() => undefined);
  if (initial && !changed) active = initial.isActive;
  return {
    visible: () => active,
    subscribe: (listener) => {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      void handle.remove().catch(() => undefined);
    },
  };
}
