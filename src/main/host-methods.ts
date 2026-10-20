import { HOST_CORE_COMMANDS } from "../shared/host-core-commands.js";
import { bindHostCommand } from "./host-command-handler.js";
import { HOST_COMMANDS } from "../shared/host-command-contract.js";
import { createHash } from "node:crypto";
import type {
  DesktopExtensionLoadResult,
  ExtensionInspection,
  ExtensionPackageSummary,
  HostBootstrap,
  UiImagePreview,
  UiSharedFile,
  WorkbenchBuildResult,
} from "../shared/contracts.js";
import { HOST_ERROR, jobMethodKey } from "../shared/host-transport.js";
import { type SystemNotification, type SystemNotificationOutcome } from "../shared/system-attention.js";
import { type MenuPoint, type NativeMenuEntry } from "../shared/context-menu.js";
import { type ReleaseNotes, type WindowAction } from "../shared/window-shell.js";
import type { PiHost } from "./pi-host.js";
import { defaultUserThemeResolver } from "./user-themes.js";
import { openExternalEditor } from "./external-editor.js";
import { HostJobRunner, NO_JOB_CONTEXT, type HostMethodContext } from "./host-jobs.js";
import { isHostOwner, runAsCaller, WORKBENCH_CLIENT_PRINCIPAL, type HostInvocationPrincipal } from "./host-invocation.js";
import { createConnectionsMethods, type HostConnectionsService } from "./host-connections.js";
import { createConnectMethods, type HostConnect } from "./host-connect.js";
import { createHostServiceMethods, type HostServiceManager } from "./host-service.js";
import { createMachineMethods, type HostMachines } from "./host-machines.js";
import { MachineKitRoute } from "./machine-kit-route.js";
import { createMachinePairingMethods, localWindowPort } from "./host-machine-pairing.js";
import type { ClientCalls } from "./client-calls.js";
import { createResourceMethods, type HostResourceSampler } from "./host-resources.js";
import { createBlobMethods, type HostBlobStore } from "./host-blobs.js";
import { createUpdateMethods, type HostUpdater } from "./host-updater.js";
import { authorizeMethod, ownerRefusal } from "./host-method-access.js";
import { createEnvironmentMethods, type EnvironmentsService } from "./environment-methods.js";

/** One method of the host protocol. Params arrive positionally and untrusted. */
export type HostMethod = (params: readonly unknown[], context: HostMethodContext) => Promise<unknown>;
export type HostMethodTable = Record<string, HostMethod>;

/** What a method needs from the machine the host runs on. */
export interface HostMethodPlatform {
  copyText(text: string): Promise<void>;
  copyImage(dataUrl: string): Promise<void>;
  readImagePreview(path: string): Promise<UiImagePreview | undefined>;
  /** A URL the page may load a workspace file from; absent where no window serves files. */
  shareFile?(path: string): Promise<UiSharedFile>;
  inspectExtensions(cwd: string): Promise<ExtensionInspection>;
  /** Native consent; undefined means no native window, false means refusal. */
  confirmExtensionGrant?(pkg: ExtensionPackageSummary): Promise<boolean | undefined>;
  /** `only` narrows the build to those extension ids; the client keeps every other module it has. */
  loadDesktopExtensions(cwd: string, sharedExports: Record<string, string[]>, only?: readonly string[]): Promise<DesktopExtensionLoadResult>;
  rebuildWorkbench(context: HostMethodContext, activeWorkspace: string): Promise<WorkbenchBuildResult>;
  workbenchSource(): Promise<string | undefined>;
  relaunchWorkbench(): void;
  /** Restarts into the downloaded update; false when none is waiting. */
  installUpdate(): boolean;
  /** Resolves once the user clicked or dismissed it; a click has already brought the window forward. */
  notify(notification: SystemNotification): Promise<SystemNotificationOutcome>;
  /** The count on the app's icon; 0 clears it. */
  setBadge(count: number): void;
  /** A menu the OS draws at a point of the window; answers the chosen id. Absent where no window draws one. */
  showContextMenu?(entries: NativeMenuEntry[], point: MenuPoint): Promise<string | undefined>;
  /** The app around the workbench: menu, quit, release notes (`src/shared/window-shell.ts`). Absent without a window. */
  windowAction?(action: WindowAction): Promise<unknown>;
}

/**
 * The half of the platform a client answers for itself. A window that is only
 * a protocol client implements exactly this and refuses the rest, so the
 * clipboard, the image preview and the workbench build stay where the user is
 * rather than travelling to the host process (ADR 0021).
 */
