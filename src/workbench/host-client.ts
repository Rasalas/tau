import type { HostCommandName, CommandArgs, CommandResult, CommandClient } from "../shared/host-command-contract";
import { HOST_COMMAND_METADATA } from "../shared/host-command-metadata";
import type { MenuPoint, NativeMenuEntry } from "../shared/context-menu";
import type { HostUpdateStatus } from "../shared/host-updates";
import type { HostEvent } from "../shared/contracts";

import { isClientSideMethod } from "../shared/host-transport";

import type { EnvironmentTarget, UiEnvironmentThreadView } from "../shared/environments";
import type { HostLink } from "./host-link";
import type { HostConnection, HostConnectionState } from "./host-connection";
import { ReadCommands, readOnlyMayCall, readOnlyRefusal, type HostHalf } from "./read-only-guard";
import type { PersonPreferences } from "../shared/person-preferences";

/**
 * Transport-neutral view of the desktop host. Every method is one call of the
 * versioned host protocol on a `HostConnection`; Electron IPC and the local
 * socket are two transports under it. Only the platform module builds the
 * Electron one, and only `main.tsx` may reach the preload bridge.
 */
export interface HostClient {
  // Thread lifecycle and navigation: create, resume, switch, and manage projects.
  bootstrap: CommandClient<"bootstrap">;
  newSession: CommandClient<"new-session">;
  getPreparedThreadCapability: CommandClient<"prepared-thread-capability">;
  /** With `workspace`, the fork runs there (a worktree made for it) instead of the source's folder. */
  forkThread: CommandClient<"fork-thread">;
  threadTree: CommandClient<"thread-tree">;
  navigateThreadTree: CommandClient<"navigate-thread-tree">;
  duplicateThread: CommandClient<"duplicate-thread">;
  switchSession: CommandClient<"switch-session">;
  openProject: CommandClient<"open-project">;
  removeProject: CommandClient<"remove-project">;
  renameThread: CommandClient<"rename-thread">;
  recoverThread: CommandClient<"recover-thread">;

  // Sending and controlling one turn of a running thread.
  /** `backendKind` names the runtime of a thread that does not exist yet; ignored with a `sessionId`. */
  preparePrompt: CommandClient<"prepare-prompt">;
  /** The commands a draft of `workspace` offers on `backendKind` (API 1.59.0). */
  composerCommands: CommandClient<"composer-commands">;
  sendPrompt: CommandClient<"prompt">;
  steer: CommandClient<"steer">;
  followUp: CommandClient<"follow-up">;
  abort: CommandClient<"abort">;
  /** Parks a message in the thread's host-kept queue; it leaves when the thread's turn ends. */
  /** With `deliverAt` (epoch ms, API 1.65.0) the message is planned: it leaves at that time instead of after the turn. */
  queueMessage: CommandClient<"queue-message">;
  /** Takes queued messages back out, in full: one by id, or all of them. */
  takeQueued: CommandClient<"take-queued">;
  moveQueued: CommandClient<"move-queued">;
  /** Plans a waiting message for another time; `undefined` puts it in the line of the queue (API 1.65.0). */
  planQueued: CommandClient<"plan-queued">;
  /** Continues a thread a provider limit stopped: now, at the reset, or cancels the scheduled resume. */
  resumeLimited: CommandClient<"resume-limited">;
  /** A thread's native goal (API 1.52.0); `set` needs the objective. */
  threadGoal: CommandClient<"thread-goal">;
  /** Stops a thread's background task, or all of them without an id (API 1.58.0). */
  stopBackground: CommandClient<"thread-background-stop">;
  runShellAction: CommandClient<"run-shell-action">;

  // Reading transcript history and durable tool output.
  loadTranscript: CommandClient<"transcript-page">;
  readToolOutput: CommandClient<"read-tool-output">;
  /** A deferred tool's output (`outputDeferred`), as the transcript would have carried it. */
  toolOutput: CommandClient<"tool-output">;
  /** The thread as Markdown; the client's own clipboard takes it (a phone's, not the host's). */
  threadMarkdown(expectedSessionId?: string): Promise<string | undefined>;
  readImagePreview: CommandClient<"read-image-preview">;
  /** A `tau-ext:` URL for a workspace PDF, image, audio or video; the window's own process serves it. */
  shareFile: CommandClient<"share-file">;

