import computerUseExtension from "@amaster.ai/pi-computer-use";
import type { HostExtension, HostExtensionContext } from "../host-extensions.js";

export const COMPUTER_USE_HOST_EXTENSION_ID = "tau.computer-use";
export const COMPUTER_USE_PACKAGE = "@amaster.ai/pi-computer-use";

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
 * Computer Use Kit's host entry: the npm package as a bundled Pi extension. A
 * user-configured Pi package wins so existing installations do not register
 * the same tools twice.
 */
export function createComputerUseHostExtension(): HostExtension {
  return {
    id: COMPUTER_USE_HOST_EXTENSION_ID,
    name: "Computer Use",
    permissions: ["runtime:extend"],
    activate(context: HostExtensionContext) {
      context.services.registerRuntimeExtension("tau-computer-use", computerUseExtension, {
        enabledFor: (settings) =>
          !settingsIncludeComputerUse(settings.global as PackageSettings)
          && !settingsIncludeComputerUse(settings.project as PackageSettings),
      });
    },
  };
}