export interface ClientHostPlatform {
  copyText(text: string): Promise<void>;
  copyImage(dataUrl: string): Promise<void>;
  readImagePreview(path: string): Promise<UiImagePreview | undefined>;
  shareFile?(path: string): Promise<UiSharedFile>;
  /** `cwd` is passed on as the client received it; only a host resolves an id. */
  loadDesktopExtensions(cwd: string, sharedExports: Record<string, string[]>, only?: readonly string[]): Promise<DesktopExtensionLoadResult>;
  rebuildWorkbench(context: HostMethodContext): Promise<WorkbenchBuildResult>;
  workbenchSource(): Promise<string | undefined>;
  relaunchWorkbench(): void;
  /** Restarts into the downloaded update; false when none is waiting. */
  installUpdate(): boolean;
  notify(notification: SystemNotification): Promise<SystemNotificationOutcome>;
  setBadge(count: number): void;
  showContextMenu?(entries: NativeMenuEntry[], point: MenuPoint): Promise<string | undefined>;
  windowAction?(action: WindowAction): Promise<unknown>;
  /** The machines this window knows (ADR 0025); only a window beside a supervised host has them. */
  environments?(): EnvironmentsService | undefined;
}

function shareFile(platform: { shareFile?(path: string): Promise<UiSharedFile> }, path: string): Promise<UiSharedFile> {
  if (!platform.shareFile) throw Object.assign(new Error("This client serves no files to the page."), { code: HOST_ERROR.unsupported });
  return platform.shareFile(path);
}

async function windowAction(platform: { windowAction?(action: WindowAction): Promise<unknown> }, params: readonly [WindowAction]): Promise<unknown> {
  if (!platform.windowAction) throw Object.assign(new Error("This client has no window of its own."), { code: HOST_ERROR.unsupported });
  return platform.windowAction(params[0]);
}

async function contextMenu(platform: { showContextMenu?(entries: NativeMenuEntry[], point: MenuPoint): Promise<string | undefined> }, params: readonly [NativeMenuEntry[], MenuPoint]): Promise<{ id?: string }> {
  if (!platform.showContextMenu) throw Object.assign(new Error("This client draws no native menus."), { code: HOST_ERROR.unsupported });
  const id = await platform.showContextMenu(params[0], params[1]);
  return id === undefined ? {} : { id };
}

/**
 * The client-side half of the method table, for a window whose host lives in
 * another process. Its names are `CLIENT_SIDE_METHODS`; everything else in
 * that window's table refuses with `unsupported`.
 */
export function createClientHostMethods(platform: ClientHostPlatform): HostMethodTable {
  return {
    "copy-text": bindHostCommand(HOST_CORE_COMMANDS["copy-text"], async (params) => platform.copyText(params[0])),
    "copy-image": bindHostCommand(HOST_CORE_COMMANDS["copy-image"], async (params) => platform.copyImage(params[0])),
    "read-image-preview": bindHostCommand(HOST_CORE_COMMANDS["read-image-preview"], async (params) => platform.readImagePreview(params[0])),
    "share-file": bindHostCommand(HOST_CORE_COMMANDS["share-file"], async (params) => shareFile(platform, params[0])),
    "desktop-extensions": bindHostCommand(HOST_CORE_COMMANDS["desktop-extensions"], async (params) => platform.loadDesktopExtensions(
      params[0],
      params[1],
      params[2],
    )),
    "rebuild-workbench": bindHostCommand(HOST_CORE_COMMANDS["rebuild-workbench"], async (_params, context) => platform.rebuildWorkbench(context)),
    "workbench-source": bindHostCommand(HOST_CORE_COMMANDS["workbench-source"], async () => ({ path: await platform.workbenchSource() })),
    "relaunch-workbench": bindHostCommand(HOST_CORE_COMMANDS["relaunch-workbench"], async () => platform.relaunchWorkbench()),
    "install-update": bindHostCommand(HOST_CORE_COMMANDS["install-update"], async () => ({ installing: platform.installUpdate() })),
    "notify": bindHostCommand(HOST_CORE_COMMANDS["notify"], async (params) => platform.notify(params[0])),
    "set-badge": bindHostCommand(HOST_CORE_COMMANDS["set-badge"], async (params) => platform.setBadge(params[0])),
    "context-menu": bindHostCommand(HOST_CORE_COMMANDS["context-menu"], async (params) => contextMenu(platform, params)),
    "window-action": bindHostCommand(HOST_CORE_COMMANDS["window-action"], async (params) => windowAction(platform, params)),
    ...createEnvironmentMethods(() => platform.environments?.()),
  };
}

