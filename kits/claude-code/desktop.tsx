import { Suspense, lazy, useCallback, useEffect, useState, useSyncExternalStore, type ComponentProps } from "react";
import { Bot } from "lucide-react";
import {
  DEFAULT_INSTANCE_ID,
  SettingRow,
  SettingsState,
  isRuntimeInstanceOf,
  loadRuntimeInstanceUi,
  loadRuntimeUpdateToasts,
  loadSignInUi,
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
  type SignInReport,
  type WorkbenchActions,
} from "tau";
import {
  CLAUDE_CODE_BACKEND_KIND,
  CLAUDE_CODE_HOST_EXTENSION_ID,
  CLAUDE_HOME_VARIABLE,
  INSTANCES_EVENT,
  RESUME_COMPACTION_OPT_OUT_SERVICE,
  RESUME_QUESTION_OFF_EVENT,
  type ClaudeInstanceView,
  type ClaudeInstancesReport,
  type ClaudeStatusReport,
} from "./protocol.js";
import { isAgentSdkTool, presentAgentSdkTool } from "./tool-presentation.js";

const TERMINAL_HOST_EXTENSION_ID = "tau.terminal";
/** Terminal Kit's desktop service (`kits/terminal/protocol.ts`), named here: a kit never imports another. */
const TERMINAL_RUN_SERVICE = "tau.terminal/run";
/** Turns the resume banner off for a runtime on every device; see `RESUME_COMPACTION_OPT_OUT_SERVICE`. */
interface ResumeCompactionOptOut {
  turnOff(runtime: string): void;
}
interface TerminalRunService {
  run(request: { command: string; label?: string }, actions?: WorkbenchActions): Promise<{ id: string; exitCode?: number }>;
}
const TERMINAL_PANEL = "terminal";

const InstanceSetup = lazy(() => loadRuntimeInstanceUi().then((module) => ({ default: module.RuntimeInstanceSetup })));
const VersionBanner = lazy(() => loadRuntimeInstanceUi().then((module) => ({ default: module.RuntimeVersionBanner })));
const SignIn = lazy(() => loadSignInUi().then((module) => ({ default: module.SignInSetup })));
const ProgramRows = lazy(() => loadRuntimeInstanceUi().then((module) => ({ default: module.RuntimeProgramRows })));
const CommandRow = lazy(() => loadRuntimeInstanceUi().then((module) => ({ default: module.RuntimeCommandRow })));