  // Model, thinking level, and context for the thread on screen; the host's active thread without `expectedSessionId`.
  setModel: CommandClient<"set-model">;
  setThinkingLevel: CommandClient<"set-thinking">;
  /** The interaction mode the thread's next turns run in; the active thread without `expectedSessionId`. */
  setMode: CommandClient<"set-mode">;
  compactContext: CommandClient<"compact-context">;
  compactAndSend: CommandClient<"compact-and-send">;

  // Desktop/host extension lifecycle and the generic host-extension channel.
  restartSession: CommandClient<"restart-session">;
  reloadRuntime: CommandClient<"reload-runtime">;
  /** Kits and packages only; every runtime keeps running. */
  reloadExtensions: CommandClient<"reload-extensions">;
  answerExtensionUi: CommandClient<"answer-extension-ui">;
  /** Re-announces the open questions and lists them; a host from before the list answers nothing. */
  syncExtensionUi: CommandClient<"sync-extension-ui">;
  /** `only` asks for just those extension ids, so a client can swap one module instead of all of them. */
  /** `held`: the bundle digests the client keeps; the host leaves out their code (`DesktopExtensionBundle.cached`). */
  loadDesktopExtensions: CommandClient<"desktop-extensions">;
  invokeHostExtension: CommandClient<"host-extension">;
  /** Resolve a capability path against this client's host, never the device's own host. */
  resourceUrl?(path: string): string;
  listHostExtensions: CommandClient<"host-extensions">;
  inspectExtensions: CommandClient<"inspect-extensions">;
  setHostExtensionActive: CommandClient<"host-extension-active">;
  grantExtension: CommandClient<"extension-grant">;

  // Rebuilding, reloading, and restarting the workbench itself.
  prepareWorkbenchReload: CommandClient<"prepare-workbench-reload">;
  releaseWorkbenchReload: CommandClient<"release-workbench-reload">;
  rebuildWorkbench: CommandClient<"rebuild-workbench">;
  workbenchSource: CommandClient<"workbench-source">;
  relaunchWorkbench: CommandClient<"relaunch-workbench">;
  /** Restarts into a downloaded update. */
  installUpdate: CommandClient<"install-update">;

  // Host configuration as code.
  getConfig: CommandClient<"get-config">;
  updateConfig: CommandClient<"update-config">;
  /** The host and project files apart, for showing where a setting's value comes from. */
  getConfigLayers: CommandClient<"get-config-layers">;
  /** Removes setting keys from one level, so the level below shows through. */
  clearConfig: CommandClient<"clear-config">;
  getModelsConfig: CommandClient<"get-models-config">;
  /** What a runtime offers a thread that does not exist yet; undefined when it cannot say. */
  runtimeCatalog: CommandClient<"runtime-catalog">;
  /**
   * Every runtime's catalog the host holds, stale or not, less those the
   * client names in `known` (kind to `checkedAt`); `revalidate` makes it ask
   * again those that are some minutes old, and a change arrives as a
   * `runtime-catalog` event.
   */
  runtimeCatalogs: CommandClient<"runtime-catalogs">;
  /**
   * Settings → Runtimes, keeping the agent CLIs current: `state` and `refresh`
   * (every runtime's version and catalog asked again) read; with `input`,
   * `automatic` (`{ on }`), `update` and `switch` (`{ kind }`) need the owner.
   */
  runtimeTools?: CommandClient<"runtime-tools"> & CommandClient<"runtime-tools-change">;
  addModelProvider: CommandClient<"add-model-provider">;
  inspectSystemPrompt: CommandClient<"inspect-system-prompt">;
  listUserThemes: CommandClient<"list-user-themes">;
  openExternalEditor: CommandClient<"open-external-editor">;

