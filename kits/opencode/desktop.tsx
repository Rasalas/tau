import { Suspense, lazy, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { CircleCheck, RefreshCw, SquareTerminal, TriangleAlert } from "lucide-react";
import {
  DEFAULT_INSTANCE_ID,
  isRuntimeInstanceOf,
  loadRuntimeInstanceUi,
  loadRuntimeUpdateToasts,
  runtimeInstanceId,
  updateAvailable,
  useWorkbenchShell,
  type DesktopExtension,
  type HostExtensionClient,
  type RegionProps,
  type RuntimeInstanceConfig,
  type RuntimeToolVersion,
  type RuntimeUpdateToasts,
  type SettingsPageProps,
  type WorkbenchActions,
} from "tau";
import {
  INSTANCES_EVENT,
  MIN_OPENCODE_VERSION,
  OPENCODE_BACKEND_KIND,
  OPENCODE_HOME_VARIABLE,
  OPENCODE_HOST_EXTENSION_ID,
  type OpenCodeInstanceView,
  type OpenCodeInstancesReport,
  type OpenCodeStatusReport,
} from "./protocol.js";

const TERMINAL_HOST_EXTENSION_ID = "tau.terminal";
/** Terminal Kit's desktop service (`kits/terminal/protocol.ts`), named here: a kit never imports another. */
const TERMINAL_RUN_SERVICE = "tau.terminal/run";
interface TerminalRunService {
  run(request: { command: string; label?: string }, actions?: WorkbenchActions): Promise<{ id: string; exitCode?: number }>;
}
const TERMINAL_PANEL = "terminal";

const InstanceSetup = lazy(() => loadRuntimeInstanceUi().then((module) => ({ default: module.RuntimeInstanceSetup })));
const VersionBanner = lazy(() => loadRuntimeInstanceUi().then((module) => ({ default: module.RuntimeVersionBanner })));

/** Names the runtime behind an OpenCode thread, on any instance; other threads show nothing. */
export function OpenCodeStatus({ snapshot }: RegionProps) {
  if (!isRuntimeInstanceOf(snapshot?.backendKind, OPENCODE_BACKEND_KIND)) return null;
  const model = snapshot?.model;
  const label = snapshot?.runtimeBackends?.find((backend) => backend.kind === snapshot.backendKind)?.label ?? "OpenCode";
  return <span className="status-item" title={`This thread runs OpenCode through its server${model ? ` on ${model.provider}/${model.id}` : ""}.`}><SquareTerminal size={12} /> {label}</span>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useShellActions(): WorkbenchActions | undefined {
  try {
    return useWorkbenchShell().actions;
  } catch {
    return undefined;
  }
}

/** Types a command into a new Terminal Kit shell without pressing Enter; without Terminal Kit it is copied. */
export async function typeIntoTerminal(terminal: HostExtensionClient, actions: WorkbenchActions | undefined, command: string): Promise<"terminal" | "copied"> {
  try {
    const workspaceId = actions?.activeThread()?.workspaceId;
    const session = await terminal.invoke("open", { ...(workspaceId ? { workspaceId } : {}), label: "OpenCode" }) as { id: string };
    await terminal.invoke("input", { id: session.id, data: command });
    actions?.openPanel(TERMINAL_PANEL);
    return "terminal";
  } catch {
    await (actions?.copyText(command) ?? navigator.clipboard?.writeText(command));
    return "copied";
  }
}

/** The executable's path, saved when the field is left or Enter is pressed; empty goes back to the PATH. */
function CommandPathField({ status, onSave }: { status: OpenCodeStatusReport | undefined; onSave(command: string): Promise<void> }) {
  const saved = status?.commandSource === "setting" ? status.command : "";
  const [draft, setDraft] = useState(saved);
  useEffect(() => { setDraft(saved); }, [saved]);
  const fromEnv = status?.commandSource === "env";
  const commit = () => { if (draft.trim() !== saved) void onSave(draft.trim()); };
  return (
    <>
      <input
        className="settings-search-input opencode-path"
        aria-label="OpenCode executable"
        value={fromEnv ? status!.command : draft}
        placeholder="opencode, from your login shell's PATH"
        disabled={fromEnv || !status}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") commit(); }}
      />
      <p className="settings-note">{fromEnv ? <>Set by <code>TAU_OPENCODE_COMMAND</code> in Tau's environment.</> : <>A name on the PATH or an absolute path; leave it empty to find <code>opencode</code> on the PATH.</>}</p>
    </>
  );
}

/**
 * The server an instance connects to instead of starting one (T3 Code's
 * Server URL and password). The password field stays empty: a saved one is
 * never sent back, and leaving the field empty keeps it.
 */
export function ServerFields({ view, onSave }: { view: OpenCodeInstanceView | undefined; onSave(url: string, password?: string): Promise<void> }) {
  const saved = view?.serverUrl ?? "";
  const [url, setUrl] = useState(saved);
  const [password, setPassword] = useState("");
  useEffect(() => { setUrl(saved); }, [saved]);
  const dirty = url.trim() !== saved || password !== "";
  const save = () => { if (dirty) void onSave(url.trim(), password || undefined).then(() => setPassword("")); };
  return (
    <div className="opencode-server">
      <input
        className="settings-search-input opencode-path"
        aria-label="OpenCode server URL"
        value={url}
        placeholder="Empty: Tau starts OpenCode itself"
        disabled={!view}
        onChange={(event) => setUrl(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") save(); }}
      />
      <input
        className="settings-search-input opencode-path"
        aria-label="OpenCode server password"
        type="password"
        value={password}
        placeholder={view?.hasPassword ? "Saved; type to replace it" : "Password, if the server has one"}
        disabled={!view || !url.trim()}
        onChange={(event) => setPassword(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") save(); }}
      />
      <div className="opencode-server-actions">
        <button className="opencode-action" disabled={!dirty} onClick={save}>Save</button>
        {view?.hasPassword ? <button className="opencode-action" onClick={() => void onSave(url.trim(), "")}>Forget password</button> : null}
      </div>
      <p className="settings-note">
        {saved
          ? <>Threads use the server at <code>{saved}</code> with its own providers and logins. Tau's tools reach only servers Tau starts.</>
          : <>Leave the URL empty and Tau starts <code>opencode serve</code> for each thread, on 127.0.0.1 with a password of its own.</>}
      </p>
    </div>
  );
}

export class OpenCodeInstances {
  private report: OpenCodeInstancesReport = { instances: [] };
  private readonly listeners = new Set<() => void>();

  get snapshot(): OpenCodeInstancesReport { return this.report; }

  set(report: OpenCodeInstancesReport): void {
    this.report = report;
    for (const listener of [...this.listeners]) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
}

function isReport(value: unknown): value is OpenCodeInstancesReport {
  return Boolean(value && typeof value === "object" && Array.isArray((value as OpenCodeInstancesReport).instances));
}

export interface OpenCodeProviderCardProps extends SettingsPageProps {
  host: HostExtensionClient;
  instance?: string;
  instances?: OpenCodeInstances;
  terminal?: HostExtensionClient;
}

const EMPTY_REPORT: OpenCodeInstancesReport = { instances: [] };
const noSubscription = () => () => undefined;

/**
 * One OpenCode instance's card on the Providers page: the CLI (or the server
 * it connects to), its version, the providers OpenCode can reach, and how the
 * instance is set up. Logins stay OpenCode's: `opencode auth login`.
 */
export function OpenCodeProviderCard({ host, onNotify, instance = DEFAULT_INSTANCE_ID, instances, terminal }: OpenCodeProviderCardProps) {
  const [status, setStatus] = useState<OpenCodeStatusReport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const actions = useShellActions();
  const report = useSyncExternalStore(instances?.subscribe ?? noSubscription, () => instances?.snapshot ?? EMPTY_REPORT);
  const isDefault = instance === DEFAULT_INSTANCE_ID;
  const scope = isDefault ? {} : { instance };
  const view = report.instances.find((entry) => entry.id === instance);

  const read = useCallback(async (fresh: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      setStatus(await host.invoke("status", { fresh, ...(instance === DEFAULT_INSTANCE_ID ? {} : { instance }) }) as OpenCodeStatusReport);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }, [host, instance]);

  useEffect(() => { void read(false); }, [read]);

  const saveCommand = async (command: string) => {
    setError(undefined);
    try {
      await host.invoke("set-command", { command, ...scope });
      onNotify(command ? `OpenCode runs from ${command}.` : "OpenCode is looked up on the PATH again.");
      await read(true);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  const saveServer = async (url: string, password?: string) => {
    setError(undefined);
    try {
      const saved = await host.invoke("set-server", { url, ...(password !== undefined ? { password } : {}), ...scope });
      if (isReport(saved)) instances?.set(saved);
      onNotify(url ? `OpenCode threads use the server at ${url}.` : "Tau starts OpenCode itself again.");
      await read(true);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  const saveInstance = async (next: RuntimeInstanceConfig) => {
    const added = !report.instances.some((entry) => entry.id === next.id);
    const saved = await host.invoke("save-instance", { instance: next });
    if (isReport(saved)) instances?.set(saved);
    onNotify(added ? `Added the OpenCode instance “${next.name ?? next.id}”.` : "Saved; the next OpenCode server of this instance uses it.");
    if (!added) await read(true);
  };

  const remove = async () => {
    const saved = await host.invoke("remove-instance", { instance });
    if (isReport(saved)) instances?.set(saved);
    onNotify(`Removed the OpenCode instance “${view?.label ?? instance}”.`);
  };

  const runCommand = async (command: string) => {
    if (!terminal) {
      await actions?.copyText(command);
      onNotify("The command is on the clipboard.");
      return;
    }
    const where = await typeIntoTerminal(terminal, actions, command);
    onNotify(where === "terminal" ? "The command is in a terminal; press Enter there to run it." : "No terminal is available; the command is on the clipboard.");
  };

  const known = status !== undefined;
  const external = Boolean(status?.serverUrl);
  const found = external || Boolean(status?.path);
  const compatibility = status?.compatibility && status.compatibility.status !== "supported" ? status.compatibility : undefined;
  const providers = status?.providers ?? [];
  const login = view?.home ? `${OPENCODE_HOME_VARIABLE}=${view.home} opencode auth login` : "opencode auth login";
  return (
    <>
      <p className="settings-note">
        {isDefault
          ? <>Threads drive OpenCode through its server, with the providers and logins in your OpenCode config. Tau reads no credential.</>
          : <>A second OpenCode setup: threads started on it keep it, with the providers and logins of its own home or server.</>}
      </p>

      <div className="settings-label">{external ? "Server" : "CLI"}</div>
      <div className="settings-field opencode-field">
        {found && !status?.unsupported && !compatibility && !status?.message ? <CircleCheck size={14} className="accent" /> : <TriangleAlert size={14} />}
        <span>
          <strong>{!known ? "Checking…" : external ? `Connected${status?.version ? ` · ${status.version}` : ""}` : found ? `Found${status?.version ? ` · ${status.version}` : ""}` : `${status.command} was not found`}</strong>
          <small>{!known ? "" : status.message ?? (external ? status.serverUrl : found ? status.path : "Install it, set its path below, or connect to a server.")}</small>
        </span>
        <button className="opencode-action" disabled={busy} onClick={() => void read(true)}>
          <RefreshCw size={13} /> {busy ? "Asking…" : "Check again"}
        </button>
      </div>
      {compatibility && status ? (
        <div className="opencode-version">
          <Suspense fallback={null}>
            <VersionBanner
              backend={{ kind: view?.kind ?? OPENCODE_BACKEND_KIND, label: view?.label ?? "OpenCode", version: { tool: "opencode", ...(status.version ? { installed: status.version } : {}), ...(status.updateCommand ? { updateCommand: status.updateCommand } : {}), compatibility } }}
              onInstall={(command) => void runCommand(command)}
              onCopy={(command) => void actions?.copyText(command)}
            />
          </Suspense>
        </div>
      ) : null}
      {!compatibility && status?.unsupported ? <p className="settings-note" data-level="error">Tau speaks to OpenCode {MIN_OPENCODE_VERSION} and newer.</p> : null}
      {!compatibility && !status?.unsupported && status?.updateAvailable ? <p className="settings-note">OpenCode {status.latest} is out. Update with <code>{status.updateCommand}</code>.</p> : null}

      <div className="settings-label">Providers</div>
      <div className="settings-field opencode-field">
        {providers.length ? <CircleCheck size={14} className="accent" /> : <TriangleAlert size={14} />}
        <span>
          <strong>{!known || (found && busy && !providers.length) ? "Checking…" : providers.length ? providers.map((provider) => provider.name).join(", ") : "No provider yet"}</strong>
          <small>{providers.length ? `${status?.models ?? 0} models; pick one and its reasoning effort per thread in the composer.` : <>Run <code>{login}</code> in a terminal to add a provider's login or key.</>}</small>
        </span>
      </div>

      <div className="settings-label">Server</div>
      <ServerFields view={view} onSave={saveServer} />

      {!external ? (
        <>
          <div className="settings-label">Path</div>
          <CommandPathField status={status} onSave={saveCommand} />
        </>
      ) : null}

      {error ? <p className="settings-note" data-level="error">{error}</p> : null}
      {view ? (
        <Suspense fallback={null}>
          <InstanceSetup
            program="OpenCode"
            homeVariable={OPENCODE_HOME_VARIABLE}
            homePlaceholder="~/.config, ~/.local/share … (OpenCode's own)"
            commandPlaceholder="opencode"
            instance={view}
            instances={report.instances}
            onSave={saveInstance}
            {...(isDefault ? {} : { onRemove: remove })}
          />
        </Suspense>
      ) : null}
    </>
  );
}

const dismissedBanners = new Set<string>();

/** Above the composer of an OpenCode thread whose version the policy calls unsafe or broken. */
export function createVersionBanner(terminal: () => HostExtensionClient) {
  return function OpenCodeVersionBanner({ snapshot, actions }: RegionProps) {
    const [, setDismissed] = useState(0);
    const kind = snapshot?.backendKind;
    if (!isRuntimeInstanceOf(kind, OPENCODE_BACKEND_KIND)) return null;
    const backend = snapshot?.runtimeBackends?.find((entry) => entry.kind === kind);
    const status = backend?.version?.compatibility?.status;
    if (!backend || !status || status === "supported") return null;
    const key = `${kind}\u0000${backend.version?.installed ?? ""}\u0000${status}`;
    if (dismissedBanners.has(key)) return null;
    return (
      <Suspense fallback={null}>
        <VersionBanner
          backend={backend}
          onInstall={(command) => void typeIntoTerminal(terminal(), actions, command).then((where) => actions.notify(where === "terminal" ? "The command is in a terminal; press Enter there to run it." : "No terminal is available; the command is on the clipboard."))}
          onCopy={(command) => void actions.copyText(command)}
          onDismiss={() => { dismissedBanners.add(key); setDismissed((count) => count + 1); }}
        />
      </Suspense>
    );
  };
}

function settingsPageOf(instance: string): string {
  return instance === DEFAULT_INSTANCE_ID ? "opencode.settings" : `opencode.settings.${instance}`;
}

/** Offers each new release once, as a toast with Update and Settings; Update runs in a Terminal Kit shell. */
export function createUpdateToasts(host: HostExtensionClient, terminal: () => TerminalRunService | undefined) {
  let toasts: Promise<RuntimeUpdateToasts> | undefined;
  const load = () => toasts ??= loadRuntimeUpdateToasts().then((module) => module.createRuntimeUpdateToasts({
    canRun: () => terminal() !== undefined,
    run: (command, backend, actions) => {
      const service = terminal();
      if (!service) return Promise.reject(new Error("No terminal is available to run the update in."));
      return service.run({ command, label: `Update ${backend.label}` }, actions);
    },
    recheck: async (backend) => await host.invoke("recheck", { instance: runtimeInstanceId(backend.kind) }) as RuntimeToolVersion | undefined,
    settingsPage: (backend) => settingsPageOf(runtimeInstanceId(backend.kind)),
  }));
  function OpenCodeUpdateToasts({ snapshot, actions }: RegionProps) {
    const backends = snapshot?.runtimeBackends;
    useEffect(() => {
      const newer = (backends ?? []).filter((backend) => isRuntimeInstanceOf(backend.kind, OPENCODE_BACKEND_KIND) && updateAvailable(backend.version));
      if (newer.length > 0) void load().then((loaded) => loaded.sync(newer, actions), () => undefined);
    }, [backends, actions]);
    return null;
  }
  return Object.assign(OpenCodeUpdateToasts, { refresh: () => void toasts?.then((loaded) => loaded.refresh(), () => undefined) });
}

const DEFAULT_ORDER = 28;

/**
 * OpenCode's desktop half: it marks OpenCode threads, fills one card per
 * instance on the Providers page and warns above the composer about a version
 * Tau does not work well with. The backend itself is the host entry.
 */
export const openCodeExtension: DesktopExtension = {
  id: OPENCODE_HOST_EXTENSION_ID,
  name: "OpenCode",
  activate(plugin) {
    const instances = new OpenCodeInstances();
    const terminal = () => plugin.hostExtension(TERMINAL_HOST_EXTENSION_ID);
    const cards = new Map<string, { label: string; dispose: () => void }>();
    const card = (instance: string) => (props: SettingsPageProps) => <OpenCodeProviderCard {...props} host={plugin.host} instance={instance} instances={instances} terminal={terminal()} />;
    const registerCard = (entry: OpenCodeInstanceView, order: number) => plugin.registerSettingsPage({
      id: settingsPageOf(entry.id),
      label: entry.label,
      profiles: ["desktop", "web"],
      runtime: entry.kind,
      order,
      keywords: ["opencode", "instance", "server", entry.id],
      Component: card(entry.id),
    });
    const sync = (report: OpenCodeInstancesReport) => {
      instances.set(report);
      const wanted = new Map(report.instances.map((entry, index) => [entry.id, { entry, index }] as const));
      for (const [id, registered] of [...cards]) {
        const next = wanted.get(id);
        if (next && next.entry.label === registered.label) continue;
        registered.dispose();
        cards.delete(id);
      }
      for (const [id, { entry, index }] of wanted) {
        if (cards.has(id)) continue;
        cards.set(id, { label: entry.label, dispose: registerCard(entry, DEFAULT_ORDER + index / 100) });
      }
    };
    cards.set(DEFAULT_INSTANCE_ID, {
      label: "OpenCode",
      dispose: registerCard({ id: DEFAULT_INSTANCE_ID, kind: OPENCODE_BACKEND_KIND, label: "OpenCode", threads: 0 }, DEFAULT_ORDER),
    });
    let runner: TerminalRunService | undefined;
    const updateToasts = createUpdateToasts(plugin.host, () => runner);
    const stops = [
      plugin.registerStatusItem({ id: "opencode.runtime", align: "left", order: 43, profiles: ["desktop", "web", "compact"], Component: OpenCodeStatus }),
      plugin.registerRegion({ id: "opencode.version", placement: "composer-above", order: 5, profiles: ["desktop", "web", "compact"], Component: createVersionBanner(terminal) }),
      plugin.registerRegion({ id: "opencode.update-toasts", placement: "composer-above", order: 6, profiles: ["desktop", "web", "compact"], Component: updateToasts }),
      plugin.useService<TerminalRunService>(TERMINAL_RUN_SERVICE, (service) => {
        runner = service;
        updateToasts.refresh();
        return () => {
          if (runner !== service) return;
          runner = undefined;
          updateToasts.refresh();
        };
      }),
      plugin.host.onEvent(INSTANCES_EVENT, (payload) => { if (isReport(payload)) sync(payload); }),
    ];
    let active = true;
    void plugin.host.invoke("instances").then((report) => { if (active && isReport(report)) sync(report); }, () => undefined);
    return () => {
      active = false;
      for (const stop of stops) stop();
      for (const registered of cards.values()) registered.dispose();
      cards.clear();
    };
  },
};

export default openCodeExtension;
