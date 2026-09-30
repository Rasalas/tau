import { Package, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState, type ComponentType } from "react";
import {
  Badge,
  Button,
  ConfirmDialog,
  DangerAction,
  DangerZone,
  SegmentedControl,
  SettingRow,
  SettingsSection,
  SettingsState,
  TextField,
  errorMessage,
  tooltipProps,
  type DesktopExtension,
  type ExtensionInspection,
  type HostExtensionClient,
  type RegionProps,
  type SettingsPageProps,
  type SettingsSectionProps,
  type WorkbenchActions,
} from "tau";
import { DevelopSection } from "./develop.js";
import { PACKAGES_EXTENSION_ID, PACKAGES_SETTINGS_PAGE, parseInstallArguments, type PackageRow } from "./protocol.js";

/** What a command of the host half answers with. */
interface PackagesCommandResult {
  message?: string;
  /** `install`: the package it installed. */
  installed?: PackageRow;
  /** `install`: Pi does not trust the project the package was installed for. */
  untrusted?: boolean;
}

/** Installs this window runs; their own caller raises the toast, so the host's event does not. */
let ownInstalls = 0;
async function ownInstall<T>(work: Promise<T>): Promise<T> {
  ownInstalls += 1;
  try { return await work; } finally { ownInstalls -= 1; }
}

/**
 * The install toast for installs this window did not start: `tau kit new
 * --install`, another window. One that lands while no thread is on screen
 * waits for the next.
 */
export function followInstalls(host: HostExtensionClient): { bind(actions: WorkbenchActions): () => void } {
  let bound: WorkbenchActions | undefined;
  const waiting: PackagesCommandResult[] = [];
  host.onEvent("changed", (payload) => {
    const event = payload as { command?: string; result?: PackageRow; untrusted?: boolean } | undefined;
    if (event?.command !== "install" || !event.result || ownInstalls > 0) return;
    const result = { installed: event.result, ...(event.untrusted ? { untrusted: true } : {}) };
    if (bound) announceInstall(host, bound, result);
    else waiting.push(result);
  });
  return {
    bind(actions) {
      bound = actions;
      for (const result of waiting.splice(0)) announceInstall(host, actions, result);
      return () => { if (bound === actions) bound = undefined; };
    },
  };
}

/** Why a scan left a project's packages off, when it was Pi's trust. */
export function untrustedSkips(inspection: ExtensionInspection | undefined): ExtensionInspection["skipped"] {
  return (inspection?.skipped ?? []).filter((skip) => skip.untrustedProject);
}

type Inspect = (cwd: string) => Promise<ExtensionInspection>;

interface PageServices {
  host: HostExtensionClient;
  inspect: Inspect;
}

/** What the Settings search finds on the Packages page; each id is a row's anchor. */
export const PACKAGES_ROWS = [
  { id: "setting-packages-source", label: "Install from a source", keywords: ["install", "npm", "git", "folder", "package", "extension"] },
  { id: "setting-packages-scope", label: "Install for", keywords: ["global", "project", "every project", "this project only", "local"] },
  { id: "setting-packages-installed", label: "Installed packages", keywords: ["update", "remove", "uninstall", "sources", "signature"] },
  { id: "setting-packages-develop", label: "Develop a package", keywords: ["develop", "build", "error", "compile", "kit new", "scaffold", "types", "reload"] },
];

const SOURCE_HELP = "An npm source installs into ~/.tau/npm, a Git source is cloned shallowly into ~/.tau/git, and a folder is loaded where it lies. "
  + "The sources are listed in ~/.tau/packages.json, or the project's own .tau/packages.json. A package may carry a tau-extension.sig; "
  + "a file that no longer matches its signed hash refuses to load.";

/**
 * Settings page of `tau.packages`: Pi's install verbs with a form, above the
 * packages a source installed. Installing never activates a package.
 */
