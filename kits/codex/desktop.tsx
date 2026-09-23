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
  type RuntimeToolVersion,
  type RuntimeUpdateToasts,
  type RuntimeInstanceConfig,
  type SettingsPageProps,
  type WorkbenchActions,
} from "tau";
import {
  CODEX_BACKEND_KIND,
  CODEX_HOME_VARIABLE,
  CODEX_HOST_EXTENSION_ID,
  INSTANCES_EVENT,
  MIN_CODEX_VERSION,
  type CodexInstanceView,
  type CodexInstancesReport,
  type CodexStatusReport,
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

/** Names the runtime behind a Codex thread, on any instance; other threads show nothing. */
export function CodexStatus({ snapshot }: RegionProps) {
  if (!isRuntimeInstanceOf(snapshot?.backendKind, CODEX_BACKEND_KIND)) return null;
  const model = snapshot?.model?.name;
  const label = snapshot?.runtimeBackends?.find((backend) => backend.kind === snapshot.backendKind)?.label ?? "Codex";
  return <span className="status-item" title={`This thread runs the installed Codex CLI through its app server${model ? ` on ${model}` : ""}.`}><SquareTerminal size={12} /> {label}</span>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PLAN_NAMES: Record<string, string> = { free: "Free", go: "Go", plus: "Plus", pro: "Pro", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu" };

function accountLabel(account: CodexStatusReport["account"]): string | undefined {
  if (!account) return undefined;
  if (account.kind === "chatgpt") return `ChatGPT${account.plan ? ` ${PLAN_NAMES[account.plan] ?? account.plan}` : ""}${account.email ? ` · ${account.email}` : ""}`;
  return account.kind === "apiKey" ? "API key" : "signed in";
}

/** The workbench's actions where a Settings card is drawn inside it; a test renders none. */
function useShellActions(): WorkbenchActions | undefined {
  try {
    return useWorkbenchShell().actions;
  } catch {
    return undefined;
  }
}

/**
 * Types a command into a new shell of Terminal Kit's without pressing Enter:
 * the user reads it and runs it. Without Terminal Kit the command is copied.
 */
export async function typeIntoTerminal(terminal: HostExtensionClient, actions: WorkbenchActions | undefined, command: string): Promise<"terminal" | "copied"> {
  try {
    const workspaceId = actions?.activeThread()?.workspaceId;
    const session = await terminal.invoke("open", { ...(workspaceId ? { workspaceId } : {}), label: "Codex" }) as { id: string };
    await terminal.invoke("input", { id: session.id, data: command });
    actions?.openPanel(TERMINAL_PANEL);
    return "terminal";
  } catch {
    await (actions?.copyText(command) ?? navigator.clipboard?.writeText(command));
    return "copied";
  }
}

/** The executable's path, saved when the field is left or Enter is pressed; empty goes back to the PATH. */
export function CommandPathField({ status, onSave }: { status: CodexStatusReport | undefined; onSave(command: string): Promise<void> }) {
  const saved = status?.commandSource === "setting" ? status.command : "";
  const [draft, setDraft] = useState(saved);
  useEffect(() => { setDraft(saved); }, [saved]);
  const fromEnv = status?.commandSource === "env";
  const commit = () => { if (draft.trim() !== saved) void onSave(draft.trim()); };
  return (
    <>
      <input
        className="settings-search-input codex-path"
        aria-label="Codex executable"
        value={fromEnv ? status!.command : draft}
        placeholder="codex, from your login shell's PATH"
        disabled={fromEnv || !status}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") commit(); }}
      />
      <p className="settings-note">{fromEnv ? <>Set by <code>TAU_CODEX_COMMAND</code> in Tau's environment.</> : <>A name on the PATH or an absolute path; leave it empty to find <code>codex</code> on the PATH.</>}</p>
    </>
  );
}

/** The instances the host keeps, for every card and the banner; updated by the host's push. */
export class CodexInstances {
  private report: CodexInstancesReport = { instances: [] };
  private readonly listeners = new Set<() => void>();

  get snapshot(): CodexInstancesReport { return this.report; }

  set(report: CodexInstancesReport): void {
    this.report = report;
    for (const listener of [...this.listeners]) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
}

function isReport(value: unknown): value is CodexInstancesReport {
  return Boolean(value && typeof value === "object" && Array.isArray((value as CodexInstancesReport).instances));
}

export interface CodexProviderCardProps extends SettingsPageProps {
  host: HostExtensionClient;
  /** The instance this card is about; the default one when absent. */
  instance?: string;
  /** Every instance, for the dialog and the setup row; absent before the host answered. */
  instances?: CodexInstances;
  /** Terminal Kit's host half, for the command that installs a release. */
  terminal?: HostExtensionClient;
}

/**
 * One Codex instance's card on the Providers page: the installed CLI, whether
 * it is current and a version Tau works with, who it is signed in as, where
 * Tau finds it and how the instance is set up. The default instance's card
 * adds another instance; the binary and the login stay the user's.
 */
export function CodexProviderCard({ host, onNotify, instance = DEFAULT_INSTANCE_ID, instances, terminal }: CodexProviderCardProps) {
  const [status, setStatus] = useState<CodexStatusReport>();
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
      setStatus(await host.invoke("status", { fresh, ...(instance === DEFAULT_INSTANCE_ID ? {} : { instance }) }) as CodexStatusReport);
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
      onNotify(command ? `Codex runs from ${command}.` : "Codex is looked up on the PATH again.");
      await read(true);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  const saveInstance = async (next: RuntimeInstanceConfig) => {
    const added = !report.instances.some((entry) => entry.id === next.id);
    const saved = await host.invoke("save-instance", { instance: next });
    if (isReport(saved)) instances?.set(saved);
    onNotify(added ? `Added the Codex instance “${next.name ?? next.id}”.` : "Saved; the next Codex process of this instance uses it.");
    if (!added) await read(true);
  };

  const remove = async () => {
    const saved = await host.invoke("remove-instance", { instance });
    if (isReport(saved)) instances?.set(saved);
    onNotify(`Removed the Codex instance “${view?.label ?? instance}”.`);
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
  const account = accountLabel(status?.account);
  const compatibility = status?.compatibility && status.compatibility.status !== "supported" ? status.compatibility : undefined;
  return (
    <>
      <p className="settings-note">
        {isDefault
          ? <>Threads drive the CLI you installed, through its app server, with its login and the sessions in your {" "}<code>~/.codex</code> (or <code>CODEX_HOME</code>). Tau reads no credential.</>
          : <>A second Codex setup: threads started on it keep it, with the login and sessions of its own home. Tau reads no credential.</>}
      </p>

      <div className="settings-label">CLI</div>
      <div className="settings-field codex-field">
        {found && !status?.unsupported && !compatibility ? <CircleCheck size={14} className="accent" /> : <TriangleAlert size={14} />}
        <span>
          <strong>{!known ? "Checking…" : found ? `Found${status?.version ? ` · ${status.version}` : ""}` : `${status.command} was not found`}</strong>
          <small>{!known ? "" : found ? status.path : status.message ?? "Install it, or set its path below."}</small>
        </span>
        <button className="codex-action" disabled={busy} onClick={() => void read(true)}>
          <RefreshCw size={13} /> {busy ? "Asking…" : "Check again"}
        </button>
      </div>
      {compatibility && status ? (
        <div className="codex-version">
          <Suspense fallback={null}>
            <VersionBanner
              backend={{ kind: view?.kind ?? CODEX_BACKEND_KIND, label: view?.label ?? "Codex", version: { tool: "codex", ...(status.version ? { installed: status.version } : {}), ...(status.updateCommand ? { updateCommand: status.updateCommand } : {}), compatibility } }}
              onInstall={(command) => void runCommand(command)}
              onCopy={(command) => void actions?.copyText(command)}
            />
          </Suspense>
        </div>
      ) : null}
      {!compatibility && status?.unsupported ? <p className="settings-note" data-level="error">Tau speaks to Codex {MIN_CODEX_VERSION} and newer. Update it with <code>{status.updateCommand}</code>.</p> : null}
      {!compatibility && !status?.unsupported && status?.updateAvailable ? <p className="settings-note">Codex {status.latest} is out. Update with <code>{status.updateCommand}</code>.</p> : null}

      <div className="settings-label">Account</div>
      <div className="settings-field codex-field">
        {account ? <CircleCheck size={14} className="accent" /> : <TriangleAlert size={14} />}
        <span>
          <strong>{!known || (found && busy && !status?.signedIn) ? "Checking…" : account ?? "Not signed in"}</strong>
          <small>{account ? "Sign in and out with the CLI itself; Tau uses whatever it is signed in as." : <>Run <code>{view?.home ? `CODEX_HOME=${view.home} codex login` : "codex login"}</code> in a terminal to sign in with your ChatGPT plan.</>}</small>
        </span>
      </div>
      {status?.codexHome ? <p className="settings-note">Home: <code>{status.codexHome}</code>{status.models ? ` · ${status.models} models; pick one and its reasoning effort per thread in the composer.` : ""}</p> : null}

      <div className="settings-label">Path</div>
      <CommandPathField status={status} onSave={saveCommand} />

      {error ? <p className="settings-note" data-level="error">{error}</p> : null}
      {view ? (
        <Suspense fallback={null}>
          <InstanceSetup
            program="Codex"
            homeVariable={CODEX_HOME_VARIABLE}
            homePlaceholder="~/.codex"
            commandPlaceholder="codex"
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

const EMPTY_REPORT: CodexInstancesReport = { instances: [] };
const noSubscription = () => () => undefined;

/** Dismissed per instance, version and verdict for as long as the window lives. */
const dismissedBanners = new Set<string>();

/** Above the composer of a Codex thread whose CLI the version policy calls unsafe or broken. */
export function createVersionBanner(terminal: () => HostExtensionClient) {
  return function CodexVersionBanner({ snapshot, actions }: RegionProps) {
    const [, setDismissed] = useState(0);
    const kind = snapshot?.backendKind;
    if (!isRuntimeInstanceOf(kind, CODEX_BACKEND_KIND)) return null;
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

/** The Providers card of an instance: the default one keeps the page id it always had. */
function settingsPageOf(instance: string): string {
  return instance === DEFAULT_INSTANCE_ID ? "codex.settings" : `codex.settings.${instance}`;
}

/**
 * Offers each new release of the CLI once, as a toast with Update and
 * Settings (T3 Code's provider update notification). Update runs the update
 * command in a Terminal Kit shell; the chunk loads only once a release is out.
 */
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
  return function CodexUpdateToasts({ snapshot, actions }: RegionProps) {
    const backends = snapshot?.runtimeBackends;
    useEffect(() => {
      const newer = (backends ?? []).filter((backend) => isRuntimeInstanceOf(backend.kind, CODEX_BACKEND_KIND) && updateAvailable(backend.version));
      if (newer.length > 0) void load().then((loaded) => loaded.sync(newer, actions), () => undefined);
    }, [backends, actions]);
    return null;
  };
}

const DEFAULT_ORDER = 26;

/**
 * Codex's desktop half: it marks Codex threads, fills one card per instance
 * on the Providers page and warns above the composer about a CLI version Tau
 * does not work well with. The backend itself is the host entry.
 */
export const codexExtension: DesktopExtension = {
  id: CODEX_HOST_EXTENSION_ID,
  name: "Codex",
  activate(plugin) {
    const instances = new CodexInstances();
    const terminal = () => plugin.hostExtension(TERMINAL_HOST_EXTENSION_ID);
    const cards = new Map<string, { label: string; dispose: () => void }>();
    const card = (instance: string) => (props: SettingsPageProps) => <CodexProviderCard {...props} host={plugin.host} instance={instance} instances={instances} terminal={terminal()} />;
    const sync = (report: CodexInstancesReport) => {
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
    // The default instance keeps the page id it always had, so `openSettings("codex.settings")` still lands on it.
    const registerCard = (entry: CodexInstanceView, order: number) => plugin.registerSettingsPage({
      id: settingsPageOf(entry.id),
      label: entry.label,
      profiles: ["desktop", "web"],
      runtime: entry.kind,
      order,
      keywords: ["codex", "instance", entry.id],
      Component: card(entry.id),
    });
    cards.set(DEFAULT_INSTANCE_ID, {
      label: "Codex",
      dispose: registerCard({ id: DEFAULT_INSTANCE_ID, kind: CODEX_BACKEND_KIND, label: "Codex", threads: 0 }, DEFAULT_ORDER),
    });
    let runner: TerminalRunService | undefined;
    const stops = [
      plugin.registerStatusItem({ id: "codex.runtime", align: "left", order: 42, profiles: ["desktop", "web", "compact"], Component: CodexStatus }),
      plugin.registerRegion({ id: "codex.version", placement: "composer-above", order: 5, profiles: ["desktop", "web", "compact"], Component: createVersionBanner(terminal) }),
      plugin.registerRegion({ id: "codex.update-toasts", placement: "composer-above", order: 6, profiles: ["desktop", "web", "compact"], Component: createUpdateToasts(plugin.host, () => runner) }),
      plugin.useService<TerminalRunService>(TERMINAL_RUN_SERVICE, (service) => {
        runner = service;
        return () => { if (runner === service) runner = undefined; };
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

export default codexExtension;
