import { createContext, useContext, type ReactNode } from "react";
import type { HostClient } from "./host-client";

const HostClientReactContext = createContext<HostClient | undefined>(undefined);

/** Undefined outside Electron (the browser-preview build); callers degrade the way an absent desktop bridge used to. */
export function HostClientProvider({ client, children }: { client: HostClient | undefined; children: ReactNode }) {
  return <HostClientReactContext.Provider value={client}>{children}</HostClientReactContext.Provider>;
}

/** For components. Non-component singletons (a store built at module scope) use `getHostClient` instead. */
export function useHostClient(): HostClient | undefined {
  return useContext(HostClientReactContext);
}

let ambientClient: HostClient | undefined;

/**
 * `main.tsx` calls this once, before the first render, so module-scope
 * singletons created outside the component tree (Workspace Kit's stores) can
 * still reach the active client without prop-drilling through every extension.
 */
export function setHostClient(client: HostClient | undefined): void {
  ambientClient = client;
}

/** The client `setHostClient` last installed, for non-component modules. */
export function getHostClient(): HostClient | undefined {
  return ambientClient;
}

/** Whether there is an Electron host to reach at all; the browser preview has none. */
export function hostAvailable(): boolean {
  return Boolean(ambientClient);
}