export function PackagesPage({ cwd, onNotify, onOpenSettings, host, inspect }: SettingsPageProps & PageServices) {
  const [source, setSource] = useState("");
  const [scope, setScope] = useState<"global" | "project">("global");
  const [packages, setPackages] = useState<PackageRow[]>();
  const [inspection, setInspection] = useState<ExtensionInspection>();
  const [busy, setBusy] = useState<string>();
  const [log, setLog] = useState<string[]>([]);
  const [listError, setListError] = useState<string>();
  const [failure, setFailure] = useState<{ verb: string; message: string }>();
  const [removing, setRemoving] = useState<PackageRow>();

  const refresh = useCallback(async () => {
    try {
      const result = await host.invoke("list") as { packages: PackageRow[] };
      setPackages(result.packages);
      setListError(undefined);
    } catch (reason) {
      setPackages([]);
      setListError(errorMessage(reason));
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
    setFailure(undefined);
    try {
      const work = host.invoke(command, input) as Promise<PackagesCommandResult>;
      const result = await (command === "install" ? ownInstall(work) : work);
      onNotify(result.message ?? "Done.");
      if (label === "install") setSource("");
      await refresh();
    } catch (reason) {
      setFailure({ verb: label, message: errorMessage(reason) });
    } finally {
      setBusy(undefined);
    }
  };
  const install = () => { if (source.trim() && !busy) void run("install", "install", { source: source.trim(), scope }); };

  const bundled = (inspection?.packages ?? []).filter((entry) => entry.scope === "bundled");
  const untrusted = untrustedSkips(inspection);
  const untrustedProject = untrusted[0]?.untrustedProject;
  const skippedNames = [...new Set(untrusted.flatMap((skip) => (skip.packages ?? []).map((entry) => entry.name)))];
  const summaryOf = (id: string | undefined) => id ? inspection?.packages.find((entry) => entry.id === id) : undefined;
  const nameOf = (entry: PackageRow) => entry.name ?? entry.id ?? entry.source;
  const failed = (verb: string) => failure?.verb === verb ? <p className="packages-failure" role="alert">{failure.message}</p> : null;
  const busyReason = busy ? "Wait until the running install, update or removal ends." : undefined;

  return (
    <div className="settings-page packages-page">
      <h3>Packages</h3>

      <SettingsSection title="Install">
        <SettingRow
          id="setting-packages-source"
          title="Install from a source"
          description={<><code>npm:&lt;package&gt;</code>, <code>git:&lt;url&gt;</code> or a folder on this machine.</>}
          help={SOURCE_HELP}
          control={(
            <form className="packages-form" aria-label="Install a package" onSubmit={(event) => { event.preventDefault(); install(); }}>
              <TextField
                label="Package source"
                value={source}
                width="full"
                mono
                placeholder="npm:@acme/hello or /path/to/folder"
                disabled={busy !== undefined}
                error={failure?.verb === "install" ? failure.message : undefined}
                onChange={(text) => { setSource(text); if (failure?.verb === "install") setFailure(undefined); }}
              />
              <span {...tooltipProps(!source.trim() && !busy ? "Enter a source to install from." : undefined)}>
                <Button type="submit" variant="primary" disabled={!source.trim()} busy={busy === "install"}>
                  {busy === "install" ? "Installing…" : "Install"}
                </Button>
              </span>
            </form>
          )}
        >
          {log.length > 0 ? (
            <div className="packages-log" aria-label="Install progress" aria-live="polite">
              {log.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}
            </div>
          ) : null}
        </SettingRow>
        <SettingRow
          id="setting-packages-scope"
          title="Install for"
          description="Every project lists the source in ~/.tau/packages.json, This project only in the project's .tau/packages.json."
          control={<SegmentedControl label="Install for" value={scope} disabled={busy !== undefined} options={[{ value: "global", label: "Every project" }, { value: "project", label: "This project only" }]} onChange={(next) => setScope(next === "project" ? "project" : "global")} />}
        />
      </SettingsSection>

      {untrustedProject ? (
        <SettingsSection title="Skipped">
          <SettingRow
            id="setting-packages-trust"
            title={<>{skippedNames.length > 0 ? skippedNames.join(", ") : "This project's packages"} <Badge tone="warn">Skipped: project not trusted</Badge></>}
            description={<>Pi does not trust <code>{untrustedProject}</code>, so the packages in its <code>.tau</code> folder stay off. Trusting it records your answer in Pi's <code>trust.json</code>, as Pi's <code>/trust</code> does; each package still waits for your approval.</>}
            status={failed("trust")}
            control={(
              <span {...tooltipProps(busy ? busyReason : undefined)}>
                <Button variant="primary" busy={busy === "trust"} disabled={busy !== undefined} onClick={() => void run("trust", "trust", { cwd: untrustedProject })}>
                  {busy === "trust" ? "Trusting…" : "Trust this project"}
                </Button>
              </span>
            )}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection title="Installed" id="setting-packages-installed" plain={!packages?.length} headerAction={packages?.length ? (
        <Button variant="ghost" icon={<RefreshCw size={13} />} busy={busy === "update-all"} disabled={busy !== undefined} onClick={() => void run("update-all", "update", {})}>
          {busy === "update-all" ? "Updating…" : "Check every source for updates"}
        </Button>
      ) : undefined}>
        {listError ? (
          <SettingsState kind="error" title="The package list did not load" description={listError} onRetry={() => void refresh()} />
        ) : packages === undefined ? (
          <SettingsState kind="loading" title="Reading the package list" rows={2} />
        ) : packages.length === 0 ? (
          <SettingsState kind="empty" title="No package source is installed" description="Install one above. Packages copied into the extension folders by hand are listed under Settings → Extensions." />
        ) : packages.map((entry) => {
          const name = nameOf(entry);
          const theme = summaryOf(entry.id)?.theme;
          const waiting = summaryOf(entry.id)?.granted === false;
          const skipped = entry.scope === "project" && untrustedProject !== undefined;
          return (
            <SettingRow
              key={`${entry.scope}:${entry.source}`}
              title={<>{name}{theme ? <> <Badge>Theme</Badge></> : null}{skipped ? <> <Badge tone="warn">Skipped: project not trusted</Badge></> : waiting ? <> <Badge tone="warn">Waiting for approval</Badge></> : null}</>}
              description={[entry.id ?? entry.directory, entry.version, entry.scope === "global" ? "every project" : "this project", entry.error ?? entry.signatureLabel].filter(Boolean).join(" · ")}
              status={<><code className="settings-value" {...tooltipProps(entry.directory, { variant: "code" })}>{entry.source}</code>{failed(`update:${entry.source}`)}{failed(`remove:${entry.source}`)}</>}
              control={<>
                {waiting && entry.id && onOpenSettings ? <Button variant="primary" aria-label={`Review ${name}`} onClick={() => onOpenSettings(`extensions/${entry.id}`)}>Review</Button> : null}
                <span {...tooltipProps(busy ? busyReason : undefined)}>
                  <Button aria-label={`Update ${name}`} busy={busy === `update:${entry.source}`} disabled={busy !== undefined} onClick={() => void run(`update:${entry.source}`, "update", { source: entry.source })}>
                    {busy === `update:${entry.source}` ? "Updating…" : "Update"}
                  </Button>
                </span>
                <span {...tooltipProps(busy ? busyReason : undefined)}>
                  <Button variant="ghost" aria-label={`Remove ${name}…`} busy={busy === `remove:${entry.source}`} disabled={busy !== undefined} onClick={() => setRemoving(entry)}>Remove…</Button>
                </span>
              </>}
            />
          );
        })}
      </SettingsSection>
      {failed("update-all")}

      <DevelopSection host={host} nameOf={(id) => packages?.find((entry) => entry.id === id)?.name ?? summaryOf(id)?.name} onNotify={onNotify} />

      <p className="settings-footnote">
        The kits Tau ships{inspection?.distribution ? ` (${inspection.distribution.name} ${inspection.distribution.version}, ${bundled.length} kits)` : ""} are listed under Settings → Extensions with every installed package; each has a page there to turn it off and see what it may do.
      </p>

      {removing ? (
        <ConfirmDialog
          title={`Remove ${nameOf(removing)}?`}
          message={<>{nameOf(removing)} is deleted {removing.scope === "global" ? "for every project" : "from this project"} and its source forgotten. Install it again from <code>{removing.source}</code> to get it back.</>}
          confirmLabel="Remove"
          destructive
          onCancel={() => setRemoving(undefined)}
          onConfirm={() => { const entry = removing; setRemoving(undefined); void run(`remove:${entry.source}`, "remove", { source: entry.source, scope: entry.scope }); }}
        />
      ) : null}
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
 * The toast after an install: where the package waits for approval, or that
 * Pi's project trust skips it, with the button that answers either.
 */
export function announceInstall(host: HostExtensionClient, actions: WorkbenchActions, result: PackagesCommandResult): void {
  const name = result.installed?.name ?? result.installed?.id ?? result.installed?.source ?? "The package";
  if (!actions.toast) {
    actions.notify(result.message ?? `Installed ${name}.`);
    return;
  }
  if (result.untrusted) {
    actions.toast({
      type: "warning",
      title: `${name}: skipped, project not trusted`,
      description: "Pi does not trust this project, so the packages installed for it stay off.",
      timeoutMs: 15_000,
      actions: [{
        label: "Trust this project",
        run: () => {
          host.invoke("trust", {}).then(
            (answer) => actions.notify((answer as PackagesCommandResult).message ?? "Trusted."),
            (error: unknown) => actions.notify(errorMessage(error)),
          );
        },
      }],
    });
    return;
  }
  actions.toast({
    type: "success",
    title: `Installed ${name}`,
    description: "It waits for your approval in Settings → Extensions.",
    actions: [{ label: "Review", run: () => actions.openSettings(result.installed?.id ? `extensions/${result.installed.id}` : "extensions") }],
  });
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
      description: "Install, update and remove extension packages the way Pi does. An install never starts a package until you approve it in Settings → Extensions.",
      group: "extensions",
      profiles: ["desktop", "web"],
      Icon: Package,
      order: 30,
      rows: PACKAGES_ROWS,
      Component: (props: SettingsPageProps) => (
        <PackagesPage {...props} host={plugin.host} inspect={(cwd) => plugin.inspectPackages(cwd)} />
      ),
    });

    const installs = followInstalls(plugin.host);
    plugin.registerRegion({
      id: "packages.install-toasts",
      placement: "composer-above",
      order: 90,
      profiles: ["desktop", "web"],
      Component: function InstallToasts({ actions }: RegionProps) {
        useEffect(() => installs.bind(actions), [actions]);
        return null;
      },
    });

    plugin.registerSettingsSection({ id: "packages.extension", page: "extension", profiles: ["desktop", "web"], Component: createExtensionSection(plugin.host) });

    plugin.registerCommand({
      id: "packages.install",
      label: "Install extension…",
      group: "Extensions",
      access: "write",
      run: (app) => app.openSettings(PACKAGES_SETTINGS_PAGE),
    });

    // What a package author wants from /reload, without rebuilding Tau from its source.
    plugin.registerCommand({
      id: "packages.rebuild",
      label: "Rebuild extension packages",
      group: "Extensions",
      access: "write",
      run: async (app) => {
        const failure = await report(app, plugin.host.invoke("rebuild"));
        if (failure) app.notify(failure);
      },
    });

    plugin.registerSlashCommand({
      name: "install",
      description: "Install an extension package from npm:, git: or a folder",
      argumentHint: "<source> [--local]",
      run: async (args, actions) => {
        const { source, scope } = parseInstallArguments(args);
        if (!source) return "Name a source: npm:<package>, git:<url> or a folder path.";
        actions.notify(`Installing ${source}…`);
        try {
          announceInstall(plugin.host, actions, await ownInstall(plugin.host.invoke("install", { source, scope })) as PackagesCommandResult);
          return undefined;
        } catch (error) {
          return errorMessage(error);
        }
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
