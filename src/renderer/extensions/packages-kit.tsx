import type { DesktopExtension, WorkbenchActions } from "../extension-system";
import { errorMessage } from "../error-message";

export const PACKAGES_EXTENSION_ID = "tau.packages";
/** Settings page of the installer; the modal renders its own form for this id. */
export const PACKAGES_SETTINGS_PAGE = "packages";

/** What a command of the host half answers with. */
export interface PackagesCommandResult {
  message?: string;
}

/** `<source> [--local]`, the flag Pi spells `-l`. */
export function parseInstallArguments(args: string): { source: string; scope: "global" | "project" } {
  const words = args.trim().split(/\s+/u).filter(Boolean);
  const local = words.some((word) => word === "-l" || word === "--local" || word === "--project");
  const source = words.filter((word) => !word.startsWith("-")).join(" ");
  return { source, scope: local ? "project" : "global" };
}

/**
 * The desktop half of `tau.packages`: Pi's own verbs in the composer, and the
 * command that opens the install form in Settings.
 */
export const packagesExtension: DesktopExtension = {
  id: PACKAGES_EXTENSION_ID,
  name: "Packages",
  activate(plugin) {
    const report = async (actions: WorkbenchActions, work: Promise<unknown>): Promise<string | undefined> => {
      try {
        const result = await work as PackagesCommandResult | undefined;
        actions.notify(result?.message ?? "Done.");
        return undefined;
      } catch (error) {
        return errorMessage(error);
      }
    };

    plugin.registerCommand({
      id: "packages.install",
      label: "Install extension…",
      group: "Extensions",
      run: (app) => app.openSettings(PACKAGES_SETTINGS_PAGE),
    });

    plugin.registerSlashCommand({
      name: "install",
      description: "Install an extension package from npm:, git: or a folder",
      argumentHint: "<source> [--local]",
      run: (args, actions) => {
        const { source, scope } = parseInstallArguments(args);
        if (!source) return "Name a source: npm:<package>, git:<url> or a folder path.";
        actions.notify(`Installing ${source}…`);
        return report(actions, plugin.host.invoke("install", { source, scope }));
      },
    });

    plugin.registerSlashCommand({
      name: "remove",
      description: "Remove an installed extension package",
      argumentHint: "<source> [--local]",
      run: (args, actions) => {
        const { source, scope } = parseInstallArguments(args);
        if (!source) return "Name the source to remove, as it is listed by /update.";
        return report(actions, plugin.host.invoke("remove", { source, scope }));
      },
    });

    plugin.registerSlashCommand({
      name: "update",
      description: "Update one extension package, or every installed one",
      argumentHint: "[source]",
      run: (args, actions) => {
        const { source } = parseInstallArguments(args);
        actions.notify(source ? `Updating ${source}…` : "Updating every installed package…");
        return report(actions, plugin.host.invoke("update", source ? { source } : {}));
      },
    });
  },
};