export interface HostMethodDeps {
  /** Answers to the calls this host made into a client's process, when it makes any; `from` is the answering connection. */
  clientCalls?: { settle(callId: string, result: unknown, error: string | undefined, from: string | undefined): void }
    & Partial<Pick<ClientCalls, "call" | "hasLocalWindow" | "confirmExtensionGrant">>;
  /** Starts the host on the first call; later calls read what is already running. */
  bootstrap(): Promise<HostBootstrap>;
  /** Resolves once the host finished starting; it never asks for a bootstrap first. */
  requireHost(): Promise<PiHost>;
  /** The host as it is, for calls that must not queue behind readiness. */
  host(): PiHost | undefined;
  jobs: HostJobRunner;
  platform: HostMethodPlatform;
  /** Who else may connect (ADR 0023); absent where no socket listens. */
  connections?(): HostConnectionsService | undefined;
  connect?(): HostConnect | undefined;
  externalMcp?(): Pick<import("./external-mcp-http.js").ExternalMcpHttp, "manage"> | undefined;
  /** The host's machine running it as a service; absent for a host in the window's process. */
  service?(): HostServiceManager | undefined;
  /** Other machines this host's agents reach (ADR 0027); absent for a host in the window's process. */
  machines?(): HostMachines | undefined;
  machineRoutes?: MachineKitRoute;
  /** The machine's load, for `host-resources`; absent for a host in the window's process. */
  resources?(): HostResourceSampler | undefined;
  /** Native clients read capability responses through their authenticated connection. */
  browserResources?: Pick<import("./host-browser-resources.js").HostBrowserResourceStore, "readForClient">;
  /** Files other machines send here; absent for a host in the window's process. */
  blobs?(): HostBlobStore | undefined;
  /** The machine's own Tau updates (K103); absent for a host in the window's process. */
  updates?(): HostUpdater | undefined;
  /** Public release information, readable by paired clients without a native window. */
  releaseNotes?: { get(version: string, fromVersion?: string): Promise<ReleaseNotes[]> };
}

const JOB_CONTROL_METHODS = new Set(["start-job", "cancel-job", "job-methods"]);
/** Private results must not become jobs: job results are broadcast and kept for replay. */
const PRIVATE_RESULT_METHODS = new Set(["connections-host-token", "connections-rotate-host-token", "read-browser-resource"]);
/** Calls that can wait on a runtime starting or reopening, which outlasts a remote request's timeout on a busy host. */
const DECLARED_JOB_METHODS = Object.entries(HOST_COMMANDS).flatMap(([method, declaration]) => declaration.job ? [method] : []);

/**
 * Every renderer-callable operation of the host, by protocol method name. The
 * table is the contract: a transport only moves frames in and out of it.
 */
