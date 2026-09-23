import { Suspense, lazy, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Bot, CircleCheck, RefreshCw, TriangleAlert } from "lucide-react";
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
  CLAUDE_CODE_BACKEND_KIND,
  CLAUDE_CODE_HOST_EXTENSION_ID,
  CLAUDE_HOME_VARIABLE,
  INSTANCES_EVENT,
  type ClaudeInstanceView,
  type ClaudeInstancesReport,
  type ClaudeStatusReport,
} from "./protocol.js";

const TERMINAL_HOST_EXTENSION_ID = "tau.terminal";
const TERMINAL_PANEL = "terminal";

const InstanceSetup = lazy(() => loadRuntimeInstanceUi().then((module) => ({ default: module.RuntimeInstanceSetup })));
const VersionBanner = lazy(() => loadRuntimeInstanceUi().then((module) => ({ default: module.RuntimeVersionBanner })));

/** Names the runtime behind a Claude thread, on any instance; Pi threads show nothing. */
export function ClaudeCodeStatus({ snapshot }: RegionProps) {
  if (!isRuntimeInstanceOf(snapshot?.backendKind, CLAUDE_CODE_BACKEND_KIND)) return null;
  const model = snapshot?.model?.name;
  const label = snapshot?.runtimeBackends?.find((backend) => backend.kind === snapshot.backendKind)?.label ?? "Claude Code";
  return <span className="status-item" title={`This thread runs the installed Claude Code CLI through the Agent SDK${model ? ` on ${model}` : ""}.`}><Bot size={12} /> {label}</span>;
}