  // Clipboard, window chrome, and the host event stream.
  readonly platform: string;
  copyText: CommandClient<"copy-text">;
  copyImage: CommandClient<"copy-image">;
  /** A notification the client's OS draws; resolves when it was clicked or dismissed. */
  showNotification: CommandClient<"notify">;
  /** The count on the client's app icon; 0 clears it. */
  setBadge: CommandClient<"set-badge">;
  /** A menu the client's OS draws at a point of the window; the chosen id, or undefined. Refused where none is drawn. */
  showContextMenu(entries: NativeMenuEntry[], point: MenuPoint): Promise<string | undefined>;
  /** Asks the window's own process (`src/shared/window-shell.ts`); refused where the client has none. */
  windowAction: CommandClient<"window-action">;
  onHostEvent(listener: (event: HostEvent) => void): () => void;
  /**
   * Whether the host announced a capability in its hello. `local-files` means
   * the host's paths are paths of this machine, so opening or copying one makes
   * sense; without it the workbench offers neither.
   */
  hasCapability(capability: string): boolean;
  /**
   * Whether the host's last hello said this device may only read; every change
   * is refused then (ADR 0024), on this side already, with `READ_ONLY_REASON`.
   */
  isReadOnly(): boolean;
  /**
   * Whether this connection manages who may connect (the host token on the
   * host's machine); undefined when the host did not say (API 1.13.0).
   */
  isOwner?(): boolean | undefined;
  /** The host machine's name from its last hello (ADR 0025); undefined from a host that gives none. */
  getHostName?(): string | undefined;
  /**
   * Whether this device may run a kit's host command: always with Full access;
   * Read only, just the commands registered `access: "read"`, and none until the
   * host said which those are (API 1.13.0). Optional for a stand-in client.
   */
  mayInvokeHostExtension?(extensionId: string, command: string): boolean;
  /** Called when `mayInvokeHostExtension` or `hostExtensionHalf` may answer differently. */
  onHostCommandsChanged?(listener: () => void): () => void;
  /**
   * An extension's host half as the host last listed it: undefined until the
   * host answered, null when it runs none. Optional for a stand-in client.
   */
  hostExtensionHalf?(extensionId: string): HostHalf | null | undefined;
  /** Whether the link to the host is whole, being repaired, refetching state, or refused. */
  getConnectionState(): HostConnectionState;
  /** Why the connection is `refused`, written for the user; undefined otherwise. */
  getConnectionRefusal(): string | undefined;
  onConnectionState(listener: (state: HostConnectionState) => void): () => void;
  /** The socket to a host, for a client that has one: phase, round trip, the next attempt. */
  getConnectionLink(): HostLink | undefined;
  onConnectionLink(listener: (link: HostLink) => void): () => void;
  /** Tries to reach the host now instead of waiting for the next attempt. */
  reconnectNow(): void;
  /**
   * What this client shows, so the host sends it those threads' streams and
   * those topics only (after `limitPushesToWatched`). Each returns its release.
   */
  watchThread(sessionId: string): () => void;
  /** The thread a `newSession` with this request id creates, before its id is known. */
  watchNewThread(requestId: string): () => void;
  watchHostTopic(extensionId: string, topic: string): () => void;
  /** Called once the thread on screen is watched; before it, every push arrives. */
  limitPushesToWatched(): void;
  /**
   * The Tau versions the hellos reported: the host's, and the window process's
   * when that is a process apart from the host. Either is unknown until its
   * hello was answered.
   */
  getVersions(): { host?: string; window?: string };
  onVersions(listener: () => void): () => void;