export function createHostMethods(deps: HostMethodDeps): HostMethodTable {
  const { platform } = deps;
  const host = () => deps.requireHost();
  const routes = deps.machineRoutes ?? new MachineKitRoute({ machines: () => deps.machines?.(), active: () => deps.host()?.activeThreadIdentity(), routing: (id) => deps.host()?.hostExtensionMachineRouting?.(id), observeRouting: (listener) => deps.host()?.observeHostExtensionMachineRouting?.(listener) });
  const invokeExtension = async (params: readonly [string, string, unknown], context: HostMethodContext): Promise<unknown> => {
    const extensionId = params[0];
    const command = params[1];
    const instance = await host();
    const route = routes.routeOf(extensionId, params[2], command);
    if (route) {
      await instance.authorizeHostExtension(extensionId, command, params[2], context.principal);
      return routes.call(route, extensionId, command, () => instance.invokeHostExtension(extensionId, command, undefined, context.principal));
    }
    return routes.localResult(extensionId, command, await instance.invokeHostExtension(extensionId, command, params[2], context.principal));
  };
  // A client names a workspace by its id; one that still speaks paths sends a path.
  const resolveWorkspace = (instance: PiHost, named: string): string => {
    try { return instance.resolveWorkspacePath(named); } catch (error) {
      const machine = routes.machineName(named);
      if (machine) throw new Error(`This project is on ${machine}. Choose ${machine} under Run on to start a thread there.`, { cause: error });
      throw error;
    }
  };
  // Kit bundles are files on disk: a host that exists names the workspace while its start still runs.
  const workspaceWhileStarting = async (named: string): Promise<string> => {
    const starting = deps.host();
    if (starting) {
      try { return starting.resolveWorkspacePath(named); } catch { /* an id the start has yet to learn */ }
    }
    return resolveWorkspace(await host(), named);
  };

  const methods: HostMethodTable = {
    "bootstrap": bindHostCommand(HOST_CORE_COMMANDS["bootstrap"], async () => deps.bootstrap()),
    "transcript-page": bindHostCommand(HOST_CORE_COMMANDS["transcript-page"], async (params) => (await host()).loadTranscript(
      params[0],
      params[1],
    )),
    "prepare-prompt": bindHostCommand(HOST_COMMANDS["prepare-prompt"], async ([text, sessionId, skill, backendKind, workspace]) => (await host()).preparePrompt(text, sessionId, skill, backendKind, workspace === undefined ? undefined : resolveWorkspace(await host(), workspace))),
    "composer-commands": bindHostCommand(HOST_COMMANDS["composer-commands"], async ([backendKind, workspace]) => (await host()).composerCommandsFor(backendKind, resolveWorkspace(await host(), workspace))),
    "prompt": bindHostCommand(HOST_COMMANDS["prompt"], async (args) => (await host()).prompt(...args)),
    "run-shell-action": bindHostCommand(HOST_COMMANDS["run-shell-action"], async ([command, includeInContext, expectedCwd]) => (await host()).runShellAction(command, includeInContext, expectedCwd === undefined ? undefined : resolveWorkspace(await host(), expectedCwd))),
    "steer": bindHostCommand(HOST_COMMANDS["steer"], async (args) => (await host()).steer(...args)),
    "follow-up": bindHostCommand(HOST_COMMANDS["follow-up"], async (args) => (await host()).followUp(...args)),
    "queue-message": bindHostCommand(HOST_COMMANDS["queue-message"], async ([sessionId, text, attachments, skillDraft, deliverAt, identity]) => {
      const queued = await (await host()).queue.submit(sessionId, { text, attachments: attachments ?? [], ...(skillDraft ? { skillDraft } : {}), ...(deliverAt !== undefined ? { deliverAt } : {}), ...(identity ? { identity } : {}) });
      return { id: queued.id };
    }),
    "take-queued": bindHostCommand(HOST_COMMANDS["take-queued"], async ([sessionId, queuedId]) => (await host()).queue.take(sessionId, queuedId).map(({ id, text, attachments, skillDraft, wake, deliverAt }) => ({ id, text, attachments, ...(skillDraft ? { skillDraft } : {}), ...(wake ? { wake } : {}), ...(deliverAt !== undefined ? { deliverAt } : {}) }))),
    "move-queued": bindHostCommand(HOST_COMMANDS["move-queued"], async (args) => (await host()).queue.move(...args)),
    "plan-queued": bindHostCommand(HOST_COMMANDS["plan-queued"], async (args) => (await host()).queue.reschedule(...args)),
    "resume-limited": bindHostCommand(HOST_COMMANDS["resume-limited"], async ([sessionId, when]) => {
      const limits = (await host()).limits;
      if (when === "now") return limits.resumeNow(sessionId);
      if (when === "reset") return void limits.resumeAtReset(sessionId);
      return limits.cancelResume(sessionId);
    }),
    "thread-goal": bindHostCommand(HOST_COMMANDS["thread-goal"], async (args) => (await host()).threadGoal(...args)),
    "thread-background-stop": bindHostCommand(HOST_COMMANDS["thread-background-stop"], async (args) => (await host()).controls.stopBackground(...args)),
    "abort": bindHostCommand(HOST_COMMANDS["abort"], async ([sessionId]) => deps.host()?.abort(sessionId)),
    "new-session": bindHostCommand(HOST_COMMANDS["new-session"], async ([initialPrompt, attachments, cwd, identity, prepared, configuration]) => (await host()).newSession(initialPrompt, attachments, cwd === undefined ? undefined : resolveWorkspace(await host(), cwd), identity, prepared, configuration)),
    "start-thread": bindHostCommand(HOST_COMMANDS["start-thread"], async ([options]) => {
      const instance = await host();
      const started = await instance.startThread({ ...options, cwd: resolveWorkspace(instance, options.cwd) });
      const path = instance.threadPath(started.sessionId);
      if (!path) throw new Error("The started thread is missing from the host's index.");
      return { ...started, path };
    }),
    "send-to-thread": bindHostCommand(HOST_COMMANDS["send-to-thread"], async ([sessionId, text, delivery, identity]) => {
      const instance = await host();
      if (identity) await instance.sendToThread(sessionId, text, delivery, undefined, [], undefined, identity);
      else await instance.sendToThread(sessionId, text, delivery);
      return null;
    }),
    "prepared-thread-capability": bindHostCommand(HOST_COMMANDS["prepared-thread-capability"], async ([cwd]) => (await host()).getPreparedThreadCapability(cwd === undefined ? undefined : resolveWorkspace(await host(), cwd))),
    "fork-thread": bindHostCommand(HOST_CORE_COMMANDS["fork-thread"], async (params) => (await host()).forkThread(
      params[0],
      params[1],
      (params[2] === undefined ? undefined : resolveWorkspace(await host(), params[2])),
      params[3],
    )),
    "thread-tree": bindHostCommand(HOST_CORE_COMMANDS["thread-tree"], async (params) => (await host()).threadTree(params[0])),
    "navigate-thread-tree": bindHostCommand(HOST_CORE_COMMANDS["navigate-thread-tree"], async (params) => (await host()).navigateThreadTree(
      params[0],
      params[1],
      params[2],
    )),
    "duplicate-thread": bindHostCommand(HOST_CORE_COMMANDS["duplicate-thread"], async (params) => (await host()).duplicateThread(params[0])),
    "switch-session": bindHostCommand(HOST_CORE_COMMANDS["switch-session"], async (params) => (await host()).switchSession(params[0])),
    "set-model": bindHostCommand(HOST_CORE_COMMANDS["set-model"], async (params) => (await host()).setModel(
      params[0],
      params[1],
      params[2],
    )),
    "set-thinking": bindHostCommand(HOST_CORE_COMMANDS["set-thinking"], async (params) => (await host()).setThinkingLevel(
      params[0],
      params[1],
    )),
    "set-mode": bindHostCommand(HOST_CORE_COMMANDS["set-mode"], async (params) => (await host()).setMode(
      params[0],
      params[1],
    )),
    "compact-context": bindHostCommand(HOST_CORE_COMMANDS["compact-context"], async (params) => (await host()).compactContext(params[0])),
    "compact-and-send": bindHostCommand(HOST_COMMANDS["compact-and-send"], async ([sessionId, prompt]) => (await host()).compactContext(sessionId, prompt)),
    "restart-session": bindHostCommand(HOST_CORE_COMMANDS["restart-session"], async (params) => (await host()).restartSession(params[0])),
    "reload-runtime": bindHostCommand(HOST_CORE_COMMANDS["reload-runtime"], async () => (await host()).reloadRuntime()),
    "reload-extensions": bindHostCommand(HOST_CORE_COMMANDS["reload-extensions"], async () => (await host()).reloadExtensions()),
    // Answering must never wait for a ready host: the host is blocked on this very
    // question, so requiring readiness here would deadlock startup.
    "answer-extension-ui": bindHostCommand(HOST_CORE_COMMANDS["answer-extension-ui"], async (params) => deps.host()?.answerExtensionUi(
      params[0],
      params[1],
    )),
    "sync-extension-ui": bindHostCommand(HOST_CORE_COMMANDS["sync-extension-ui"], async () => deps.host()?.replayOpenUiPrompts()),
    "recover-thread": bindHostCommand(HOST_CORE_COMMANDS["recover-thread"], async () => (await host()).recoverThread()),
    "rename-thread": bindHostCommand(HOST_CORE_COMMANDS["rename-thread"], async (params) => (await host()).renameThread(
      params[0],
      params[1],
    )),
    "copy-text": bindHostCommand(HOST_CORE_COMMANDS["copy-text"], async (params) => platform.copyText(params[0])),
    "copy-image": bindHostCommand(HOST_CORE_COMMANDS["copy-image"], async (params) => platform.copyImage(params[0])),
    "notify": bindHostCommand(HOST_CORE_COMMANDS["notify"], async (params) => platform.notify(params[0])),
    "set-badge": bindHostCommand(HOST_CORE_COMMANDS["set-badge"], async (params) => platform.setBadge(params[0])),
    "context-menu": bindHostCommand(HOST_CORE_COMMANDS["context-menu"], async (params) => contextMenu(platform, params)),
    "window-action": bindHostCommand(HOST_CORE_COMMANDS["window-action"], async (params) => windowAction(platform, params)),
    // A host has no list of machines; its table names the methods so a page learns that plainly.
    ...createEnvironmentMethods(() => undefined),
    "read-tool-output": bindHostCommand(HOST_CORE_COMMANDS["read-tool-output"], async (params) => (await host()).readToolOutput(
      params[0],
      params[1],
    )),
    "tool-output": bindHostCommand(HOST_CORE_COMMANDS["tool-output"], async (params) => (await host()).toolOutput(
      params[0],
      params[1],
    )),
    // Answers with the text rather than copying it: the clipboard belongs to
    // the client, which may be a different process than the host.
    "copy-thread-markdown": bindHostCommand(HOST_CORE_COMMANDS["copy-thread-markdown"], async (params) =>
      (await host()).exportThreadMarkdown(params[0])),
    "read-image-preview": bindHostCommand(HOST_CORE_COMMANDS["read-image-preview"], async (params) => platform.readImagePreview(params[0])),
    "share-file": bindHostCommand(HOST_CORE_COMMANDS["share-file"], async (params) => shareFile(platform, params[0])),
    // Host extensions reach the renderer through this single method; core does
    // not grow a method per feature. `input` stays unknown: the extension owns it.
    "host-extension": bindHostCommand(HOST_CORE_COMMANDS["host-extension"], invokeExtension),
    "host-extensions": bindHostCommand(HOST_CORE_COMMANDS["host-extensions"], async () => (await host()).listHostExtensions()),
    "inspect-extensions": bindHostCommand(HOST_CORE_COMMANDS["inspect-extensions"], async (params) => platform.inspectExtensions(resolveWorkspace(await host(), params[0]))),
    "host-extension-active": bindHostCommand(HOST_CORE_COMMANDS["host-extension-active"], async (params) => (await host()).setHostExtensionActive(
      params[0],
      params[1],
    )),
    "extension-grant": bindHostCommand(HOST_CORE_COMMANDS["extension-grant"], async (params, context) => {
      const id = params[0];
      const grant = params[1];
      const instance = await host();
      if (grant) {
        const cwd = instance.activeWorkspacePath();
        const pkg = (await platform.inspectExtensions(cwd)).packages.find((entry) => entry.id === id && entry.scope !== "bundled");
        if (!pkg) throw new Error(`Extension ${id} is not installed`);
        const caller = context.principal.kind === "workbench-client" ? context.principal.connection : undefined;
        const confirmed = await deps.clientCalls?.confirmExtensionGrant?.(pkg, caller) ?? await platform.confirmExtensionGrant?.(pkg);
        if (confirmed === undefined) {
          if (!isHostOwner(context.principal)) throw ownerRefusal();
        } else if (confirmed !== true) {
          throw Object.assign(new Error("Extension grant requires native confirmation."), { code: HOST_ERROR.unauthorized });
        }
        const current = (await platform.inspectExtensions(cwd)).packages.find((entry) => entry.id === id);
        if (instance.activeWorkspacePath() !== cwd || JSON.stringify(current) !== JSON.stringify(pkg)) throw new Error("The package changed during confirmation. Review it again.");
      }
      await instance.grantExtension(id, grant);
    }),
    "prepare-workbench-reload": bindHostCommand(HOST_CORE_COMMANDS["prepare-workbench-reload"], async (params) =>
      (await host()).prepareWorkbenchReload(params[0])),
    "release-workbench-reload": bindHostCommand(HOST_CORE_COMMANDS["release-workbench-reload"], async () => (await host()).releaseWorkbenchReload()),
    "desktop-extensions": bindHostCommand(HOST_CORE_COMMANDS["desktop-extensions"], async (params) => {
      const held = params[3];
      const result = await platform.loadDesktopExtensions(
        await workspaceWhileStarting(params[0]),
        params[1],
        params[2],
      );
      return held ? withBundleDigests(result, held) : result;
    }),
    "rebuild-workbench": bindHostCommand(HOST_CORE_COMMANDS["rebuild-workbench"], async (_params, context) => platform.rebuildWorkbench(context, (await host()).activeWorkspacePath())),
    "workbench-source": bindHostCommand(HOST_CORE_COMMANDS["workbench-source"], async () => ({ path: await platform.workbenchSource() })),
    "relaunch-workbench": bindHostCommand(HOST_CORE_COMMANDS["relaunch-workbench"], async () => platform.relaunchWorkbench()),
    "install-update": bindHostCommand(HOST_CORE_COMMANDS["install-update"], async () => ({ installing: platform.installUpdate() })),
    "open-project": bindHostCommand(HOST_CORE_COMMANDS["open-project"], async (params) => (await host()).setWorkspace(resolveWorkspace(await host(), params[0]))),
    "remove-project": bindHostCommand(HOST_CORE_COMMANDS["remove-project"], async (params) => (await host()).removeProject(resolveWorkspace(await host(), params[0]))),
    "get-config": bindHostCommand(HOST_CORE_COMMANDS["get-config"], async (params) => (await import("./host-config.js")).defaultHostConfigManager.read((params[0] === undefined ? undefined : resolveWorkspace(await host(), params[0])))),
    "update-config": bindHostCommand(HOST_CORE_COMMANDS["update-config"], async (params) => {
      const { defaultHostConfigManager } = await import("./host-config.js");
      const patch = params[0];
      const scope = params[1];
      const cwd = (params[2] === undefined ? undefined : resolveWorkspace(await host(), params[2]));
      const config = await defaultHostConfigManager.update(patch, scope, cwd);
      if (patch.modelPrices) (await host()).modelPricesChanged();
      if (patch.extensions) await (await host()).watchingChanged();
      (await host()).configWritten([defaultHostConfigManager.filePath(scope, cwd)]);
      return config;
    }),
    "get-config-layers": bindHostCommand(HOST_CORE_COMMANDS["get-config-layers"], async (params) => (await import("./host-config.js")).defaultHostConfigManager.readLayers((params[0] === undefined ? undefined : resolveWorkspace(await host(), params[0])))),
    "clear-config": bindHostCommand(HOST_CORE_COMMANDS["clear-config"], async (params) => {
      const { defaultHostConfigManager } = await import("./host-config.js");
      const keys = params[0];
      const scope = params[1];
      const cwd = (params[2] === undefined ? undefined : resolveWorkspace(await host(), params[2]));
      const layers = await defaultHostConfigManager.clear(keys, scope, cwd);
      if (keys.some((key) => key.startsWith("modelPrices"))) (await host()).modelPricesChanged();
      if (keys.some((key) => key.startsWith("extensions"))) await (await host()).watchingChanged();
      (await host()).configWritten([defaultHostConfigManager.filePath(scope, cwd)]);
      return layers;
    }),
    "get-models-config": bindHostCommand(HOST_CORE_COMMANDS["get-models-config"], async () => (await host()).modelsConfig()),
    "runtime-catalog": bindHostCommand(HOST_CORE_COMMANDS["runtime-catalog"], async (params) => (await host()).runtimeCatalog(params[0])),
    "runtime-catalogs": bindHostCommand(HOST_CORE_COMMANDS["runtime-catalogs"], async (params) => (await host()).runtimeCatalogs(
      params[0] === true,
      params[1],
    )),
    // Settings → Runtimes: reading and refreshing the agent CLIs' state, and changing it (owner).
    "runtime-tools": bindHostCommand(HOST_CORE_COMMANDS["runtime-tools"], async (params) => (await host()).runtimeTools(params[0])),
    "runtime-tools-change": bindHostCommand(HOST_CORE_COMMANDS["runtime-tools-change"], async (params) => (await host()).runtimeTools(
      params[0],
      params[1],
    )),
    "add-model-provider": bindHostCommand(HOST_CORE_COMMANDS["add-model-provider"], async (params) => (await host()).addModelProvider(params[0])),
    "inspect-system-prompt": bindHostCommand(HOST_CORE_COMMANDS["inspect-system-prompt"], async (params) => (await host()).inspectSystemPrompt(
      params[0],
      (params[1] === undefined ? undefined : resolveWorkspace(await host(), params[1])),
    )),
    "list-user-themes": bindHostCommand(HOST_CORE_COMMANDS["list-user-themes"], async (params) => {
      const workspacePath = (params[0] === undefined ? undefined : resolveWorkspace(await host(), params[0]));
      return defaultUserThemeResolver.list(workspacePath);
    }),
    "open-external-editor": bindHostCommand(HOST_CORE_COMMANDS["open-external-editor"], async (params) => {
      const text = params[0] ?? "";
      return openExternalEditor({ initialText: text });
    }),

    ...createConnectionsMethods(() => deps.connections?.()),
    "external-mcp-manage": bindHostCommand(HOST_COMMANDS["external-mcp-manage"], async ([input], context) => {
      if (!isHostOwner(context.principal)) throw ownerRefusal();
      const external = deps.externalMcp?.();
      if (!external) throw Object.assign(new Error("Set TAU_MCP_ORIGIN to this machine's HTTPS origin before starting Tau."), { code: HOST_ERROR.unsupported });
      return external.manage(input, context.principal);
    }),
    ...createConnectMethods(() => deps.connect?.()),
    ...createHostServiceMethods(() => deps.service?.()),
    ...createMachineMethods(() => deps.machines?.()),
    ...createMachinePairingMethods({ machines: () => deps.machines?.(), window: () => localWindowPort(deps.clientCalls) }),
    ...createResourceMethods({ resources: () => deps.resources?.(), runtimes: host }),
    "read-browser-resource": bindHostCommand(HOST_COMMANDS["read-browser-resource"], async ([path], context) => {
      if (!deps.browserResources) throw Object.assign(new Error("This machine cannot serve browser resources."), { code: HOST_ERROR.unsupported });
      return runAsCaller(context.principal, () => deps.browserResources!.readForClient(path));
    }),
    ...createBlobMethods(() => deps.blobs?.()),
    ...createUpdateMethods(() => deps.updates?.()),
    "release-notes": bindHostCommand(HOST_COMMANDS["release-notes"], async ([version, fromVersion]) => deps.releaseNotes?.get(version, fromVersion) ?? []),

    // The other direction of the protocol: a client answering a `client-call`.
    // Only the connection it was sent to may answer (ADR 0023).
    "client-call-result": bindHostCommand(HOST_CORE_COMMANDS["client-call-result"], async (params, context) => {
      deps.clientCalls?.settle(
        params[0],
        params[1],
        params[2],
        context.principal.kind === "workbench-client" ? context.principal.connection : undefined,
      );
    }),

    "start-job": bindHostCommand(HOST_CORE_COMMANDS["start-job"], async (params, context) => {
      const method = params[0];
      if (JOB_CONTROL_METHODS.has(method)) throw new Error(`start-job: ${method} cannot run as a job`);
      const target = methods[method];
      if (!target) throw Object.assign(new Error(`Unknown method "${method}".`), { code: HOST_ERROR.unknownMethod });
      const jobParams = params[1] === undefined ? [] : params[1];
      if (!Array.isArray(jobParams)) throw new Error("start-job: params must be an array");
      authorizeMethod(context.principal, method, jobParams);
      if (PRIVATE_RESULT_METHODS.has(method)) throw new Error(`start-job: ${method} cannot run as a job`);
      return { jobId: deps.jobs.start((jobContext) => target(jobParams as unknown[], jobContext), context.principal) };
    }),
    "cancel-job": bindHostCommand(HOST_CORE_COMMANDS["cancel-job"], async (params) => ({ cancelled: deps.jobs.cancel(params[0]) })),
    /** Which calls a client should run as jobs; a host extension marks its own long commands. */
    "job-methods": bindHostCommand(HOST_CORE_COMMANDS["job-methods"], async () => {
      const long = deps.host()?.longHostExtensionCommands() ?? [];
      return [
        ...DECLARED_JOB_METHODS,
        ...long.map((entry) => {
          const [extensionId = "", command = ""] = entry.split("/");
          return jobMethodKey("host-extension", extensionId, command);
        }),
      ];
    }),
  };
  return methods;
}

