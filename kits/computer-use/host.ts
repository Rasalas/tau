import type { HostExtension, HostExtensionContext } from "tau/host-extension";
import { COMPUTER_USE_EXTENSION_ID, COMPUTER_USE_PACKAGE, COMPUTER_USE_RUNTIME_EXTENSION } from "./protocol.js";

type PiPackageSource = string | { source: string; autoload?: boolean };
interface PackageSettings { packages?: PiPackageSource[] }

function packageSource(entry: PiPackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

export function settingsIncludeComputerUse(settings: PackageSettings): boolean {
  return settings.packages?.some((entry) => {
    const source = packageSource(entry);
    return source === `npm:${COMPUTER_USE_PACKAGE}`
      || source.startsWith(`npm:${COMPUTER_USE_PACKAGE}@`);
  }) ?? false;
}

/**
 * Computer Use's host entry: the npm package as a bundled Pi extension. The
 * host loads the package, because its driver binaries live beside the module
 * npm installed. A user-configured Pi package wins, so existing installations
 * do not register the same tools twice.
 */
export function createComputerUseHostExtension(): HostExtension {
  return {
    id: COMPUTER_USE_EXTENSION_ID,
    name: "Computer Use",
    permissions: ["runtime:extend"],
    async activate(context: HostExtensionContext) {
      const factory = await context.services.loadRuntimeExtension(COMPUTER_USE_PACKAGE);
      context.services.registerRuntimeExtension(COMPUTER_USE_RUNTIME_EXTENSION, factory, {
        enabledFor: (settings) =>
          !settingsIncludeComputerUse(settings.global as PackageSettings)
          && !settingsIncludeComputerUse(settings.project as PackageSettings),
      });
    },
  };
}

export default createComputerUseHostExtension;
