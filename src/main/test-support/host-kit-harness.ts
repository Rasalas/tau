import type { GlobalHostEvent } from "../../shared/contracts.js";
import { HostExtensionRegistry, type HostExtension, type HostExtensionServices } from "../host-extensions.js";

/**
 * A host extension registry over a stub facade, for a kit's own tests. Kits
 * live outside `src/`, so this is the one host module they may reach for —
 * everything else has to come through `tau/host-extension`. `onEvent` is where
 * the kit's `context.emit` lands, for a kit that pushes state to its panel.
 */
export function activateHostKit(
  extension: HostExtension,
  services: Partial<HostExtensionServices> = {},
  onEvent: (event: GlobalHostEvent) => void = () => undefined,
): Promise<HostExtensionRegistry> {
  const registry = new HostExtensionRegistry({
    cwd: () => "/project",
    safeMode: false,
    log: () => undefined,
    ...services,
  } as HostExtensionServices, onEvent);
  return registry.activate(extension).then(() => registry);
}
