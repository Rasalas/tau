import type { HostClient } from "../workbench/host-client";
import type { HostExtensionBridge } from "./extension-contracts";

/** Thrown when there is no host to route to, e.g. in the browser preview. */
export class HostUnavailableError extends Error {
  constructor() { super("No machine is connected."); this.name = "HostUnavailableError"; }
}

export const noHostBridge: HostExtensionBridge = {
  invoke: () => Promise.reject(new HostUnavailableError()),
  inspect: () => Promise.reject(new HostUnavailableError()),
};

/** Generalizes the desktop API's `invokeHostExtension` to whatever `HostClient` is active. */
export function hostExtensionBridge(client: HostClient | undefined): HostExtensionBridge {
  if (!client) return noHostBridge;
  return {
    invoke: (extensionId, command, input) => client.invokeHostExtension(extensionId, command, input),
    inspect: (cwd) => client.inspectExtensions(cwd),
    ...(client.resourceUrl ? { resourceUrl: (path: string) => client.resourceUrl!(path) } : {}),
    ...(client.readBrowserResource ? { readResource: (path: string) => client.readBrowserResource(path) } : {}),
    watch: (extensionId: string, topic: string) => client.watchHostTopic(extensionId, topic),
  };
}
