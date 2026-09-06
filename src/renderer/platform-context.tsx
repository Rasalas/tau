import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createMemoryStorage, getClientStorage } from "../workbench/client-storage";
import { getHostClient, useHostClient } from "./host-client-context";
import type { Platform } from "../workbench/platform";
import { createElectronPlatform } from "./platform-electron";

const PlatformReactContext = createContext<Platform | undefined>(undefined);

export function PlatformProvider({ platform, children }: { platform: Platform; children: ReactNode }) {
  return <PlatformReactContext.Provider value={platform}>{children}</PlatformReactContext.Provider>;
}

let ambientPlatform: Platform | undefined;

/** `App` installs the platform it built, so module-scope singletons can reach it too. */
export function setPlatform(platform: Platform | undefined): void {
  ambientPlatform = platform;
}

/** For stores and other modules outside the component tree. */
export function getPlatform(): Platform {
  ambientPlatform ??= electronPlatformOver(getHostClient());
  return ambientPlatform;
}

/**
 * The platform a client gets when nothing installed one: Electron's, over
 * whichever host client is in scope. A slice rendered on its own in a test has
 * no provider above it and lands here, the way `useClientStorage` falls back.
 */
function electronPlatformOver(client: ReturnType<typeof getHostClient>): Platform {
  return createElectronPlatform({
    ...(client ? { client } : {}),
    storage: getClientStorage() ?? createMemoryStorage(),
    openInEditor: () => undefined,
    hasLocalFiles: () => false,
  });
}

export function usePlatform(): Platform {
  const installed = useContext(PlatformReactContext);
  const client = useHostClient();
  return useMemo(() => installed ?? electronPlatformOver(client), [client, installed]);
}