interface ProbeReport {
  version?: string;
  account?: string;
  defaultModel?: string;
  effort?: string;
  models?: Array<{ id: string; name: string }>;
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

/** Types a command into a new Terminal Kit shell without pressing Enter; copies it where there is none. */
async function typeIntoTerminal(terminal: HostExtensionClient, actions: WorkbenchActions | undefined, command: string): Promise<"terminal" | "copied"> {
  try {
    const workspaceId = actions?.activeThread()?.workspaceId;
    const session = await terminal.invoke("open", { ...(workspaceId ? { workspaceId } : {}), label: "Claude Code" }) as { id: string };
    await terminal.invoke("input", { id: session.id, data: command });
    actions?.openPanel(TERMINAL_PANEL);
    return "terminal";
  } catch {
    await (actions?.copyText(command) ?? navigator.clipboard?.writeText(command));
    return "copied";
  }
}

const whereTheCommandIs = (where: "terminal" | "copied") => where === "terminal" ? "The command is in a terminal; press Enter there to run it." : "No terminal is available; the command is on the clipboard.";

/** The executable's path, saved when the field is left or Enter is pressed; empty goes back to the PATH. */
function CommandPathField({ status, onSave }: { status: ClaudeStatusReport | undefined; onSave(command: string): Promise<void> }) {
  const saved = status?.commandSource === "setting" ? status.command : "";
  const [draft, setDraft] = useState(saved);
  useEffect(() => { setDraft(saved); }, [saved]);
  const fromEnv = status?.commandSource === "env";
  const commit = () => { if (draft.trim() !== saved) void onSave(draft.trim()); };
  return (
    <>
      <input
        className="settings-search-input claude-code-path"
        aria-label="Claude Code executable"
        value={fromEnv ? status!.command : draft}
        placeholder="claude, from your login shell's PATH"
        disabled={fromEnv || !status}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") commit(); }}
      />
      <p className="settings-note">{fromEnv ? <>Set by <code>TAU_CLAUDE_CODE_COMMAND</code> in Tau's environment.</> : <>A name on the PATH or an absolute path; leave it empty to find <code>claude</code> on the PATH.</>}</p>
    </>
  );
}

/** The instances the host keeps, for every card; updated by the host's push. */
export class ClaudeInstances {
  private report: ClaudeInstancesReport = { instances: [] };
  private readonly listeners = new Set<() => void>();

  get snapshot(): ClaudeInstancesReport { return this.report; }

  set(report: ClaudeInstancesReport): void {
    this.report = report;
    for (const listener of [...this.listeners]) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
}

function isReport(value: unknown): value is ClaudeInstancesReport {
  return Boolean(value && typeof value === "object" && Array.isArray((value as ClaudeInstancesReport).instances));
}

const EMPTY_REPORT: ClaudeInstancesReport = { instances: [] };
const noSubscription = () => () => undefined;

export interface ClaudeCodeProviderCardProps extends SettingsPageProps {
  host: HostExtensionClient;
  /** The instance this card is about; the default one when absent. */
  instance?: string;
  instances?: ClaudeInstances;
  /** Terminal Kit's host half, for the command that installs a release. */
  terminal?: HostExtensionClient;
}

/**
 * One instance's card on the Providers page: what the installed CLI is,
 * whether it is current and a version Tau works with, who it is signed in as
 * and how the instance is set up. The binary and the login are the user's.
 */
export function ClaudeCodeProviderCard({ host, onNotify, instance = DEFAULT_INSTANCE_ID, instances, terminal }: ClaudeCodeProviderCardProps) {
  const [status, setStatus] = useState<ClaudeStatusReport>();
  const [probe, setProbe] = useState<ProbeReport>();
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
    const only = instance === DEFAULT_INSTANCE_ID ? undefined : { instance };
    try {
      setStatus(await (only ? host.invoke("status", only) : host.invoke("status")) as ClaudeStatusReport);
      setProbe(await host.invoke("probe", { fresh, ...only }) as ProbeReport);
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
      onNotify(command ? `Claude Code runs from ${command}.` : "Claude Code is looked up on the PATH again.");
      await read(true);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  const saveInstance = async (next: RuntimeInstanceConfig) => {
    const added = !report.instances.some((entry) => entry.id === next.id);
    const saved = await host.invoke("save-instance", { instance: next });
    if (isReport(saved)) instances?.set(saved);
    onNotify(added ? `Added the Claude Code instance “${next.name ?? next.id}”.` : "Saved; the next session of this instance uses it.");
    if (!added) await read(true);
  };

  const remove = async () => {
    const saved = await host.invoke("remove-instance", { instance });
    if (isReport(saved)) instances?.set(saved);
    onNotify(`Removed the Claude Code instance “${view?.label ?? instance}”.`);
  };

  const runCommand = async (command: string) => {
    if (!terminal) {
      await actions?.copyText(command);
      onNotify("The command is on the clipboard.");
      return;
    }
    onNotify(whereTheCommandIs(await typeIntoTerminal(terminal, actions, command)));
  };

  const known = status !== undefined;
  const found = Boolean(status?.path);
  const compatibility = status?.compatibility && status.compatibility.status !== "supported" ? status.compatibility : undefined;
  return (
    <>
      <p className="settings-note">
        {isDefault
          ? <>Threads drive the CLI you installed, through the Agent SDK, with its login and the settings in your {" "}<code>~/.claude</code>. Tau adds nothing to them and reads no credential.</>
          : <>Another setup of the same CLI: threads started on it keep it, with the login and settings of its own home. Tau reads no credential.</>}
      </p>

      <div className="settings-label">CLI</div>
      <div className="settings-field claude-code-field">
        {found && !compatibility ? <CircleCheck size={14} className="accent" /> : <TriangleAlert size={14} />}
        <span>
          <strong>{!known ? "Checking…" : found ? `Found${probe?.version ? ` · ${probe.version}` : ""}` : `${status.command} was not found`}</strong>
          <small>{!known ? "" : found ? status.path : "Install it from claude.ai/code, or set its path below."}</small>
        </span>
        <button className="claude-code-action" disabled={busy} onClick={() => void read(true)}>
          <RefreshCw size={13} /> {busy ? "Asking…" : "Check again"}
        </button>
      </div>
      {compatibility && status ? (
        <div className="claude-code-version">
          <Suspense fallback={null}>
            <VersionBanner
              backend={{ kind: status.kind, label: view?.label ?? "Claude Code", version: { tool: "claude", ...(status.installed ? { installed: status.installed } : {}), ...(status.updateCommand ? { updateCommand: status.updateCommand } : {}), compatibility } }}
              onInstall={(command) => void runCommand(command)}
              onCopy={(command) => void actions?.copyText(command)}
            />
          </Suspense>
        </div>
      ) : null}
      {!compatibility && status?.update ? <p className="settings-note">Claude Code {status.update.latest} is out; {status.update.installed} is installed.{status.update.command ? <> Update with <code>{status.update.command}</code>.</> : null}</p> : null}

      <div className="settings-label">Account</div>
      <div className="settings-field claude-code-field">
        {probe?.account ? <CircleCheck size={14} className="accent" /> : <TriangleAlert size={14} />}
        <span>
          <strong>{!known ? "Checking…" : probe?.account ?? "Not signed in"}</strong>
          <small>{probe?.account ? "Sign in and out with the CLI itself; Tau uses whatever it is signed in as." : view?.home ? <>Run <code>CLAUDE_CONFIG_DIR={view.home} claude</code> once in a terminal to sign in.</> : "Run the CLI once in a terminal to sign in."}</small>
        </span>
      </div>

      {probe?.models?.length ? (
        <p className="settings-note">
          {probe.models.length} models available{probe.defaultModel ? `, ${probe.defaultModel} by default` : ""}
          {probe.effort ? `, effort ${probe.effort}` : ""}. Pick one per thread in the composer.
        </p>
      ) : null}

      <div className="settings-label">Path</div>
      <CommandPathField status={status} onSave={saveCommand} />
      {error ? <p className="settings-note" data-level="error">{error}</p> : null}
      {view ? (
        <Suspense fallback={null}>
          <InstanceSetup
            program="Claude Code"
            homeVariable={CLAUDE_HOME_VARIABLE}
            homePlaceholder="~/.claude"
            commandPlaceholder="claude"
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

/** Dismissed per instance, version and verdict for as long as the window lives. */
const dismissedBanners = new Set<string>();

/** Above the composer of a thread whose CLI the version policy calls unsafe or broken. */
export function createVersionBanner(terminal: () => HostExtensionClient) {
  return function ClaudeCodeVersionBanner({ snapshot, actions }: RegionProps) {
    const [, setDismissed] = useState(0);
    const kind = snapshot?.backendKind;
    if (!isRuntimeInstanceOf(kind, CLAUDE_CODE_BACKEND_KIND)) return null;
    const backend = snapshot?.runtimeBackends?.find((entry) => entry.kind === kind);
    const status = backend?.version?.compatibility?.status;
    if (!backend || !status || status === "supported") return null;
    const key = `${kind}\u0000${backend.version?.installed ?? ""}\u0000${status}`;
    if (dismissedBanners.has(key)) return null;
    return (
      <Suspense fallback={null}>
        <VersionBanner
          backend={backend}
          onInstall={(command) => void typeIntoTerminal(terminal(), actions, command).then((where) => actions.notify(whereTheCommandIs(where)))}
          onCopy={(command) => void actions.copyText(command)}
          onDismiss={() => { dismissedBanners.add(key); setDismissed((count) => count + 1); }}
        />
      </Suspense>
    );
  };
}

const DEFAULT_ORDER = 25;

/**
 * The Agent SDK runtime's desktop half: it marks its threads, fills one card
 * per instance on the Providers page and warns above the composer about a CLI
 * version Tau does not work well with. The backend itself is the host entry.
 */
export const claudeCodeExtension: DesktopExtension = {
  id: CLAUDE_CODE_HOST_EXTENSION_ID,
  name: "Claude Code",
  activate(plugin) {
    const instances = new ClaudeInstances();
    const terminal = () => plugin.hostExtension(TERMINAL_HOST_EXTENSION_ID);
    const cards = new Map<string, { label: string; dispose: () => void }>();
    // The default instance keeps the page id it always had, so `openSettings("claude-code.settings")` still lands on it.
    const registerCard = (entry: ClaudeInstanceView, order: number) => plugin.registerSettingsPage({
      id: entry.id === DEFAULT_INSTANCE_ID ? "claude-code.settings" : `claude-code.settings.${entry.id}`,
      label: entry.label,
      profiles: ["desktop", "web"],
      runtime: entry.kind,
      order,
      keywords: ["claude", "instance", entry.id],
      Component: (props: SettingsPageProps) => <ClaudeCodeProviderCard {...props} host={plugin.host} instance={entry.id} instances={instances} terminal={terminal()} />,
    });
    cards.set(DEFAULT_INSTANCE_ID, { label: "Claude Code", dispose: registerCard({ id: DEFAULT_INSTANCE_ID, kind: CLAUDE_CODE_BACKEND_KIND, label: "Claude Code", threads: 0 }, DEFAULT_ORDER) });
    const sync = (report: ClaudeInstancesReport) => {
      instances.set(report);
      const wanted = new Map(report.instances.map((entry, index) => [entry.id, { entry, index }] as const));
      for (const [id, registered] of [...cards]) {
        if (wanted.get(id)?.entry.label === registered.label) continue;
        registered.dispose();
        cards.delete(id);
      }
      for (const [id, { entry, index }] of wanted) {
        if (!cards.has(id)) cards.set(id, { label: entry.label, dispose: registerCard(entry, DEFAULT_ORDER + index / 100) });
      }
    };
    const stops = [
      plugin.registerStatusItem({ id: "claude-code.runtime", align: "left", order: 40, profiles: ["desktop", "web", "compact"], Component: ClaudeCodeStatus }),
      plugin.registerRegion({ id: "claude-code.version", placement: "composer-above", order: 5, profiles: ["desktop", "web", "compact"], Component: createVersionBanner(terminal) }),
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

export default claudeCodeExtension;
