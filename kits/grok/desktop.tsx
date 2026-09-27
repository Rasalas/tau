import { Suspense, lazy, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { CircleCheck, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import {
  DEFAULT_INSTANCE_ID,
  isRuntimeInstanceOf,
  loadRuntimeInstanceUi,
  useWorkbenchShell,
  type DesktopExtension,
  type HostExtensionClient,
  type RegionProps,
  type RuntimeInstanceConfig,
  type SettingsPageProps,
  type WorkbenchActions,
} from "tau";
import {
  GROK_BACKEND_KIND,
  GROK_HOME_VARIABLE,
  GROK_HOST_EXTENSION_ID,
  INSTANCES_EVENT,
  type GrokInstanceView,
  type GrokInstancesReport,
  type GrokStatusReport,
} from "./protocol.js";

const TERMINAL_HOST_EXTENSION_ID = "tau.terminal";
const TERMINAL_PANEL = "terminal";

const InstanceSetup = lazy(() => loadRuntimeInstanceUi().then((module) => ({ default: module.RuntimeInstanceSetup })));
const VersionBanner = lazy(() => loadRuntimeInstanceUi().then((module) => ({ default: module.RuntimeVersionBanner })));

/** Marks the runtime behind a Grok thread with an icon, its name in the tooltip; other threads show nothing. */
export function GrokStatus({ snapshot }: RegionProps) {
  if (!isRuntimeInstanceOf(snapshot?.backendKind, GROK_BACKEND_KIND)) return null;
  const model = snapshot?.model;
  const label = snapshot?.runtimeBackends?.find((backend) => backend.kind === snapshot.backendKind)?.label ?? "Grok";
  return <span className="status-item" role="img" aria-label={label} title={`${label}: this thread runs the Grok CLI over ACP${model ? ` on ${model.id}` : ""}.`}><Sparkles size={12} /></span>;
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
    const session = await terminal.invoke("open", { ...(workspaceId ? { workspaceId } : {}), label: "Grok" }) as { id: string };
    await terminal.invoke("input", { id: session.id, data: command });
    actions?.openPanel(TERMINAL_PANEL);
    return "terminal";
  } catch {
    await (actions?.copyText(command) ?? navigator.clipboard?.writeText(command));
    return "copied";
  }
}

/** `grok login`, pointed at the instance's home the way the host points the CLI at it. */
export function loginCommand(command: string, home: string | undefined): string {
  if (!home) return `${command} login`;
  return `GROK_HOME=${/\s/u.test(home) ? JSON.stringify(home) : home} ${command} login`;
}

/** The executable's path, saved when the field is left or Enter is pressed; empty goes back to the PATH. */
function CommandPathField({ status, onSave }: { status: GrokStatusReport | undefined; onSave(command: string): Promise<void> }) {
  const saved = status?.commandSource === "setting" ? status.command : "";
  const [draft, setDraft] = useState(saved);
  useEffect(() => { setDraft(saved); }, [saved]);
  const fromEnv = status?.commandSource === "env";
  const commit = () => { if (draft.trim() !== saved) void onSave(draft.trim()); };
  return (
    <>
      <input
        className="settings-search-input grok-path"
        aria-label="Grok executable"
        value={fromEnv ? status!.command : draft}
        placeholder="grok, from your login shell's PATH"
        disabled={fromEnv || !status}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") commit(); }}
      />
      <p className="settings-note">{fromEnv ? <>Set by <code>TAU_GROK_COMMAND</code> in Tau's environment.</> : <>A name on the PATH or an absolute path; leave it empty to find <code>grok</code> on the PATH.</>}</p>
    </>
  );
}

export class GrokInstances {
  private report: GrokInstancesReport = { instances: [] };
  private readonly listeners = new Set<() => void>();

  get snapshot(): GrokInstancesReport { return this.report; }

  set(report: GrokInstancesReport): void {
    this.report = report;
    for (const listener of [...this.listeners]) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
}

function isReport(value: unknown): value is GrokInstancesReport {
  return Boolean(value && typeof value === "object" && Array.isArray((value as GrokInstancesReport).instances));
}

export interface GrokProviderCardProps extends SettingsPageProps {
  host: HostExtensionClient;
  instance?: string;
  instances?: GrokInstances;
  terminal?: HostExtensionClient;
}

const EMPTY_REPORT: GrokInstancesReport = { instances: [] };
const noSubscription = () => () => undefined;

/**
 * One Grok instance's card on the Providers page: the CLI, its version, how
 * it signs in, and how the instance is set up. The login is the CLI's own
 * (`grok login`), or an `XAI_API_KEY` in Tau's environment.
 */
export function GrokProviderCard({ host, onNotify, instance = DEFAULT_INSTANCE_ID, instances, terminal }: GrokProviderCardProps) {
  const [status, setStatus] = useState<GrokStatusReport>();
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
      setStatus(await host.invoke("status", { fresh, ...(instance === DEFAULT_INSTANCE_ID ? {} : { instance }) }) as GrokStatusReport);
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
      onNotify(command ? `Grok runs from ${command}.` : "Grok is looked up on the PATH again.");
      await read(true);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  const saveInstance = async (next: RuntimeInstanceConfig) => {
    const added = !report.instances.some((entry) => entry.id === next.id);
    const saved = await host.invoke("save-instance", { instance: next });
    if (isReport(saved)) instances?.set(saved);
    onNotify(added ? `Added the Grok instance “${next.name ?? next.id}”.` : "Saved; the next Grok session of this instance uses it.");
    if (!added) await read(true);
  };

  const remove = async () => {
    const saved = await host.invoke("remove-instance", { instance });
    if (isReport(saved)) instances?.set(saved);
    onNotify(`Removed the Grok instance “${view?.label ?? instance}”.`);
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
  const found = Boolean(status?.path);
  const compatibility = status?.compatibility && status.compatibility.status !== "supported" ? status.compatibility : undefined;
  const login = loginCommand(status?.path && /\s/u.test(status.path) ? JSON.stringify(status.path) : status?.command ?? "grok", view?.home);
  const signedIn = status?.signedIn === true;
  const apiKey = status?.login === "api-key";
  return (
    <>
      <p className="settings-note">
        {isDefault
          ? <>Threads drive the Grok CLI over ACP, with the models of your Grok plan or of an xAI API key. Tau reads no credential for a thread; the CLI signs in itself.</>
          : <>A second Grok setup: threads started on it keep it, with the login and sessions of its own home.</>}
      </p>

      <div className="settings-label">CLI</div>
      <div className="settings-field grok-field">
        {found && !compatibility && !status?.message ? <CircleCheck size={14} className="accent" /> : <TriangleAlert size={14} />}
        <span>
          <strong>{!known ? "Checking…" : found ? `Found${status?.version ? ` · ${status.version}` : ""}` : `${status.command} was not found`}</strong>
          <small>{!known ? "" : status.message ?? (found ? status.path : "Install Grok Build's CLI, or set its path below.")}</small>
        </span>
        <button className="grok-action" disabled={busy} onClick={() => void read(true)}>
          <RefreshCw size={13} /> {busy ? "Asking…" : "Check again"}
        </button>
      </div>
      {compatibility && status ? (
        <div className="grok-version">
          <Suspense fallback={null}>
            <VersionBanner
              backend={{ kind: view?.kind ?? GROK_BACKEND_KIND, label: view?.label ?? "Grok", version: { tool: "grok", ...(status.version ? { installed: status.version } : {}), compatibility } }}
              onInstall={(command) => void runCommand(command)}
              onCopy={(command) => void actions?.copyText(command)}
            />
          </Suspense>
        </div>
      ) : null}

      {found ? (
        <>
          <div className="settings-label">Account</div>
          <div className="settings-field grok-field">
            {signedIn ? <CircleCheck size={14} className="accent" /> : <TriangleAlert size={14} />}
            <span>
              <strong>{busy && !known ? "Checking…" : apiKey ? "xAI API key" : signedIn ? `Signed in${status?.account ? ` with ${status.account}` : ""}` : status?.signedIn === false ? "Not signed in" : "Sign-in unknown"}</strong>
              <small>
                {apiKey
                  ? <><code>XAI_API_KEY</code> is set in Tau's environment; threads are billed to the API.{status?.models !== undefined ? ` ${status.models} models.` : ""}</>
                  : signedIn ? `${status?.models ?? 0} models; pick one and its reasoning effort per thread in the composer.` : <>Run <code>{login}</code> in a terminal.</>}
              </small>
            </span>
            {!signedIn && !apiKey ? <button className="grok-action" onClick={() => void runCommand(login)}>Sign in…</button> : null}
          </div>
        </>
      ) : null}

      <div className="settings-label">Path</div>
      <CommandPathField status={status} onSave={saveCommand} />

      {error ? <p className="settings-note" data-level="error">{error}</p> : null}
      {view ? (
        <Suspense fallback={null}>
          <InstanceSetup
            program="Grok"
            homeVariable={GROK_HOME_VARIABLE}
            homePlaceholder="~/.grok (the CLI's own)"
            commandPlaceholder="grok"
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

function settingsPageOf(instance: string): string {
  return instance === DEFAULT_INSTANCE_ID ? "grok.settings" : `grok.settings.${instance}`;
}

const DEFAULT_ORDER = 29.5;

/**
 * Grok's desktop half: it marks Grok threads and fills one card per instance
 * on the Providers page. The backend itself is the host entry.
 */
export const grokExtension: DesktopExtension = {
  id: GROK_HOST_EXTENSION_ID,
  name: "Grok",
  activate(plugin) {
    const instances = new GrokInstances();
    const terminal = () => plugin.hostExtension(TERMINAL_HOST_EXTENSION_ID);
    const cards = new Map<string, { label: string; dispose: () => void }>();
    const card = (instance: string) => (props: SettingsPageProps) => <GrokProviderCard {...props} host={plugin.host} instance={instance} instances={instances} terminal={terminal()} />;
    const registerCard = (entry: GrokInstanceView, order: number) => plugin.registerSettingsPage({
      id: settingsPageOf(entry.id),
      label: entry.label,
      profiles: ["desktop", "web"],
      runtime: entry.kind,
      order,
      keywords: ["grok", "xai", "grok build", "acp", "instance", entry.id],
      Component: card(entry.id),
    });
    const sync = (report: GrokInstancesReport) => {
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
      label: "Grok",
      dispose: registerCard({ id: DEFAULT_INSTANCE_ID, kind: GROK_BACKEND_KIND, label: "Grok", threads: 0 }, DEFAULT_ORDER),
    });
    const stops = [
      plugin.registerStatusItem({ id: "grok.runtime", align: "left", order: 45, profiles: ["desktop", "web"], Component: GrokStatus }),
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

export default grokExtension;
