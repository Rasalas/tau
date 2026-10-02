import type { HostExtensionClient, PlatformEnvironments } from "tau";

/** A kit's host half on another machine, over this window's connection there. */
export function machineKitClient(environments: PlatformEnvironments, machine: string, extensionId: string, options?: { timeoutMs?: number }): HostExtensionClient {
  return {
    invoke: (command, input) => {
      if (!environments.invokeExtension) throw new Error("This window cannot reach kits of other machines.");
      return options
        ? environments.invokeExtension(machine, extensionId, command, input, options)
        : environments.invokeExtension(machine, extensionId, command, input);
    },
    onEvent: (name, listener) => environments.onExtensionEvent?.(machine, extensionId, (eventName, payload) => {
      if (eventName === name) listener(payload);
    }) ?? (() => undefined),
  };
}
