import type { ReactNode } from "react";
import { createMemoryStorage } from "../client-storage";
import { ClientStorageProvider } from "../client-storage-context";
import { createRendererServices } from "../renderer-services";
import { RendererServicesProvider } from "../renderer-services-context";

/**
 * Wraps a component tree with fresh in-memory storage and fresh
 * `preferences`/`workspaceStore` instances, for tests that render a single
 * component (not the whole `App`) but still reach `useClientStorage`,
 * `usePreferences` or `useWorkspaceStore`.
 */
export function TestProviders({ children }: { children: ReactNode }) {
  return (
    <ClientStorageProvider storage={createMemoryStorage()}>
      <RendererServicesProvider services={createRendererServices()}>
        {children}
      </RendererServicesProvider>
    </ClientStorageProvider>
  );
}
