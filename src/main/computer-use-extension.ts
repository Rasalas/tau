import computerUseExtension from "@amaster.ai/pi-computer-use";
import type { ExtensionFactory, SettingsManager } from "@earendil-works/pi-coding-agent";

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
 * Tau ships computer use as an inline extension. A user-configured Pi package
 * wins so existing installations do not register the same tools twice.
 */
export function computerUseExtensionFactories(
  settingsManager: SettingsManager,
): Array<{ name: string; factory: ExtensionFactory }> {
  if (
    settingsIncludeComputerUse(settingsManager.getGlobalSettings())
    || settingsIncludeComputerUse(settingsManager.getProjectSettings())
  ) return [];

  return [{ name: "tau-computer-use", factory: computerUseExtension }];
}
