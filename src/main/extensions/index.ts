import type { HostExtension } from "../host-extensions.js";
import { loadBundledKitHostHalves, type BundledKitsOptions } from "../bundled-kits.js";

/**
 * Every host half Tau ships, as the host activates them: the kits that already
 * live under `kits/` are compiled and imported like packages, the rest are
 * still constructed here. Ticket by ticket this list shrinks to nothing.
 */
export function shippedHostExtensions(
  options: BundledKitsOptions,
  log: (label: string, detail: string) => void,
): () => Promise<HostExtension[]> {
  return async () => {
    const loaded = await loadBundledKitHostHalves(options);
    for (const failure of loaded.errors) log("host-extension.kit.failed", `${failure.path}: ${failure.message}`);
    return [...bundledHostExtensions(), ...loaded.extensions];
  };
}

/** Host entries of the kits still built in the host. Safe mode starts with none of them. */
export function bundledHostExtensions(): HostExtension[] {
  return [
  ];
}
