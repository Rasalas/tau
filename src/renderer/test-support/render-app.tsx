import { render, type RenderResult } from "@testing-library/react";
import App from "../App";
import { HostClientProvider, setHostClient } from "../host-client-context";
import type { HostClient } from "../host-client";
import type { DesktopExtension } from "../extension-system";
import { createMemoryStorage, setClientStorage, type ClientStorage } from "../client-storage";
import { ClientStorageProvider } from "../client-storage-context";
import { createRendererServices, type RendererServices } from "../renderer-services";
import { RendererServicesProvider } from "../renderer-services-context";

export interface RenderedApp extends RenderResult {
  /** The storage this render installed; a test may seed it before rendering via `options.storage`. */
  storage: ClientStorage;
  /** The `preferences` instance this render created. */
  services: RendererServices;
}

export interface RenderAppOptions {
  /** Pre-seeded storage, e.g. `writeCachedTurnActivity(storage, ...)` before render. */
  storage?: ClientStorage;
  /** Desktop halves the workbench starts with; a kit's own App tests pass theirs. */
  extensions?: readonly DesktopExtension[];
  /** Runs against the fresh services before render, e.g. `({ preferences }) => preferences.toggleSettled(id)`. */
  seed?(services: RendererServices): void;
}

/**
 * Renders `App` behind the host-client provider tests exercise it through.
 * Also installs the ambient client `main.tsx` would, so modules outside the
 * component tree see the same fake the components do. A fresh in-memory
 * storage and a fresh `preferences` instance back every render, so tests never
 * leak state into one another.
 */
export function renderApp(client: HostClient | undefined, options?: RenderAppOptions): RenderedApp {
  setHostClient(client);
  const storage = options?.storage ?? createMemoryStorage();
  setClientStorage(storage);
  const services = createRendererServices(options?.extensions);
  options?.seed?.(services);
  const result = render(
    <HostClientProvider client={client}>
      <ClientStorageProvider storage={storage}>
        <RendererServicesProvider services={services}>
          <App />
        </RendererServicesProvider>
      </ClientStorageProvider>
    </HostClientProvider>,
  );
  return { ...result, storage, services };
}
