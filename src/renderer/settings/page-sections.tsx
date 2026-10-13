import { createContext, useContext, useSyncExternalStore } from "react";
import type { ExtensionRegistry, SettingsSectionPage } from "../extension-system";
import { SettingsAdvanced } from "../deferred-surfaces";
import { WorkbenchShellContext } from "../workbench-context";

/** The registry whose sections the Settings screen draws; absent outside it, where the workbench's own is used. */
export const SettingsRegistryContext = createContext<ExtensionRegistry | undefined>(undefined);

const noSubscription = () => () => undefined;

/**
 * The sections other extensions attached to a page (`registerSettingsSection({
 * page })`), in `order`; the ones that name a `card` are the page's own to
 * place. A page of an extension's own draws them where they belong, once for
 * the page and once with `advanced` for those that asked to sit under its
 * Advanced fold, which this draws (and leaves out when none asked); core's
 * pages draw theirs the same way (API 1.61.0).
 */
export function SettingsPageSections({ page, advanced = false, onNotify, onChanged = () => undefined, onOpenSettings, cwd }: {
  /** The id of the page the sections joined. */
  page: SettingsSectionPage;
  /** Draw the sections that asked to sit under the page's Advanced fold, in a fold of their own, instead of the others. */
  advanced?: boolean;
  onNotify(message: string, level?: "info" | "warning" | "error"): void;
  /** Reads the page's own data again, after a section changed something it shows. */
  onChanged?(): void;
  /** Opens another place in Settings, as the page's own `onOpenSettings` does. */
  onOpenSettings?(target: string): void;
  cwd?: string | undefined;
}) {
  const provided = useContext(SettingsRegistryContext);
  const shell = useContext(WorkbenchShellContext);
  const registry = provided ?? shell?.registry;
  useSyncExternalStore(registry?.subscribe ?? noSubscription, registry?.getVersion ?? (() => 0));
  const sections = registry?.getSettingsSections(page).filter((section) => !section.card && Boolean(section.advanced) === advanced) ?? [];
  if (sections.length === 0) return null;
  const drawn = sections.map(({ id, Component }) => <Component key={id} {...(cwd ? { cwd } : {})} {...(onOpenSettings ? { onOpenSettings } : {})} onNotify={onNotify} onChanged={onChanged} />);
  return advanced ? <SettingsAdvanced>{drawn}</SettingsAdvanced> : <>{drawn}</>;
}
