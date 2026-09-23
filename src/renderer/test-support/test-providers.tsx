import { useState, type ReactNode } from "react";
import type { UiProject, UiSession } from "../../shared/contracts";
import { ThreadStore } from "../../workbench/thread-store";
import { ThreadStoreContext } from "../workbench-context";
import { createMemoryStorage } from "../../workbench/client-storage";
import { ClientStorageProvider } from "../client-storage-context";
import { createRendererServices } from "../renderer-services";
import type { PreferencesStore } from "../preferences";
import { RendererServicesProvider } from "../renderer-services-context";

/**
 * Wraps a component tree with fresh in-memory storage and fresh
 * `preferences`, for tests that render a single component (not the whole
 * `App`) but still reach `useClientStorage` or `usePreferences`.
 */
export function TestProviders({ children, preferences }: { children: ReactNode; preferences?: PreferencesStore }) {
  return (
    <ClientStorageProvider storage={createMemoryStorage()}>
      <RendererServicesProvider services={{ ...createRendererServices(), ...(preferences ? { preferences } : {}) }}>
        {children}
      </RendererServicesProvider>
    </ClientStorageProvider>
  );
}

/**
 * A thread index for a component that reads `useThreadStore` (the rail's
 * threads and projects) without the whole `App` around it.
 */
export function TestThreadStore({ threads, projects = [], children }: { threads: UiSession[]; projects?: UiProject[]; children: ReactNode }) {
  const [store] = useState(() => {
    const next = new ThreadStore();
    next.applyThreadIndex({ projects, sessions: threads });
    return next;
  });
  return <ThreadStoreContext.Provider value={store}>{children}</ThreadStoreContext.Provider>;
}
