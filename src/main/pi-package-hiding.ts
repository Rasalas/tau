import type { SettingsManager } from "@earendil-works/pi-coding-agent";

type PackageEntry = string | { source: string };
type Scope = "global" | "project";

const sourceOf = (entry: PackageEntry): string => (typeof entry === "string" ? entry : entry.source);

/**
 * Hides the Pi packages an extension replaces from this one settings manager,
 * so Pi's resource loader never resolves them. The files are not touched, and
 * writes through the manager put the hidden entries back.
 */
export function hidePiPackages(settingsManager: SettingsManager, replaces: readonly ((source: string) => boolean)[]): void {
  if (replaces.length === 0) return;
  const hidden = (entry: PackageEntry): boolean => replaces.some((replace) => replace(sourceOf(entry)));
  const held: Record<Scope, PackageEntry[]> = { global: [], project: [] };
  const readGlobal = settingsManager.getGlobalSettings.bind(settingsManager);
  const readProject = settingsManager.getProjectSettings.bind(settingsManager);
  const visible = <T extends { packages?: PackageEntry[] }>(scope: Scope, settings: T): T => {
    held[scope] = (settings.packages ?? []).filter(hidden);
    return held[scope].length === 0 ? settings : { ...settings, packages: (settings.packages ?? []).filter((entry) => !hidden(entry)) };
  };
  settingsManager.getGlobalSettings = () => visible("global", readGlobal());
  settingsManager.getProjectSettings = () => visible("project", readProject());
  // Learn what is hidden before anything writes.
  settingsManager.getGlobalSettings();
  settingsManager.getProjectSettings();
  const writeGlobal = settingsManager.setPackages.bind(settingsManager);
  const writeProject = settingsManager.setProjectPackages.bind(settingsManager);
  settingsManager.setPackages = (packages) => writeGlobal([...packages, ...held.global]);
  settingsManager.setProjectPackages = (packages) => writeProject([...packages, ...held.project]);
}
