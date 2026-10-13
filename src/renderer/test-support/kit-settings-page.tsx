import { render } from "@testing-library/react";
import { vi } from "vitest";
import type { ComponentType } from "react";
import type { ExtensionRegistry, SettingsPageContribution, SettingsPageProps, SettingsSectionContribution, SettingsSectionProps } from "../extension-system";
import type { TauConfig } from "../../shared/contracts";
import type { HostClient } from "../../workbench/host-client";
import { settingPath, withSetting, withoutSetting } from "../../shared/config-layers";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "./fake-host-client";
import { WorkbenchShellContext } from "../workbench-context";
import { TestProviders } from "./test-providers";

/**
 * Renders a kit's Settings page, or a section it attached to another page,
 * over a host that holds `host` as this machine's config level, and records
 * what it writes and clears.
 */
export function renderKitSettingsPage(Contribution: ComponentType<SettingsPageProps> | ComponentType<SettingsSectionProps>, { host = {}, props = {}, client = {}, registry }: {
  host?: Partial<TauConfig>;
  /** The registry whose sections a page draws that other extensions attached to it. */
  registry?: ExtensionRegistry;
  props?: Partial<SettingsPageProps & SettingsSectionProps>;
  client?: Partial<HostClient>;
} = {}) {
  const Page = Contribution as ComponentType<SettingsPageProps & SettingsSectionProps>;
  const updates: Array<Partial<TauConfig>> = [];
  const cleared: string[][] = [];
  let level = host as TauConfig;
  const fake = createFakeHostClient({
    getConfigLayers: async () => ({ host: level }),
    updateConfig: async (patch: Partial<TauConfig>) => {
      updates.push(patch);
      for (const [key, value] of Object.entries(patch)) {
        level = settingPath(`${key}.`)[1] === undefined ? withSetting(level, key, value) : Object.entries(value as object).reduce((next, [entry, inner]) => withSetting(next, `${key}.${entry}`, inner), level);
      }
      return level;
    },
    clearConfig: async (keys: readonly string[]) => {
      cleared.push([...keys]);
      level = keys.reduce(withoutSetting, level);
      return { host: level };
    },
    ...client,
  });
  const onNotify = vi.fn();
  const page = <Page onNotify={onNotify} onChanged={vi.fn()} {...props} />;
  const view = render(<TestProviders><HostClientProvider client={fake}>{registry ? <WorkbenchShellContext.Provider value={{ registry }}>{page}</WorkbenchShellContext.Provider> : page}</HostClientProvider></TestProviders>);
  return { ...view, updates, cleared, onNotify, client: fake };
}

/** The `rows` a page names for the search that have no element with their id on screen. */
export function missingSettingsRows(page: Pick<SettingsPageContribution | SettingsSectionContribution, "rows">): string[] {
  return (page.rows ?? []).map((row) => row.id).filter((id) => !document.getElementById(id));
}
