import { useLayoutEffect } from "react";
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
  return <ClientEnvironmentProvider environment={environment}>
    <HostClientProvider client={client}>
      <ClientStorageProvider storage={storage}>
        <RendererServicesProvider services={services}>
          <App />
        </RendererServicesProvider>
      </ClientStorageProvider>
    </HostClientProvider>
  </ClientEnvironmentProvider>;
}