/** Marks the runtime behind a Claude thread with an icon, its name in the tooltip; Pi threads show nothing. */
export function ClaudeCodeStatus({ snapshot }: RegionProps) {
  if (!isRuntimeInstanceOf(snapshot?.backendKind, CLAUDE_CODE_BACKEND_KIND)) return null;
  const model = snapshot?.model?.name;
  const label = snapshot?.runtimeBackends?.find((backend) => backend.kind === snapshot.backendKind)?.label ?? "Claude Code";
  return <span className="status-item" role="img" aria-label={label} title={`${label}: this thread runs the installed Claude Code CLI through the Agent SDK${model ? ` on ${model}` : ""}.`}><Bot size={12} /></span>;
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

type ProgramState = ComponentProps<typeof ProgramRows>["state"];

/** The element ids of an instance's rows; every instance's card sits on the same page, so each carries its id. */
export function rowIds(instance: string) {
  const prefix = instance === DEFAULT_INSTANCE_ID ? "setting-agent-sdk" : `setting-agent-sdk-${instance}`;
  return { prefix, program: `${prefix}-program`, account: `${prefix}-account`, models: `${prefix}-models`, executable: `${prefix}-executable`, setup: `${prefix}-setup` };
}

/** What the Settings search finds on an instance's card. */
export function searchRows(instance: string, label: string) {
  const ids = rowIds(instance);
  return [
    { id: ids.program, label: `${label} CLI`, keywords: ["agent sdk", "version", "update", "install", "installed", "check"] },
    { id: ids.account, label: `${label} account`, keywords: ["sign in", "sign out", "login", "plan", "api key"] },
    { id: ids.executable, label: `${label} executable`, keywords: ["path", "command", "binary"] },
    { id: ids.setup, label: `${label} instance setup`, keywords: ["instance", "home", "environment", "arguments"] },
  ];
}

interface CardRowsProps {
  host: HostExtensionClient;
  target: string;
  /** The instance's name, for the rows' words. */
  program: string;
  runInTerminal?(command: string): Promise<{ exitCode?: number }>;
  openExternal(url: string): void;
  copyText(text: string): Promise<void>;
  onNotify(message: string): void;
  onReport(report: SignInReport): void;
  isDefault: boolean;
  state: ProgramState;
  /** The executable as the host runs it, who named it, and the backend kind. */
  command?: { command: string; source?: string; kind: string };
  models?: string;
  busy: boolean;
  error?: string;
  onCheck(): void;
  onRunCommand(command: string): void;
  onSaveCommand(command: string): Promise<void>;
}

/** An instance's rows above its setup: the program, the account, its models and the executable. */
function CardRows({ host, target, program, runInTerminal, openExternal, copyText, onNotify, onReport, isDefault, state, command, models, busy, error, onCheck, onRunCommand, onSaveCommand }: CardRowsProps) {
  const rows = rowIds(target);
  return (
    <>
      <ProgramRows
        program={program}
        idPrefix={rows.prefix}
        help={isDefault
          ? "Threads drive the CLI you installed, through the Agent SDK, with its login and the settings in its home. Tau adds nothing to them and reads no credential."
          : "Another setup of the same CLI: threads started on it keep it, with the login and settings of its own home. Tau reads no credential."}
        {...(state ? { state } : {})}
        missing="Install the CLI, or set its executable below."
        busy={busy}
        {...(error ? { error } : {})}
        onCheck={onCheck}
        onRunCommand={onRunCommand}
      />
      <SignIn host={host} target={target} program={program} rowId={rows.account} {...(runInTerminal ? { runInTerminal } : {})} openExternal={openExternal} copyText={copyText} onNotify={onNotify} onReport={onReport} />
      {models ? <SettingRow id={rows.models} title="Models" description={models} /> : null}
      <CommandRow
        id={rows.executable}
        program={program}
        known={command !== undefined}
        {...(command ? { command: command.command, kind: command.kind, ...(command.source ? { source: command.source } : {}) } : {})}
        onSave={onSaveCommand}
      />
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
  /** Terminal Kit's run service, for the CLI's login in a shell the user sees. */
  runner?: () => TerminalRunService | undefined;
}

/**
 * One instance's card on the Providers page: what the installed CLI is,
 * whether it is current and a version Tau works with, who it is signed in as
 * and how the instance is set up. The binary and the login are the user's.
 */
export function ClaudeCodeProviderCard({ host, onNotify, instance = DEFAULT_INSTANCE_ID, instances, terminal, runner }: ClaudeCodeProviderCardProps) {
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

  const compatibility = status?.compatibility && status.compatibility.status !== "supported" ? status.compatibility : undefined;
  const run = runner?.();
  const version = probe?.version ?? status?.version ?? status?.installed;
  const state: ProgramState = status ? {
    found: Boolean(status.path),
    ...(version ? { version } : {}),
    ...(status.path ? { location: status.path } : {}),
    ...(status.update ? { latest: status.update.latest, ...(status.update.command ? { updateCommand: status.update.command } : {}) } : {}),
    ...(compatibility ? { compatibility, ...(status.updateCommand ? { updateCommand: status.updateCommand } : {}) } : {}),
  } : undefined;
  const models = probe?.models?.length
    ? `${probe.models.length} models available${probe.defaultModel ? `, ${probe.defaultModel} by default` : ""}${probe.effort ? `, effort ${probe.effort}` : ""}. Pick one per thread in the composer.`
    : undefined;
  return (
    <Suspense fallback={<SettingsState kind="loading" rows={3} title="Loading the runtime" />}>
      <Suspense fallback={null}>
        <CardRows
          host={host}
          target={instance}
          program={view?.label ?? "Claude Code"}
          {...(run ? { runInTerminal: (command: string) => run.run({ command, label: `Sign in to ${view?.label ?? "Claude Code"}` }, actions) } : {})}
          openExternal={(url) => actions ? actions.openExternal(url) : void window.open(url, "_blank", "noopener")}
          copyText={(text) => actions?.copyText(text) ?? navigator.clipboard.writeText(text)}
          onNotify={onNotify}
          onReport={(next) => { if (next.flow?.phase === "succeeded") void read(true); }}
          isDefault={isDefault}
          state={state}
          {...(status ? { command: { command: status.command, kind: status.kind, ...(status.commandSource ? { source: status.commandSource } : {}) } } : {})}
          {...(models ? { models } : {})}
          busy={busy}
          {...(error ? { error } : {})}
          onCheck={() => void read(true)}
          onRunCommand={(command) => void runCommand(command)}
          onSaveCommand={saveCommand}
        />
      </Suspense>
      {view ? (
        <Suspense fallback={null}>
          <InstanceSetup
            program="Claude Code"
            homeVariable={CLAUDE_HOME_VARIABLE}
            homePlaceholder="~/.claude"
            commandPlaceholder="claude"
            instance={view}
            instances={report.instances}
            rowId={rowIds(instance).setup}
            onSave={saveInstance}
            {...(isDefault ? {} : { onRemove: remove })}
          />
        </Suspense>
      ) : null}
    </Suspense>
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

/** The Providers card of an instance: the default one keeps the page id it always had. */
function settingsPageOf(instance: string): string {
  return instance === DEFAULT_INSTANCE_ID ? "claude-code.settings" : `claude-code.settings.${instance}`;
}

/**
 * Offers each new release of the CLI once, as a toast with Update and
 * Settings. Update runs the update
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
  function ClaudeCodeUpdateToasts({ snapshot, actions }: RegionProps) {
    const backends = snapshot?.runtimeBackends;
    useEffect(() => {
      const newer = (backends ?? []).filter((backend) => isRuntimeInstanceOf(backend.kind, CLAUDE_CODE_BACKEND_KIND) && updateAvailable(backend.version));
      if (newer.length > 0) void load().then((loaded) => loaded.sync(newer, actions), () => undefined);
    }, [backends, actions]);
    return null;
  }
  // Terminal Kit may activate after this one: an offer already shown gains Update then.
  return Object.assign(ClaudeCodeUpdateToasts, { refresh: () => void toasts?.then((loaded) => loaded.refresh(), () => undefined) });
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
    let runner: TerminalRunService | undefined;
    // The default instance keeps the page id it always had, so `openSettings("claude-code.settings")` still lands on it.
    const registerCard = (entry: ClaudeInstanceView, order: number) => plugin.registerSettingsPage({
      id: settingsPageOf(entry.id),
      label: entry.label,
      profiles: ["desktop", "web"],
      runtime: entry.kind,
      order,
      rows: searchRows(entry.id, entry.label),
      // The rows the Runtimes page's Update, Install and "Add a custom runtime" open.
      runtimeRows: { program: rowIds(entry.id).program, ...(entry.id === DEFAULT_INSTANCE_ID ? { addInstance: `${rowIds(entry.id).setup}-add` } : {}) },
      keywords: ["claude", "instance", entry.id],
      Component: (props: SettingsPageProps) => <ClaudeCodeProviderCard {...props} host={plugin.host} instance={entry.id} instances={instances} terminal={terminal()} runner={() => runner} />,
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
    const updateToasts = createUpdateToasts(plugin.host, () => runner);
    let optOut: ResumeCompactionOptOut | undefined;
    const stops = [
      // Its tools carry their own names and arguments; without this the transcript names the arguments.
      plugin.registerToolRenderer("claude-code.tools", isAgentSdkTool, presentAgentSdkTool, { profiles: ["desktop", "web", "compact"] }),
      plugin.registerStatusItem({ id: "claude-code.runtime", align: "left", order: 40, profiles: ["desktop", "web"], Component: ClaudeCodeStatus }),
      plugin.registerRegion({ id: "claude-code.version", placement: "composer-above", order: 5, profiles: ["desktop", "web", "compact"], Component: createVersionBanner(terminal) }),
      plugin.registerRegion({ id: "claude-code.update-toasts", placement: "composer-above", order: 6, profiles: ["desktop", "web", "compact"], Component: updateToasts }),
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
      plugin.useService<ResumeCompactionOptOut>(RESUME_COMPACTION_OPT_OUT_SERVICE, (service) => {
        optOut = service;
        return () => { if (optOut === service) optOut = undefined; };
      }),
      // "Don't ask again" in the CLI's own question also keeps the banner away for that instance.
      plugin.host.onEvent(RESUME_QUESTION_OFF_EVENT, (payload) => {
        const runtime = (payload as { runtime?: unknown } | undefined)?.runtime;
        if (typeof runtime === "string") optOut?.turnOff(runtime);
      }),
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