/**
 * Every method name, all refusing. A window pointed at a host on another
 * machine still has its in-process transport, but nothing local may answer for
 * that host: a stray call gets a reason instead of this machine's state.
 */
export function createUnsupportedHostMethods(reason: string): HostMethodTable {
  const refuse = (): never => { throw Object.assign(new Error(reason), { code: HOST_ERROR.unsupported }); };
  const names = Object.keys(createHostMethods({
    bootstrap: refuse,
    requireHost: refuse,
    host: () => undefined,
    jobs: new HostJobRunner(() => undefined),
    platform: {
      copyText: refuse,
      copyImage: refuse,
      readImagePreview: refuse,
      inspectExtensions: refuse,
      loadDesktopExtensions: refuse,
      rebuildWorkbench: refuse,
      workbenchSource: refuse,
      relaunchWorkbench: refuse,
      installUpdate: refuse,
      notify: refuse,
      setBadge: refuse,
    },
  }));
  return Object.fromEntries(names.map((name) => [name, async () => refuse()]));
}

/** Runs one method outside a job; used by the request path of every transport. A Read-only device is refused every change here. */
export async function invokeHostMethod(
  methods: HostMethodTable,
  method: string,
  params: readonly unknown[],
  principal: HostInvocationPrincipal = WORKBENCH_CLIENT_PRINCIPAL,
): Promise<unknown> {
  const handler = methods[method];
  if (!handler) throw Object.assign(new Error(`Unknown method "${method}".`), { code: HOST_ERROR.unknownMethod });
  authorizeMethod(principal, method, params);
  return handler(params, { ...NO_JOB_CONTEXT, principal });
}

/**
 * Names each bundle by a digest of its code and stylesheet, and leaves out
 * the code of those a client says it holds already: a phone that kept its
 * packages from the last start is sent their names, not their code again.
 */
export function withBundleDigests(result: DesktopExtensionLoadResult, held: ReadonlySet<string>): DesktopExtensionLoadResult {
  return {
    ...result,
    bundles: result.bundles.map((bundle) => {
      const hash = createHash("sha256").update(bundle.code).update("\u0000").update(bundle.styles ?? "").digest("hex").slice(0, 32);
      if (!held.has(hash)) return { ...bundle, hash };
      const { styles: _styles, ...rest } = bundle;
      return { ...rest, code: "", hash, cached: true };
    }),
  };
}
