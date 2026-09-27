import { Package, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState, type ComponentType } from "react";
import {
  Button,
  DangerAction,
  DangerZone,
  SegmentedControl,
  SettingRow,
  SettingsSection,
  errorMessage,
  type DesktopExtension,
  type ExtensionInspection,
  type HostExtensionClient,
  type SettingsPageProps,
  type SettingsSectionProps,
  type WorkbenchActions,
} from "tau";
import { PACKAGES_EXTENSION_ID, PACKAGES_SETTINGS_PAGE, parseInstallArguments, type PackageRow } from "./protocol.js";

/** What a command of the host half answers with. */
interface PackagesCommandResult {
  message?: string;
}

type Inspect = (cwd: string) => Promise<ExtensionInspection>;

interface PageServices {
  host: HostExtensionClient;
  inspect: Inspect;
}

/**
 * Settings page of `tau.packages`: Pi's install verbs with a form, above the
 * two sets Tau runs — the kits it ships, which need no approval, and the
 * packages a source installed, which do. Installing never activates a package.
 */
export function PackagesPage({ cwd, onNotify, host, inspect }: SettingsPageProps & PageServices) {
  const [source, setSource] = useState("");
  const [scope, setScope] = useState<"global" | "project">("global");
  const [packages, setPackages] = useState<PackageRow[]>();
  const [inspection, setInspection] = useState<ExtensionInspection>();
  const [busy, setBusy] = useState<string>();
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const result = await host.invoke("list") as { packages: PackageRow[] };
      setPackages(result.packages);
      setError(undefined);
    } catch (failure) {
      setPackages([]);
      setError(errorMessage(failure));
    }
    if (cwd) await inspect(cwd).then(setInspection).catch(() => undefined);
  }, [cwd, host, inspect]);

  useEffect(() => { void refresh(); }, [refresh]);

  // The host half reports one line per step of a long command.
  useEffect(() => {
    const offProgress = host.onEvent("progress", (payload) => {
      const message = (payload as { message?: string } | undefined)?.message;
      if (message) setLog((lines) => [...lines.slice(-8), message]);
    });
    const offChanged = host.onEvent("changed", () => { void refresh(); });
    return () => { offProgress(); offChanged(); };
  }, [host, refresh]);

  const run = async (label: string, command: string, input: unknown) => {
    setBusy(label);
    setLog([]);
    setError(undefined);
    try {
      const result = await host.invoke(command, input) as PackagesCommandResult;
      onNotify(result.message ?? "Done.");
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(undefined);
    }
  };

  const bundled = (inspection?.packages ?? []).filter((entry) => entry.scope === "bundled");
  const summaryOf = (id: string | undefined) => id ? inspection?.packages.find((entry) => entry.id === id) : undefined;
  // What the package is, in one word: a theme brings only a stylesheet.
  const kindOf = (id: string | undefined) => summaryOf(id)?.theme ? "Theme" : undefined;

  return (
    <div className="settings-page">
      <h3>Packages</h3>
      <p className="lede">
        Install extension packages the way Pi does: <code>npm:&lt;package&gt;</code>, <code>git:&lt;url&gt;</code> or a folder on this machine.
        An install never starts a package: approve its permissions on its own page, and both halves start there and then.
      </p>

      <SettingsSection title="Install from a source" plain>
        <form
          className="packages-form"
          onSubmit={(event) => { event.preventDefault(); if (source.trim()) void run("install", "install", { source: source.trim(), scope }); }}
        >
          <input
            type="text"
            value={source}
            placeholder="npm:@acme/hello, git:https://example.com/acme/hello.git, or /path/to/folder"
            aria-label="Package source"
            spellCheck={false}
            onChange={(event) => setSource(event.target.value)}
          />
          <Button type="submit" variant="primary" disabled={!source.trim()} busy={busy !== undefined}>
            {busy === "install" ? "Installing…" : "Install"}
          </Button>
        </form>

        <div className="packages-scope">
          <SegmentedControl label="Install for" value={scope} options={[{ value: "global", label: "Every project" }, { value: "project", label: "This project only" }]} onChange={(next) => setScope(next === "project" ? "project" : "global")} />
        </div>

        {log.length > 0 ? (
          <div className="packages-log" aria-label="Install progress">
            {log.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Installed" plain headerAction={
        <button type="button" className="text-button" disabled={busy !== undefined || !packages?.length} onClick={() => void run("update", "update", {})}>
          {busy === "update" ? "Updating…" : "Check every source for updates"}
        </button>
      }>
        {packages && packages.length > 0 ? (
          <table className="inspector-table" aria-label="Installed packages">
            <thead><tr><th>Package</th><th>Scope</th><th>Signature</th><th>Source</th><th /></tr></thead>
            <tbody>
              {packages.map((entry) => {
                const granted = summaryOf(entry.id)?.granted;
                const kind = kindOf(entry.id);
                return (
                  <tr key={`${entry.scope}:${entry.source}`} data-extension-id={entry.id}>
                    <td>
                      <strong>{entry.name ?? entry.id ?? "unreadable package"}{kind ? <em className="package-kind">{kind}</em> : null}</strong>
                      <small>{entry.id ?? entry.directory}{entry.version ? ` · ${entry.version}` : ""}</small>
                    </td>
                    <td>{entry.scope === "global" ? "every project" : "this project"}</td>
                    <td>{entry.error ?? entry.signatureLabel}</td>
                    <td><code title={entry.directory}>{entry.source}</code></td>
                    <td className="packages-actions">
                      <button type="button" disabled={busy !== undefined} onClick={() => void run("update", "update", { source: entry.source })}>Update</button>
                      <button type="button" disabled={busy !== undefined} onClick={() => void run("remove", "remove", { source: entry.source, scope: entry.scope })}>Remove</button>
                      {granted === false ? <small>waiting for approval</small> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : packages ? (
          <div className="settings-note">No package source is installed. Packages you copied into the extension folders by hand are listed in the Inspector.</div>
        ) : (
          <div className="settings-note">Reading the package list…</div>
        )}
      </SettingsSection>

      <div className="settings-note">
        The kits Tau ships{inspection?.distribution ? ` (${inspection.distribution.name} ${inspection.distribution.version}, ${bundled.length} kits)` : ""} are listed under Settings → Extensions with every installed package; each has a page there to turn it off, see what it may do and, for a package, update or remove it.
      </div>

      {error ? <div className="settings-note" data-level="error">{error}</div> : null}
      <div className="settings-note">
        An npm source installs into <code>~/.tau/npm</code>, a Git source is cloned shallowly into <code>~/.tau/git</code>, and a folder path
        is loaded where it lies. The list of sources is <code>~/.tau/packages.json</code>, or the project's own <code>.tau/packages.json</code>.
        A package may carry a <code>tau-extension.sig</code>; a file that no longer matches its signed hash refuses to load.
      </div>
    </div>
  );
}

/**
 * On an installed extension's own page (Settings → Extensions → it): the
 * source it came from, Update, and Remove behind a confirmation. Nothing for
 * a kit Tau ships or a folder no source put there.
 */
export function createExtensionSection(host: HostExtensionClient): ComponentType<SettingsSectionProps> {
  return function PackageSourceSection({ extensionId, onNotify, onChanged }: SettingsSectionProps) {
    const [row, setRow] = useState<PackageRow | null>();
    const [busy, setBusy] = useState<"update" | "remove">();
    useEffect(() => {
      let live = true;
      host.invoke("list").then((result) => {
        if (live) setRow((result as { packages: PackageRow[] }).packages.find((entry) => entry.id === extensionId) ?? null);
      }, () => { if (live) setRow(null); });
      return () => { live = false; };
    }, [extensionId]);
    if (!row) return null;
    const run = async (verb: "update" | "remove", input: unknown) => {
      setBusy(verb);
      try {
        const result = await host.invoke(verb, input) as PackagesCommandResult;
        onNotify(result.message ?? "Done.");
        onChanged();
      } catch (failure) {
        onNotify(errorMessage(failure));
      } finally {
        setBusy(undefined);
      }
    };
    const name = row.name ?? row.id ?? row.source;
    return (
      <>
        <SettingsSection title="Package">
          <SettingRow
            title="Installed from"
            description={row.scope === "global" ? "For every project." : "For this project only."}
            status={<code className="settings-value">{row.source}</code>}
            control={<Button icon={<RefreshCw size={13} />} busy={busy === "update"} disabled={busy !== undefined} onClick={() => void run("update", { source: row.source })}>{busy === "update" ? "Updating…" : "Update"}</Button>}
          />
        </SettingsSection>
        <DangerZone>
          <DangerAction
            title={`Remove ${name}`}
            description="Deletes the package and forgets its source. Its settings stay in the config, so installing it again brings them back."
            actionLabel="Remove…"
            busy={busy === "remove"}
            confirmTitle={`Remove ${name}?`}
            confirmMessage={<>{name} is deleted {row.scope === "global" ? "for every project" : "from this project"} and its source forgotten. Install it again from <code>{row.source}</code> to get it back.</>}
            onConfirm={() => void run("remove", { source: row.source, scope: row.scope })}
          />
        </DangerZone>
      </>
    );
  };
}

/**
 * The desktop half of `tau.packages`: Pi's own verbs in the composer, and the
 * Settings page they share with the two sets Tau runs.
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

    plugin.registerSettingsPage({
      id: PACKAGES_SETTINGS_PAGE,
      label: "Packages",
      group: "extensions",
      profiles: ["desktop", "web"],
      Icon: Package,
      order: 30,
      Component: (props: SettingsPageProps) => (
        <PackagesPage {...props} host={plugin.host} inspect={(cwd) => plugin.inspectPackages(cwd)} />
      ),
    });

    plugin.registerSettingsSection({ id: "packages.extension", page: "extension", profiles: ["desktop", "web"], Component: createExtensionSection(plugin.host) });

    plugin.registerCommand({
      id: "packages.install",
      label: "Install extension…",
      group: "Extensions",
      access: "write",
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

export default packagesExtension;
