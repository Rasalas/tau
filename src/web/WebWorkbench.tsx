import { useLayoutEffect, useMemo } from "react";
import App from "../renderer/App";
import { ClientEnvironmentProvider, type ClientEnvironment } from "../renderer/client-environment";
import { ClientStorageProvider } from "../renderer/client-storage-context";
import { HostClientProvider } from "../renderer/host-client-context";
import { RendererServicesProvider } from "../renderer/renderer-services-context";
import type { RendererServices } from "../renderer/renderer-services";
import type { ClientStorage } from "../workbench/client-storage";
import type { ClientProfile } from "../workbench/client-profile";
import type { HostClient } from "../workbench/host-client";
import { followThemePreference } from "../renderer/theme";
import { createWebPlatform } from "./platform-web";
import { indexedBundleStore, withBundleStore } from "./bundle-cache";
import { storedPageCatalog } from "./page-catalog";
import { setPageCatalog } from "../renderer/touch/PhoneNav";
import { getClientStorage } from "../workbench/client-storage";

// A phone's navigation has its pages at once on the next start.
setPageCatalog(storedPageCatalog(getClientStorage));

/** What a browser tab is, as the workbench's `ClientEnvironment`. */
export function webClientEnvironment(profile: ClientProfile): ClientEnvironment {
  return { profile, safeMode: false, createPlatform: createWebPlatform };
}

/**
 * The same workbench the Electron window renders, with a browser under it.
 * There is no second component tree and no second store: the difference
 * between the two clients is this file, `platform-web.ts`, and which
 * contributions the registry accepts for the profile.
 */
export function WebWorkbench({ client, storage, services, environment }: {
  client: HostClient | undefined;
  storage: ClientStorage;
  services: RendererServices;
  environment: ClientEnvironment;
}) {
  // The Electron entry does this before its first render; here the services come with the host.
  useLayoutEffect(() => followThemePreference(services.preferences), [services]);
  // The packages come from the store where they did not change since the last start.
  const kept = useMemo(() => client && withBundleStore(client, indexedBundleStore()), [client]);
  return <ClientEnvironmentProvider environment={environment}>
    <HostClientProvider client={kept}>
      <ClientStorageProvider storage={storage}>
        <RendererServicesProvider services={services}>
          <App />
        </RendererServicesProvider>
      </ClientStorageProvider>
    </HostClientProvider>
  </ClientEnvironmentProvider>;
}
