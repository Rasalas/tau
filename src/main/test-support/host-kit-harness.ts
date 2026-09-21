import type { GlobalHostEvent } from "../../shared/contracts.js";
import { HostExtensionRegistry, type HostExtension, type HostExtensionServices } from "../host-extensions.js";

/** An `extension-event` a kit published, as its desktop half receives it. */
export interface PublishedKitEvent {
  type: "extension-event";
  extensionId: string;
  name: string;
  payload?: unknown;
}

/**
 * A host extension registry over a stub facade, for a kit's own tests. Kits
 * live outside `src/`, so this is the one host module they may reach for —
 * everything else has to come through `tau/host-extension`.
 *
 * `publish` receives what the kit emitted; a kit that asserts on its events
 * collects them into a `PublishedKitEvent[]`.
 */
export function activateHostKit(
  extension: HostExtension,
  services: Partial<HostExtensionServices> = {},
  publish: (event: PublishedKitEvent) => void = () => undefined,
): Promise<HostExtensionRegistry> {
  const registry = new HostExtensionRegistry({
    cwd: () => "/project",
    complete: async () => "",
    agentDir: "/agent",
    sessionsDir: "/agent/sessions",
    stateDir: "/state",
    safeMode: false,
    log: () => undefined,
    // Nothing is watched in a kit's own test; a kit that follows config changes
    // still activates, and its test drives the listener it passes here.
    observeConfigChanges: () => () => undefined,
    ...services,
  } as HostExtensionServices, (event: GlobalHostEvent) => {
    if (event.type === "extension-event") publish(event);
  });
  return registry.activate(extension).then(() => registry);
}
