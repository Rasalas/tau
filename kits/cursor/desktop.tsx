import { Suspense, lazy, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { MousePointer2, SquareTerminal } from "lucide-react";
import {
  Button,
  DEFAULT_INSTANCE_ID,
  SettingRow,
  SettingsState,
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
  CURSOR_BACKEND_KIND,
  CURSOR_HOME_VARIABLE,
  CURSOR_HOST_EXTENSION_ID,
  INSTANCES_EVENT,
  MIN_CURSOR_VERSION,
  type CursorInstanceView,
  type CursorInstancesReport,
  type CursorStatusReport,
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
const ProgramRows = lazy(() => loadRuntimeInstanceUi().then((module) => ({ default: module.RuntimeProgramRows })));
const CommandRow = lazy(() => loadRuntimeInstanceUi().then((module) => ({ default: module.RuntimeCommandRow })));
const CardBadge = lazy(() => loadRuntimeInstanceUi().then((module) => ({ default: module.ProviderCardBadgeReport })));

/** The CLI's own installer, typed into a terminal for the user to run. */
const INSTALL_COMMAND = "curl https://cursor.com/install -fsS | bash";

/** Marks the runtime behind a Cursor thread with an icon, its name in the tooltip; other threads show nothing. */
export function CursorStatus({ snapshot }: RegionProps) {
  if (!isRuntimeInstanceOf(snapshot?.backendKind, CURSOR_BACKEND_KIND)) return null;
  const model = snapshot?.model;
  const label = snapshot?.runtimeBackends?.find((backend) => backend.kind === snapshot.backendKind)?.label ?? "Cursor";
  return <span className="status-item" role="img" aria-label={label} title={`${label}: this thread runs the Cursor CLI over ACP${model ? ` on ${model.id}` : ""}.`}><MousePointer2 size={12} /></span>;
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
    const session = await terminal.invoke("open", { ...(workspaceId ? { workspaceId } : {}), label: "Cursor" }) as { id: string };
    await terminal.invoke("input", { id: session.id, data: command });
    actions?.openPanel(TERMINAL_PANEL);
    return "terminal";
  } catch {
    await (actions?.copyText(command) ?? navigator.clipboard?.writeText(command));
    return "copied";
  }
}

/** `cursor-agent login`, pointed at the instance's home the way the host points the CLI at it. */
export function loginCommand(command: string, home: string | undefined): string {
  if (!home) return `${command} login`;
  const quoted = /\s/u.test(home) ? JSON.stringify(home) : home;
  return `CURSOR_CONFIG_DIR=${quoted} CURSOR_DATA_DIR=${quoted} AGENT_CLI_CREDENTIAL_STORE=file ${command} login`;
}

export class CursorInstances {
  private report: CursorInstancesReport = { instances: [] };
  private readonly listeners = new Set<() => void>();

  get snapshot(): CursorInstancesReport { return this.report; }

  set(report: CursorInstancesReport): void {
    this.report = report;
    for (const listener of [...this.listeners]) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
}

function isReport(value: unknown): value is CursorInstancesReport {
  return Boolean(value && typeof value === "object" && Array.isArray((value as CursorInstancesReport).instances));
}

export interface CursorProviderCardProps extends SettingsPageProps {
  host: HostExtensionClient;
  instance?: string;
  instances?: CursorInstances;
  terminal?: HostExtensionClient;
}

const EMPTY_REPORT: CursorInstancesReport = { instances: [] };
const noSubscription = () => () => undefined;

/**
 * One Cursor instance's card on the Providers page: the CLI, its version, the
 * account it is signed in with, and how the instance is set up. The login is
 * the CLI's own: `cursor-agent login`.
 */
export function CursorProviderCard({ host, onNotify, instance = DEFAULT_INSTANCE_ID, instances, terminal }: CursorProviderCardProps) {
  const [status, setStatus] = useState<CursorStatusReport>();
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
      setStatus(await host.invoke("status", { fresh, ...(instance === DEFAULT_INSTANCE_ID ? {} : { instance }) }) as CursorStatusReport);
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
      onNotify(command ? `Cursor runs from ${command}.` : "Cursor is looked up on the PATH again.");
      await read(true);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  const saveInstance = async (next: RuntimeInstanceConfig) => {
    const added = !report.instances.some((entry) => entry.id === next.id);
    const saved = await host.invoke("save-instance", { instance: next });
    if (isReport(saved)) instances?.set(saved);
    onNotify(added ? `Added the Cursor instance “${next.name ?? next.id}”.` : "Saved; the next Cursor session of this instance uses it.");
    if (!added) await read(true);
  };

  const remove = async () => {
    const saved = await host.invoke("remove-instance", { instance });
    if (isReport(saved)) instances?.set(saved);
    onNotify(`Removed the Cursor instance “${view?.label ?? instance}”.`);
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

  const found = Boolean(status?.path);
  const compatibility = status?.compatibility && status.compatibility.status !== "supported" ? status.compatibility : undefined;
  const login = loginCommand(status?.path && /\s/u.test(status.path) ? JSON.stringify(status.path) : status?.command ?? "cursor-agent", view?.home);
  const signedIn = status?.signedIn === true;
  const label = view?.label ?? "Cursor";
  const rows = rowIds(instance);
  const account = found && !status?.unsupported;
  return (
    <Suspense fallback={<SettingsState kind="loading" rows={3} title={`Loading ${label}`} />}>
      <ProgramRows
        program={label}
        idPrefix={rows.prefix}
        help={isDefault
          ? "Threads drive the Cursor CLI over ACP, with the models of your Cursor plan. Tau reads no credential; the CLI signs in itself."
          : "A second Cursor setup: threads started on it keep it, with the login and chats of its own home."}
        {...(status ? { state: {
          found,
          ...(status.version ? { version: status.version } : {}),
          ...(status.path ? { location: status.path } : {}),
          ...(status.message ? { message: status.message } : {}),
          ...(status.unsupported ? { unsupported: true, minimum: MIN_CURSOR_VERSION } : {}),
          ...(status.updateAvailable && status.latest ? { latest: status.latest } : {}),
          ...(status.updateCommand ? { updateCommand: status.updateCommand } : {}),
          ...(compatibility ? { compatibility } : {}),
        } } : {})}
        missing="Install it in a terminal, or set its executable below."
        missingAction={<Button icon={<SquareTerminal size={13} aria-hidden />} onClick={() => void runCommand(INSTALL_COMMAND)}>Install in a terminal</Button>}
        busy={busy}
        {...(error ? { error } : {})}
        onCheck={() => void read(true)}
        onRunCommand={(command) => void runCommand(command)}
      />
      {account ? (
        <>
          <CardBadge source="account" badge={status?.signedIn === undefined ? undefined : signedIn ? { label: "Signed in", tone: "success" } : { label: "Needs sign-in", tone: "warn" }} />
          <SettingRow
            id={rows.account}
            title="Account"
            description={signedIn ? `${status?.account ?? "Signed in"}${status?.plan ? ` · ${status.plan}` : ""}` : status?.signedIn === false ? "Not signed in" : "The CLI did not say who is signed in."}
            {...(signedIn ? {} : { help: "Sign in types the CLI's login into a terminal, pointed at this instance's home; press Enter there and follow it." })}
            control={signedIn ? undefined : <Button icon={<SquareTerminal size={13} aria-hidden />} onClick={() => void runCommand(login)}>Sign in in a terminal</Button>}
          />
          {signedIn ? <SettingRow id={rows.models} title="Models" description={`${status?.models ?? 0} models; pick one and its reasoning effort per thread in the composer.`} /> : null}
        </>
      ) : null}
      <CommandRow
        id={rows.executable}
        program={label}
        commandName="cursor-agent"
        variable="TAU_CURSOR_COMMAND"
        known={status !== undefined}
        {...(status ? { command: status.command } : {})}
        {...(status?.commandSource ? { source: status.commandSource } : {})}
        onSave={saveCommand}
      />
      {view ? (
        <InstanceSetup
          program="Cursor"
          homeVariable={CURSOR_HOME_VARIABLE}
          homePlaceholder="~/.cursor (the CLI's own)"
          commandPlaceholder="cursor-agent"
          instance={view}
          instances={report.instances}
          rowId={rows.setup}
          onSave={saveInstance}
          {...(isDefault ? {} : { onRemove: remove })}
        />
      ) : null}
    </Suspense>
  );
}

/** The element ids of an instance's rows; every instance's card sits on the same page, so each carries its id. */
export function rowIds(instance: string) {
  const prefix = instance === DEFAULT_INSTANCE_ID ? "setting-cursor" : `setting-cursor-${instance}`;
  return { prefix, program: `${prefix}-program`, account: `${prefix}-account`, models: `${prefix}-models`, executable: `${prefix}-executable`, setup: `${prefix}-setup` };
}

/** What the Settings search finds on an instance's card. */
export function searchRows(instance: string, label: string) {
  const ids = rowIds(instance);
  return [
    { id: ids.program, label: `${label} CLI`, keywords: ["cursor", "cursor-agent", "version", "update", "install", "installed", "check"] },
    { id: ids.executable, label: `${label} executable`, keywords: ["cursor-agent", "path", "command", "binary"] },
    { id: ids.setup, label: `${label} instance setup`, keywords: ["cursor", "instance", "home", "environment", "arguments"] },
  ];
}

const dismissedBanners = new Set<string>();

/** Above the composer of a Cursor thread whose version the policy calls unsafe or broken. */
export function createVersionBanner(terminal: () => HostExtensionClient) {
  return function CursorVersionBanner({ snapshot, actions }: RegionProps) {
    const [, setDismissed] = useState(0);
    const kind = snapshot?.backendKind;
    if (!isRuntimeInstanceOf(kind, CURSOR_BACKEND_KIND)) return null;
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
  return instance === DEFAULT_INSTANCE_ID ? "cursor.settings" : `cursor.settings.${instance}`;
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
  function CursorUpdateToasts({ snapshot, actions }: RegionProps) {
    const backends = snapshot?.runtimeBackends;
    useEffect(() => {
      const newer = (backends ?? []).filter((backend) => isRuntimeInstanceOf(backend.kind, CURSOR_BACKEND_KIND) && updateAvailable(backend.version));
      if (newer.length > 0) void load().then((loaded) => loaded.sync(newer, actions), () => undefined);
    }, [backends, actions]);
    return null;
  }
  return Object.assign(CursorUpdateToasts, { refresh: () => void toasts?.then((loaded) => loaded.refresh(), () => undefined) });
}

const DEFAULT_ORDER = 29;

/**
 * Cursor's desktop half: it marks Cursor threads, fills one card per instance
 * on the Providers page and warns above the composer about a CLI Tau cannot
 * drive. The backend itself is the host entry.
 */
export const cursorExtension: DesktopExtension = {
  id: CURSOR_HOST_EXTENSION_ID,
  name: "Cursor",
  activate(plugin) {
    const instances = new CursorInstances();
    const terminal = () => plugin.hostExtension(TERMINAL_HOST_EXTENSION_ID);
    const cards = new Map<string, { label: string; dispose: () => void }>();
    const card = (instance: string) => (props: SettingsPageProps) => <CursorProviderCard {...props} host={plugin.host} instance={instance} instances={instances} terminal={terminal()} />;
    const registerCard = (entry: CursorInstanceView, order: number) => plugin.registerSettingsPage({
      id: settingsPageOf(entry.id),
      label: entry.label,
      profiles: ["desktop", "web"],
      runtime: entry.kind,
      order,
      keywords: ["cursor", "cursor-agent", "acp", "instance", entry.id],
      rows: searchRows(entry.id, entry.label),
      Component: card(entry.id),
    });
    const sync = (report: CursorInstancesReport) => {
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
      label: "Cursor",
      dispose: registerCard({ id: DEFAULT_INSTANCE_ID, kind: CURSOR_BACKEND_KIND, label: "Cursor", threads: 0 }, DEFAULT_ORDER),
    });
    let runner: TerminalRunService | undefined;
    const updateToasts = createUpdateToasts(plugin.host, () => runner);
    const stops = [
      plugin.registerStatusItem({ id: "cursor.runtime", align: "left", order: 44, profiles: ["desktop", "web"], Component: CursorStatus }),
      plugin.registerRegion({ id: "cursor.version", placement: "composer-above", order: 5, profiles: ["desktop", "web", "compact"], Component: createVersionBanner(terminal) }),
      plugin.registerRegion({ id: "cursor.update-toasts", placement: "composer-above", order: 6, profiles: ["desktop", "web", "compact"], Component: updateToasts }),
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

export default cursorExtension;