  // Who else may connect to the host (Settings → Connections, ADR 0023, ADR 0024). The owner's alone.
  listConnections: CommandClient<"connections-list">;
  createPairingLink: CommandClient<"connections-create-link">;
  revokePairingLink: CommandClient<"connections-revoke-link">;
  revokeClient: CommandClient<"connections-revoke-client">;
  /** Signs out every paired device; answers how many. */
  revokeOtherClients: CommandClient<"connections-revoke-others">;
  updateClient: CommandClient<"connections-update-client">;
  /** Lets a waiting device in; false when it stopped waiting. */
  approvePairing: CommandClient<"connections-approve">;
  denyPairing: CommandClient<"connections-deny">;
  /** Closes every other connection on the old host token; this one carries on with the new one. */
  rotateHostToken(): Promise<void>;
  /** The host token itself, for the owner to enter on another device (API 1.61.0); refused to everyone else, and an older host does not know it. */
  hostToken(): Promise<string>;
  /** Opens or closes the listeners beyond loopback in the running host. */
  setNetworkAccess: CommandClient<"connections-set-network">;
  connectStatus?: CommandClient<"connect-status">;
  configureConnect?: CommandClient<"connect-configure">;
  createConnectLink?: CommandClient<"connect-link">;
  removeConnect?: CommandClient<"connect-remove">;
  /** Reads the served certificates again; `changed` when a listener now serves another one. */
  reloadCertificate: CommandClient<"connections-reload-certificate">;
  /** Tau hosts that announce themselves on the host's network, after a few seconds of looking. */
  discoverHosts: CommandClient<"connections-discover">;
  /** The host's machine runs it as a system service; the owner's alone. */
  serviceStatus: CommandClient<"service-status">;
  /**
   * Installs (or repairs) the service; the host answering may be replaced by the one it starts.
   * `display` adds or removes the invisible display of a Linux service; left out, it stays as it is.
   */
  installService: CommandClient<"service-install">;
  uninstallService: CommandClient<"service-uninstall">;
  /** Adds the AppArmor profile the invisible display's window needs, through the host machine's password dialog. */
  allowServiceSandbox: CommandClient<"service-allow-sandbox">;

  // The machines this window knows (ADR 0025). The window's own process answers; a host refuses them.
  listEnvironments: CommandClient<"environments-list">;
  /** Resolves once the other machine's owner decided, or the attempt failed. */
  pairEnvironment: CommandClient<"environments-pair">;
  cancelEnvironmentPairing: CommandClient<"environments-cancel-pairing">;
  renameEnvironment: CommandClient<"environments-rename">;
  removeEnvironment: CommandClient<"environments-remove">;
  retryEnvironment: CommandClient<"environments-retry">;
  /** Points this window at another machine; the page loads again there and finds `target` waiting. */
  openEnvironment: CommandClient<"environments-open">;
  /** What this page was sent to show on arrival, once. */
  takeEnvironmentArrival(): Promise<EnvironmentTarget | undefined>;
  /** A Bonjour search from the window's own host, whichever machine the page shows. */
  discoverEnvironments: CommandClient<"environments-discover">;
  listWslEnvironments?: CommandClient<"environments-wsl-list">;
  setEnvironmentPreferences: CommandClient<"environments-set-preferences">;
  setEnvironmentAgents: CommandClient<"environments-set-agents">;
  /** Renews or ends the window's watch of another machine's thread (API 1.15.0). */
  watchEnvironmentThread(machine: string, sessionId: string, on: boolean): Promise<UiEnvironmentThreadView | undefined>;
  /** A page of another machine's thread, over the window's own connection to it. */
  loadEnvironmentTranscript: CommandClient<"environments-transcript-page">;
  /** A kit command of another machine that only reads, over the window's own connection to it (API 1.15.0). */
  invokeEnvironmentExtension: CommandClient<"environments-extension-invoke">;
  followEnvironmentExtension?: CommandClient<"environments-extension-follow">;
  readEnvironmentExtension: CommandClient<"environments-extension-read">;
  /** Another machine's own Tau over the window's connection there: how it stands, a check, or an install (K103). */
  updateEnvironment?: CommandClient<"environments-update">;
  /** Another machine's settings at its machine level, over the window's connection there (K170). */
  getEnvironmentConfig: CommandClient<"environments-config">;
  updateEnvironmentConfig: CommandClient<"environments-update-config">;
  clearEnvironmentConfig: CommandClient<"environments-clear-config">;
  /** The person's preferences as the window's own machine keeps them; with a patch, written there. */
  personPreferences?(patch?: PersonPreferences): Promise<PersonPreferences>;

  /** The host machine's own Tau (K103); a host without an updater refuses with `unsupported`. */
  hostUpdate?(action: "status" | "check" | "install"): Promise<HostUpdateStatus>;
  setHostUpdateSettings?: CommandClient<"update-settings">;
}

