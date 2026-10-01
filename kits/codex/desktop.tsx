import { Suspense, lazy, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Gauge, UserRound } from "lucide-react";
import {
  ComposerMenuItem,
  ComposerMenuSection,
  type ComposerControlProps,
  type ComposerSpeedContribution,
  type ComposerSpeedState,
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
  type WorkbenchActions,
} from "tau";
import {
  CODEX_BACKEND_KIND,
  CODEX_HOME_VARIABLE,
  CODEX_HOST_EXTENSION_ID,
  INSTANCES_EVENT,
  MANAGED_CODEX_EVENT,
  MIN_CODEX_VERSION,
  type ChatGPTPlanSummary,
  type CodexInstanceView,
  type CodexInstancesReport,
  type CodexStatusReport,
  type CodexThreadSettings,
  type ManagedCodexState,
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
const SignIn = lazy(() => loadSignInUi().then((module) => ({ default: module.SignInSetup })));

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** "Downloading Codex 0.160.0… 45% (61 of 135 MB)" while Tau fetches its pinned release. */
export function managedProgressLabel(state: ManagedCodexState): string {
  if (state.phase === "extracting") return `Unpacking Codex ${state.version}…`;
  if (state.phase === "failed") return `Tau could not fetch Codex ${state.version}. ${state.error ?? ""}`.trim();
  if (state.phase === "installed") return `Codex ${state.version} is ready.`;
  const total = state.totalBytes ?? 0;
  const done = state.downloadedBytes ?? 0;
  const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
  return total > 0 ? `Downloading Codex ${state.version}… ${Math.floor((done / total) * 100)}% (${mb(done)} of ${mb(total)} MB)` : `Downloading Codex ${state.version}…`;
}

function isManagedState(value: unknown): value is ManagedCodexState {
  return Boolean(value && typeof value === "object" && typeof (value as ManagedCodexState).phase === "string" && typeof (value as ManagedCodexState).version === "string");
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
  /** Terminal Kit's run service, for `codex login` in a shell the user sees. */
  runner?: () => TerminalRunService | undefined;
}

/**
 * One Codex instance's card on the Providers page: the installed CLI, whether
 * it is current and a version Tau works with, who it is signed in as, where
 * Tau finds it and how the instance is set up. The default instance's card
 * adds another instance. A plan connection uses Tau’s managed binary and
 * the credentials Tau keeps; CLI connections use the user’s installation.
 */
export function CodexProviderCard({ host, onNotify, instance = DEFAULT_INSTANCE_ID, instances, terminal, runner }: CodexProviderCardProps) {
  const [status, setStatus] = useState<CodexStatusReport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [install, setInstall] = useState<ManagedCodexState>();
  const actions = useShellActions();
  const report = useSyncExternalStore(instances?.subscribe ?? noSubscription, () => instances?.snapshot ?? EMPTY_REPORT);
  const isDefault = instance === DEFAULT_INSTANCE_ID;
  const scope = isDefault ? {} : { instance };
  const view = report.instances.find((entry) => entry.id === instance);

  const read = useCallback(async (fresh: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await host.invoke("status", { fresh, ...(instance === DEFAULT_INSTANCE_ID ? {} : { instance }) }) as CodexStatusReport;
      setStatus(next);
      setInstall(next.managedInstall);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }, [host, instance]);

  useEffect(() => { void read(false); }, [read]);
  // One download serves every instance; a card shows it only while its instance waits for it.
  useEffect(() => host.onEvent(MANAGED_CODEX_EVENT, (payload) => {
    if (!isManagedState(payload)) return;
    if (payload.phase === "installed") { setInstall(undefined); void read(true); }
    else setInstall((held) => held || (status?.chatgptPlan && !status.commandSource) || status?.managedInstall ? payload : held);
  }), [host, read, status]);

  const installManaged = () => {
    setBusy(true);
    setError(undefined);
    void host.invoke("managed-codex-install", scope).then(() => read(true)).catch((failure) => { setError(errorMessage(failure)); setBusy(false); });
  };

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

  const run = runner?.();
  const rows = rowIds(instance);
  const label = view?.label ?? "Codex";
  const compatibility = status?.compatibility && status.compatibility.status !== "supported" ? status.compatibility : undefined;
  return (
    <Suspense fallback={<SettingsState kind="loading" rows={3} title={`Loading ${label}`} />}>
      <ProgramRows
        program={label}
        idPrefix={rows.prefix}
        help="Continue with ChatGPT to let Tau use your plan and manage Codex. Each instance keeps its own account and threads. You can also use an installed CLI and its login."
        {...(status ? { state: {
          found: Boolean(status.path),
          ...(status.version ? { version: status.version } : {}),
          ...(status.path ? { location: status.path } : {}),
          ...(status.message ? { message: status.message } : {}),
          ...(status.unsupported ? { unsupported: true, minimum: MIN_CODEX_VERSION } : {}),
          ...(status.updateAvailable && status.latest ? { latest: status.latest } : {}),
          ...(status.updateCommand ? { updateCommand: status.updateCommand } : {}),
          ...(compatibility ? { compatibility } : {}),
        } } : {})}
        missing="Continue with ChatGPT below to download Codex automatically, or set an installed executable."
        busy={busy}
        {...(error ? { error } : {})}
        onCheck={() => void read(true)}
        onRunCommand={(command) => void runCommand(command)}
      />
      <SignIn
        host={host}
        target={instance}
        program={label}
        rowId={rows.account}
        {...(run ? { runInTerminal: (command: string) => run.run({ command, label: `Sign in to ${label}` }, actions) } : {})}
        openExternal={(url) => actions ? actions.openExternal(url) : void window.open(url, "_blank", "noopener")}
        copyText={(text) => actions?.copyText(text) ?? navigator.clipboard.writeText(text)}
        onNotify={onNotify}
        onReport={(next) => { if (next.flow?.phase === "succeeded") void read(false); }}
      />
      {install && install.phase !== "failed" ? (
        <SettingRow id={`${rows.program}-managed`} title="Managed Codex" description="Tau fetches the Codex release this version of Tau is tested with. Threads of this instance start once it is ready."
          status={<p role="status">{managedProgressLabel(install)}</p>} />
      ) : status?.chatgptPlan?.needsInstall || install?.phase === "failed" ? (
        <SettingRow id={`${rows.program}-managed`} title="Managed Codex" description="Install or repair the Codex release tested with this Tau version."
          {...(install?.phase === "failed" ? { status: <p role="alert">{managedProgressLabel(install)}</p> } : {})}
          control={<button type="button" className="settings-button" disabled={busy} onClick={installManaged}>{install?.phase === "failed" ? "Try again" : "Install managed Codex"}</button>} />
      ) : null}
      {status?.chatgptPlan ? (
        <SettingRow id={`${rows.account}-usage`} title={status.chatgptPlan.signedIn ? "Using ChatGPT plan" : "ChatGPT account"}
          description={`${status.chatgptPlan.label}. Each instance keeps one account. Add an instance to use another account.`}
          control={<button type="button" className="settings-button" onClick={() => actions ? actions.openExternal(status.chatgptPlan!.usageUrl) : void window.open(status.chatgptPlan!.usageUrl, "_blank", "noopener")}>Manage usage</button>} />
      ) : null}
      {status?.codexHome ? (
        <SettingRow
          id={rows.home}
          title="Home"
          description={<><code>{status.codexHome}</code>{status.models ? ` · ${status.models} models; pick one and its reasoning effort per thread in the composer.` : ""}</>}
        />
      ) : null}
      <CommandRow
        id={rows.executable}
        program={label}
        commandName="codex"
        variable="TAU_CODEX_COMMAND"
        known={status !== undefined}
        {...(status ? { command: status.command } : {})}
        {...(status?.commandSource ? { source: status.commandSource } : {})}
        placeholder="codex, from your login shell's PATH"
        onSave={saveCommand}
      />
      <SettingRow title="Separate CLI account" description={<>CLI accounts sharing <code>CODEX_HOME</code> use <code>TAU_CODEX_AUTH_HOME</code> with a different fresh folder in this instance's environment below. Managed ChatGPT accounts can share the same explicitly configured home below while Tau keeps their credentials private. Configure shared homes before starting threads, then switch accounts from the composer menu.</>} />
      {view ? (
        <InstanceSetup
          program="Codex"
          homeVariable={CODEX_HOME_VARIABLE}
          homePlaceholder="~/.codex"
          commandPlaceholder="codex"
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
  const prefix = instance === DEFAULT_INSTANCE_ID ? "setting-codex" : `setting-codex-${instance}`;
  return { prefix, program: `${prefix}-program`, account: `${prefix}-account`, home: `${prefix}-home`, executable: `${prefix}-executable`, setup: `${prefix}-setup` };
}

/** What the Settings search finds on an instance's card. */
export function searchRows(instance: string, label: string) {
  const ids = rowIds(instance);
  return [
    { id: ids.program, label: `${label} CLI`, keywords: ["codex", "version", "update", "install", "installed", "check"] },
    { id: ids.account, label: `${label} account`, keywords: ["codex", "sign in", "sign out", "login", "chatgpt", "api key"] },
    { id: ids.executable, label: `${label} executable`, keywords: ["codex", "path", "command", "binary"] },
    { id: ids.setup, label: `${label} instance setup`, keywords: ["codex", "instance", "home", "CODEX_HOME", "environment", "arguments"] },
  ];
}

const EMPTY_REPORT: CodexInstancesReport = { instances: [] };
const noSubscription = () => () => undefined;

/** Dismissed per instance, version and verdict for as long as the window lives. */
const dismissedBanners = new Set<string>();

/** The account that will pay for this thread's next turn. */
export function createChatGPTPlanBanner(host: HostExtensionClient) {
  return function ChatGPTPlanBanner({ snapshot, actions }: RegionProps) {
    const kind = snapshot?.backendKind;
    const threadId = snapshot?.sessionId;
    const [plan, setPlan] = useState<ChatGPTPlanSummary>();
    const [limited, setLimited] = useState(false);
    const [install, setInstall] = useState<ManagedCodexState>();
    useEffect(() => {
      let active = true;
      setPlan(undefined);
      setLimited(false);
      setInstall(undefined);
      if (!isRuntimeInstanceOf(kind, CODEX_BACKEND_KIND)) return;
      let account = runtimeInstanceId(kind!);
      let request = 0;
      const read = () => {
        const current = ++request;
        void host.invoke("chatgpt-plan-account", { instance: runtimeInstanceId(kind!), ...(threadId ? { threadId } : {}) }).then((value) => {
          if (!active || current !== request) return;
          const summary = value as ChatGPTPlanSummary | undefined;
          account = summary?.instance ?? runtimeInstanceId(kind!);
          setPlan(summary);
        }).catch(() => undefined);
      };
      read();
      const stop = host.onEvent("sign-in", read);
      const stopSettings = host.onEvent("thread-settings", (value) => {
        if ((value as { threadId?: string })?.threadId !== threadId) return;
        setLimited(false);
        read();
      });
      const stopLimits = host.onEvent("chatgpt-plan-limit", (value) => { if ((value as { instance?: string })?.instance === account) setLimited(true); });
      const stopInstall = host.onEvent(MANAGED_CODEX_EVENT, (value) => {
        if (!isManagedState(value) || !active) return;
        setInstall(value.phase === "installed" ? undefined : value);
        if (value.phase === "installed") read();
      });
      return () => { active = false; stop(); stopSettings(); stopLimits(); stopInstall(); };
    }, [kind, threadId]);
    useEffect(() => { if (snapshot?.isStreaming) setLimited(false); }, [snapshot?.isStreaming]);
    if (!plan?.signedIn) return null;
    return <div className="runtime-version-banner"><div className="runtime-version-banner-body"><strong>Using ChatGPT plan · {plan.label}</strong>{install ? <p role="status">{managedProgressLabel(install)}</p> : null}{limited ? <p>ChatGPT plan usage is unavailable. Review your app limits and credits in ChatGPT.</p> : null}<div className="runtime-version-banner-actions"><button type="button" onClick={() => actions.openExternal(plan.usageUrl)}>Manage usage</button></div></div></div>;
  };
}

/** The tier the thinking chip calls Fast: Codex's `fast`, else the first that says it is faster. */
export const fastTier = (settings: CodexThreadSettings | undefined) => settings?.serviceTier.choices.find((tier) => tier.id === "fast")
  ?? settings?.serviceTier.choices.find((tier) => /fast|priority/iu.test(tier.name));

/** Fast for Codex threads, drawn by core in the thinking chip (K142); a draft has none until its thread runs. */
export function createCodexSpeed(host: HostExtensionClient): ComposerSpeedContribution {
  let asked: string | undefined;
  let threadId: string | undefined;
  let held: ComposerSpeedState | undefined;
  let stopEvents: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = (settings: CodexThreadSettings | undefined) => {
    const tier = fastTier(settings);
    held = tier
      ? { fast: settings!.serviceTier.selected === tier.id, available: true, ...(tier.description ? { detail: tier.description } : {}) }
      : { fast: false, available: false, reason: settings ? "This account and model offer no Fast tier on Codex" : "Codex sets Fast once the thread runs" };
    for (const listener of listeners) listener();
  };
  const read = () => {
    const asking = threadId;
    if (!asking) { publish(undefined); return; }
    void host.invoke("thread-settings", { threadId: asking }).then((value) => { if (asking === threadId) publish(value as CodexThreadSettings); }, () => { if (asking === threadId) publish(undefined); });
  };
  return {
    id: "codex.speed",
    profiles: ["desktop", "web", "compact"],
    read(snapshot) {
      if (!isRuntimeInstanceOf(snapshot?.backendKind, CODEX_BACKEND_KIND)) return undefined;
      const key = `${snapshot?.sessionId}|${snapshot?.model?.id}`;
      if (key !== asked) { asked = key; threadId = snapshot?.sessionId; read(); }
      return held;
    },
    subscribe(listener) {
      listeners.add(listener);
      stopEvents ??= host.onEvent("thread-settings", read);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) { stopEvents?.(); stopEvents = undefined; }
      };
    },
    async set(fast, snapshot) {
      const id = snapshot?.sessionId;
      const tier = fastTier(await host.invoke("thread-settings", { threadId: id }) as CodexThreadSettings);
      publish(await host.invoke("set-thread-tier", { threadId: id, tier: fast && tier ? tier.id : null }) as CodexThreadSettings);
    },
  };
}

export function createThreadSettingsControl(host: HostExtensionClient) {
  return function CodexThreadSettingsControl({ snapshot, actions }: ComposerControlProps) {
    const [state, setState] = useState<CodexThreadSettings>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const threadId = snapshot?.sessionId;
    const currentThread = useRef(threadId);
    currentThread.current = threadId;
    const isCodex = isRuntimeInstanceOf(snapshot?.backendKind, CODEX_BACKEND_KIND);
    useEffect(() => {
      let active = true;
      setState(undefined);
      setBusy(false);
      setError(undefined);
      if (!isCodex || !threadId) return;
      const read = () => void host.invoke("thread-settings", { threadId }).then((value) => {
        if (active) { setState(value as CodexThreadSettings); setError(undefined); }
      }).catch((failure) => { if (active) setError(errorMessage(failure)); });
      read();
      const stop = host.onEvent("thread-settings", read);
      const stopInstances = host.onEvent(INSTANCES_EVENT, read);
      const stopLogin = host.onEvent("sign-in", read);
      return () => { active = false; stop(); stopInstances(); stopLogin(); };
    }, [isCodex, threadId, snapshot?.model?.id, snapshot?.isStreaming]);
    if (!isCodex || !threadId) return null;
    const change = async (command: string, input: Record<string, unknown>) => {
      setBusy(true);
      setError(undefined);
      try {
        const value = await host.invoke(command, { threadId, ...input }) as CodexThreadSettings;
        if (currentThread.current === threadId) setState(value);
      }
      catch (failure) { const message = errorMessage(failure); if (currentThread.current === threadId) setError(message); actions?.notify(message); }
      finally { if (currentThread.current === threadId) setBusy(false); }
    };
    const disabled = busy || Boolean(snapshot?.isStreaming);
    // Fast is the thinking chip's; the menu keeps any other tier.
    const fast = fastTier(state);
    const tiers = state?.serviceTier.choices.filter((tier) => tier !== fast && tier.id !== "default") ?? [];
    return <>
      <ComposerMenuSection heading="Codex account">
        {state?.accounts.map((account) => <ComposerMenuItem key={account.id} icon={<UserRound size={13} />} label={account.label} selected={account.id === state.account} disabled={disabled || Boolean(account.reason)} disabledReason={account.reason ?? "Wait for Codex to finish"} onSelect={() => void change("switch-thread-account", { account: account.id })} />)}
        {error ? <div role="alert">{error}</div> : null}
      </ComposerMenuSection>
      {state && tiers.length ? <ComposerMenuSection heading="Codex service tier">
        <ComposerMenuItem icon={<Gauge size={13} />} label="Provider default" detail={state.serviceTier.choices.find((tier) => tier.id === state.serviceTier.defaultTier)?.name} selected={state.serviceTier.selected === null} disabled={disabled} disabledReason="Wait for Codex to finish" onSelect={() => void change("set-thread-tier", { tier: null })} />
        {tiers.map((tier) => <ComposerMenuItem key={tier.id} icon={<Gauge size={13} />} label={tier.name} detail={tier.description} selected={state.serviceTier.selected === tier.id} disabled={disabled} disabledReason="Wait for Codex to finish" onSelect={() => void change("set-thread-tier", { tier: tier.id })} />)}
      </ComposerMenuSection> : null}
    </>;
  };
}

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
  function CodexUpdateToasts({ snapshot, actions }: RegionProps) {
    const backends = snapshot?.runtimeBackends;
    useEffect(() => {
      const newer = (backends ?? []).filter((backend) => isRuntimeInstanceOf(backend.kind, CODEX_BACKEND_KIND) && updateAvailable(backend.version));
      if (newer.length > 0) void load().then((loaded) => loaded.sync(newer, actions), () => undefined);
    }, [backends, actions]);
    return null;
  }
  // Terminal Kit may activate after this one: an offer already shown gains Update then.
  return Object.assign(CodexUpdateToasts, { refresh: () => void toasts?.then((loaded) => loaded.refresh(), () => undefined) });
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
    plugin.registerComposerControl({ id: "codex.thread-settings", placement: "menu", order: 21, profiles: ["desktop", "web", "compact"], Component: createThreadSettingsControl(plugin.host) });
    plugin.registerComposerSpeed(createCodexSpeed(plugin.host));
    const instances = new CodexInstances();
    const terminal = () => plugin.hostExtension(TERMINAL_HOST_EXTENSION_ID);
    const cards = new Map<string, { label: string; dispose: () => void }>();
    let runner: TerminalRunService | undefined;
    const card = (instance: string) => (props: SettingsPageProps) => <CodexProviderCard {...props} host={plugin.host} instance={instance} instances={instances} terminal={terminal()} runner={() => runner} />;
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
      rows: searchRows(entry.id, entry.label),
      // The rows the Runtimes page's Update, Install and "Add a custom runtime" open.
      runtimeRows: { program: rowIds(entry.id).program, ...(entry.id === DEFAULT_INSTANCE_ID ? { addInstance: `${rowIds(entry.id).setup}-add` } : {}) },
      Component: card(entry.id),
    });
    cards.set(DEFAULT_INSTANCE_ID, {
      label: "Codex",
      dispose: registerCard({ id: DEFAULT_INSTANCE_ID, kind: CODEX_BACKEND_KIND, label: "Codex", threads: 0 }, DEFAULT_ORDER),
    });
    const updateToasts = createUpdateToasts(plugin.host, () => runner);
    const stops = [
      plugin.registerRegion({ id: "codex.chatgpt-plan", placement: "composer-above", order: 4, profiles: ["desktop", "web", "compact"], Component: createChatGPTPlanBanner(plugin.host) }),
      plugin.registerRegion({ id: "codex.version", placement: "composer-above", order: 5, profiles: ["desktop", "web", "compact"], Component: createVersionBanner(terminal) }),
      plugin.registerRegion({ id: "codex.update-toasts", placement: "composer-above", order: 6, profiles: ["desktop", "web", "compact"], Component: updateToasts }),
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

export default codexExtension;
