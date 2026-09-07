import type { ReactNode } from "react";
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