/**
 * Builds the typed host surface; the method names are the protocol. With a
 * second connection, the methods of `CLIENT_SIDE_METHODS` travel there instead:
 * a window whose host runs in another process still copies to its own
 * clipboard and rebuilds its own workbench (ADR 0021).
 */
const WINDOW_EVENT_TYPES = new Set<string>(["app-update", "window-shell", "environments", "environment-thread", "environment-extension-event"]);

/** JSON sends an undefined slot as null, which a host before null-tolerant decoders refuses; a left-out argument is not sent. */
function withoutTrailingUndefined(params: readonly unknown[]): readonly unknown[] {
  let end = params.length;
  while (end > 0 && params[end - 1] === undefined) end -= 1;
  return end === params.length ? params : params.slice(0, end);
}

export function createHostClient(connection: HostConnection, local?: HostConnection): HostClient {
  const route = (method: string) => (local && isClientSideMethod(method) ? local : connection);
  // A Read-only device is refused here what the host would refuse; the window's own process never is.
  const refused = (target: HostConnection, method: string) => target === connection && connection.isReadOnly() && !readOnlyMayCall(method);
  const commandCall = <Name extends HostCommandName>(method: Name, ...[params]: [] extends CommandArgs<Name> ? [params?: CommandArgs<Name>] : [params: CommandArgs<Name>]): Promise<CommandResult<Name>> => {
    const target = route(method);
    if (refused(target, method)) return Promise.reject(readOnlyRefusal());
    const args = withoutTrailingUndefined(params ?? []);
    return HOST_COMMAND_METADATA[method].job && target.isJobMethod(method)
      ? target.runJob<CommandResult<Name>>(method, args)
      : target.request<CommandResult<Name>>(method, args);
  };
  const readCommands = new ReadCommands(() => commandCall("host-extensions"));
  connection.onEvent((event) => { if (event.type === "extension-packages-changed" || event.type === "extension-deactivated") readCommands.invalidate(); });
  const invokeHostExtension = (extensionId: string, command: string, input?: unknown) => connection.isJobMethod("host-extension", extensionId, command)
    ? connection.runJob<unknown>("host-extension", [extensionId, command, input])
    : commandCall("host-extension", [extensionId, command, input]);
  return {
    bootstrap: async () => {
      const bootstrap = await commandCall("bootstrap");
      // Which calls run as jobs, and which only read, depends on the extensions the host just started.
      void connection.refreshJobMethods();
      readCommands.invalidate();
      return bootstrap;
    },
    newSession: (initialPrompt, attachments, cwd, clientMessageIdOrRequestId, prepared, configuration) =>
      commandCall("new-session", [initialPrompt, attachments, cwd, clientMessageIdOrRequestId, prepared, configuration]),
    getPreparedThreadCapability: (cwd) => commandCall("prepared-thread-capability", [cwd]),
    forkThread: (entryId, expectedSessionId, workspace, background) => commandCall("fork-thread", background !== undefined ? [entryId, expectedSessionId, workspace, background] : workspace ? [entryId, expectedSessionId, workspace] : [entryId, expectedSessionId]),
    threadTree: (sessionId) => commandCall("thread-tree", [sessionId]),
    navigateThreadTree: (entryId, options, expectedSessionId) =>
      commandCall("navigate-thread-tree", [entryId, options, expectedSessionId]),
    duplicateThread: (expectedSessionId) => commandCall("duplicate-thread", [expectedSessionId]),
    switchSession: (path) => commandCall("switch-session", [path]),
    openProject: (path) => commandCall("open-project", [path]),
    removeProject: (path) => commandCall("remove-project", [path]),
    renameThread: (title, expectedSessionId) => commandCall("rename-thread", [title, expectedSessionId]),
    recoverThread: () => commandCall("recover-thread"),

    preparePrompt: (text, sessionId, skill, backendKind, workspace) => commandCall("prepare-prompt", [text, sessionId, skill, backendKind, workspace]),
    composerCommands: (backendKind, workspace) => commandCall("composer-commands", [backendKind, workspace]),
    sendPrompt: (text, attachments, sessionId, clientMessageIdOrIdentity, prepared) =>
      commandCall("prompt", [text, attachments, sessionId, clientMessageIdOrIdentity, prepared]),
    steer: (text, attachments, sessionId, clientMessageIdOrIdentity, prepared) =>
      commandCall("steer", [text, attachments, sessionId, clientMessageIdOrIdentity, prepared]),
    followUp: (text, attachments, sessionId, clientMessageIdOrIdentity, prepared) =>
      commandCall("follow-up", [text, attachments, sessionId, clientMessageIdOrIdentity, prepared]),
    abort: (sessionId) => commandCall("abort", [sessionId]),
    queueMessage: (sessionId, text, attachments, skillDraft, deliverAt) => commandCall("queue-message", deliverAt === undefined ? [sessionId, text, attachments, skillDraft] : [sessionId, text, attachments, skillDraft ?? null, deliverAt]),
    takeQueued: (sessionId, id) => commandCall("take-queued", [sessionId, id]),
    moveQueued: (sessionId, id, toIndex) => commandCall("move-queued", [sessionId, id, toIndex]),
    planQueued: (sessionId, id, deliverAt) => commandCall("plan-queued", [sessionId, id, deliverAt ?? null]),
    resumeLimited: (sessionId, when) => commandCall("resume-limited", [sessionId, when]),
    threadGoal: (sessionId, action, objective) => commandCall("thread-goal", objective === undefined ? [sessionId, action] : [sessionId, action, objective]),
    stopBackground: (sessionId, taskId) => commandCall("thread-background-stop", taskId === undefined ? [sessionId] : [sessionId, taskId]),
    runShellAction: (command, includeInContext, expectedCwd) =>
      commandCall("run-shell-action", [command, includeInContext, expectedCwd]),

    loadTranscript: (sessionId, cursor) => commandCall("transcript-page", [sessionId, cursor]),
    readToolOutput: (sessionId, toolCallId) => commandCall("read-tool-output", [sessionId, toolCallId]),
    toolOutput: (sessionId, toolCallId) => commandCall("tool-output", [sessionId, toolCallId]),
    threadMarkdown: async (expectedSessionId) => {
      const markdown = await commandCall("copy-thread-markdown", [expectedSessionId]);
      return typeof markdown === "string" && markdown ? markdown : undefined;
    },
    readImagePreview: (path) => commandCall("read-image-preview", [path]),
    shareFile: (path) => commandCall("share-file", [path]),

    setModel: (provider, id, expectedSessionId) => commandCall("set-model", [provider, id, expectedSessionId]),
    setThinkingLevel: (level, expectedSessionId) => commandCall("set-thinking", [level, expectedSessionId]),
    setMode: (mode, expectedSessionId) => commandCall("set-mode", [mode, expectedSessionId]),
    compactContext: (expectedSessionId) => commandCall("compact-context", [expectedSessionId]),
    compactAndSend: (sessionId, prompt) => commandCall("compact-and-send", [sessionId, prompt]),

    restartSession: (threadId) => commandCall("restart-session", [threadId]),
    reloadRuntime: () => commandCall("reload-runtime"),
    reloadExtensions: () => commandCall("reload-extensions"),
    answerExtensionUi: (id, answer) => commandCall("answer-extension-ui", [id, answer]),
    syncExtensionUi: () => commandCall("sync-extension-ui"),
    loadDesktopExtensions: (cwd, sharedExports, only, held) => commandCall("desktop-extensions", [cwd, sharedExports, only, held]),
    // A command an extension declared long-running waits on `job-done` instead
    // of on one long response, so the host can report progress and be cancelled.
    invokeHostExtension: async (extensionId, command, input) => {
      if (connection.isReadOnly() && !await readCommands.check(extensionId, command)) throw readOnlyRefusal();
      return invokeHostExtension(extensionId, command, input);
    },
    listHostExtensions: () => commandCall("host-extensions"),
    inspectExtensions: (cwd) => commandCall("inspect-extensions", [cwd]),
    setHostExtensionActive: (id, active) => commandCall("host-extension-active", [id, active]),
    grantExtension: (id, grant) => commandCall("extension-grant", [id, grant]),

    prepareWorkbenchReload: (mode) => commandCall("prepare-workbench-reload", [mode]),
    releaseWorkbenchReload: () => commandCall("release-workbench-reload"),
    // A job when the connection that answers it offers jobs; a client-side rebuild is one plain request instead.
    rebuildWorkbench: () => commandCall("rebuild-workbench"),
    workbenchSource: () => commandCall("workbench-source"),
    relaunchWorkbench: () => commandCall("relaunch-workbench"),
    installUpdate: () => commandCall("install-update"),
    getConfig: (workspaceId) => commandCall("get-config", [workspaceId]),
    updateConfig: (patch, scope, workspaceId) => commandCall("update-config", [patch, scope, workspaceId]),
    getConfigLayers: (workspaceId) => commandCall("get-config-layers", [workspaceId]),
    clearConfig: (keys, scope, workspaceId) => commandCall("clear-config", [keys, scope, workspaceId]),
    getModelsConfig: () => commandCall("get-models-config"),
    runtimeCatalog: (kind) => commandCall("runtime-catalog", [kind]),
    runtimeCatalogs: (revalidate, known) => commandCall("runtime-catalogs", [revalidate === true, known ?? {}]),
    runtimeTools: (action: "state" | "refresh" | "automatic" | "update" | "switch", input?: { on?: boolean; kind?: string }) => input
      ? commandCall("runtime-tools-change", [action as "automatic" | "update" | "switch", input])
      : commandCall("runtime-tools", [action as "state" | "refresh"]),
    addModelProvider: (input) => commandCall("add-model-provider", [input]),
    inspectSystemPrompt: (threadId, workspaceId) => commandCall("inspect-system-prompt", [threadId, workspaceId]),
    listUserThemes: (workspaceId) => commandCall("list-user-themes", [workspaceId]),
    openExternalEditor: (text) => commandCall("open-external-editor", [text]),

    // The machine the window runs on, not the host's transport: macOS window chrome keys on it.
    platform: local?.platform ?? connection.platform,
    copyText: (text) => commandCall("copy-text", [text]),
    copyImage: (dataUrl) => commandCall("copy-image", [dataUrl]),
    showNotification: (notification) => commandCall("notify", [notification]),
    setBadge: (count) => commandCall("set-badge", [count]),
    showContextMenu: async (entries, point) => (await commandCall("context-menu", [entries, point]))?.id,
    windowAction: (action) => commandCall("window-action", [action]),
    // The window's own process publishes these on its own transport; the host never does.
    onHostEvent: (listener) => {
      const offHost = connection.onEvent(listener);
      const offWindow = local?.onEvent((event) => { if (WINDOW_EVENT_TYPES.has(event.type)) listener(event); });
      return () => { offHost(); offWindow?.(); };
    },
    hasCapability: connection.hasCapability,
    isReadOnly: connection.isReadOnly,
    isOwner: connection.isOwner,
    getHostName: connection.getHostName,
    mayInvokeHostExtension: (extensionId, command) => !connection.isReadOnly() || readCommands.allows(extensionId, command) === true,
    onHostCommandsChanged: (listener) => readCommands.onChange(listener),
    hostExtensionHalf: (extensionId) => readCommands.hostHalf(extensionId),
    getConnectionState: connection.getState,
    getConnectionRefusal: connection.getRefusal,
    onConnectionState: (listener) => connection.onState(listener),
    getConnectionLink: connection.getLink,
    onConnectionLink: (listener) => connection.onLink(listener),
    reconnectNow: () => connection.reconnectNow(),
    watchThread: (sessionId) => connection.watchThread(sessionId),
    watchNewThread: (requestId) => connection.watchNewThread(requestId),
    resourceUrl: (path) => connection.resourceUrl(path),
    watchHostTopic: (extensionId, topic) => connection.watchTopic(extensionId, topic),
    limitPushesToWatched: () => connection.limitToWatched(),
    getVersions: () => ({ host: connection.getHostVersion(), window: local?.getHostVersion() }),
    onVersions: (listener) => {
      const offHost = connection.onHello(listener);
      const offWindow = local?.onHello(listener);
      return () => { offHost(); offWindow?.(); };
    },

    listConnections: () => commandCall("connections-list"),
    createPairingLink: (input) => commandCall("connections-create-link", [input ?? {}]),
    revokePairingLink: (id) => commandCall("connections-revoke-link", [id]),
    revokeClient: (id) => commandCall("connections-revoke-client", [id]),
    revokeOtherClients: () => commandCall("connections-revoke-others"),
    updateClient: (id, update) => commandCall("connections-update-client", [id, update]),
    approvePairing: (id, choice) => commandCall("connections-approve", [id, choice ?? {}]),
    denyPairing: (id) => commandCall("connections-deny", [id]),
    rotateHostToken: async () => {
      const { token } = await commandCall("connections-rotate-host-token");
      connection.updateToken(token);
    },
    hostToken: async () => (await commandCall("connections-host-token")).token,
    setNetworkAccess: (input) => commandCall("connections-set-network", [input]),
    connectStatus: () => commandCall("connect-status"),
    configureConnect: (input) => commandCall("connect-configure", [input]),
    createConnectLink: () => commandCall("connect-link"),
    removeConnect: () => commandCall("connect-remove"),
    reloadCertificate: () => commandCall("connections-reload-certificate"),
    discoverHosts: (options) => commandCall("connections-discover", [options ?? {}]),
    serviceStatus: () => commandCall("service-status"),
    installService: (options) => commandCall("service-install", options ? [options] : []),
    uninstallService: () => commandCall("service-uninstall"),
    allowServiceSandbox: () => commandCall("service-allow-sandbox"),

    listEnvironments: () => commandCall("environments-list"),
    pairEnvironment: (input) => commandCall("environments-pair", [input]),
    cancelEnvironmentPairing: () => commandCall("environments-cancel-pairing"),
    renameEnvironment: (id, name) => commandCall("environments-rename", [id, name]),
    removeEnvironment: (id) => commandCall("environments-remove", [id]),
    retryEnvironment: (id) => commandCall("environments-retry", [id]),
    openEnvironment: (id, target) => commandCall("environments-open", target ? [id, target] : [id]),
    takeEnvironmentArrival: async () => (await commandCall("environments-take-arrival")) ?? undefined,
    discoverEnvironments: () => commandCall("environments-discover"),
    listWslEnvironments: () => commandCall("environments-wsl-list"),
    setEnvironmentPreferences: (preferences) => commandCall("environments-set-preferences", [preferences]),
    setEnvironmentAgents: (id, on) => commandCall("environments-set-agents", [id, on]),
    watchEnvironmentThread: async (machine, sessionId, on) => (await commandCall("environments-watch-thread", [machine, sessionId, on])) ?? undefined,
    loadEnvironmentTranscript: (machine, sessionId, cursor) => commandCall("environments-transcript-page", cursor ? [machine, sessionId, cursor] : [machine, sessionId]),
    invokeEnvironmentExtension: (machine, extensionId, command, input, options) => commandCall("environments-extension-invoke", options ? [machine, extensionId, command, input, options] : input === undefined ? [machine, extensionId, command] : [machine, extensionId, command, input]),
    followEnvironmentExtension: (machine, extensionId, on) => commandCall("environments-extension-follow", [machine, extensionId, on]),
    readEnvironmentExtension: (machine, extensionId, command, input) => commandCall("environments-extension-read", input === undefined ? [machine, extensionId, command] : [machine, extensionId, command, input]),
    updateEnvironment: (machine, action) => commandCall("environments-update", [machine, action]),
    getEnvironmentConfig: (machine) => commandCall("environments-config", [machine]),
    updateEnvironmentConfig: (machine, patch) => commandCall("environments-update-config", [machine, patch]),
    clearEnvironmentConfig: (machine, keys) => commandCall("environments-clear-config", [machine, keys]),
    personPreferences: (patch) => patch ? commandCall("environments-set-person-preferences", [patch]) : commandCall("environments-person-preferences", []),

    // Literal names: the protocol contract test reads them from this file.
    hostUpdate: (action) => action === "install" ? commandCall("update-install", [{}]) : action === "check" ? commandCall("update-check") : commandCall("update-status"),
    setHostUpdateSettings: (settings) => commandCall("update-settings", [settings]),
  };
}
