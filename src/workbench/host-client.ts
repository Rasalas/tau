import type { MenuPoint, NativeMenuEntry } from "../shared/context-menu";
import type {
  DesktopExtensionLoadResult,
  ExtensionInspection,
  ExtensionUiAnswer,
  HostExtensionSummary,
  PreparedPrompt,
  PreparedThreadCapability,
  NewThreadConfiguration,
  ShellActionResult,
  ThreadTreeNavigationResult,
  UiImagePreview,
  UiSharedFile,
  UiPromptAttachment,
  UiQueuedPrompt,
  UiSkillDraft,
  UiThreadTree,
  UiToolOutputPreview,
  UiToolOutputReadResult,
  WorkbenchBuildResult,
  WorkbenchReloadMode,
  WorkbenchReloadPreparation,
  HostEvent,
  ClientTurnIdentity,
  ThreadBackendKind,
  TauConfig,
  CustomProviderConfig,
  CustomProviderInput,
  UiModel,
  UiRuntimeCatalog,
  SystemPromptInspection,
  UserTheme,
  ExternalEditorResult,
} from "../shared/contracts";
import type { HostActionResult, NewThreadResult, TranscriptPage } from "../shared/host-protocol";
import type { ConfigLayers } from "../shared/config-layers";
import type { HostBootstrap } from "../shared/contracts";
import type { HostTranscriptCursor } from "../shared/transcript-cursor";
import { isClientSideMethod } from "../shared/host-transport";
import type { SystemNotification, SystemNotificationOutcome } from "../shared/system-attention";
import type { WindowAction } from "../shared/window-shell";
import type { UiConnections, UiCreatedPairingLink, UiHostService } from "../shared/connections";
import type { HostConnection, HostConnectionState } from "./host-connection";

/**
 * Transport-neutral view of the desktop host. Every method is one call of the
 * versioned host protocol on a `HostConnection`; Electron IPC and the local
 * socket are two transports under it. Only the platform module builds the
 * Electron one, and only `main.tsx` may reach the preload bridge.
 */
export interface HostClient {
  // Thread lifecycle and navigation: create, resume, switch, and manage projects.
  bootstrap(): Promise<HostBootstrap>;
  newSession(initialPrompt?: string, attachments?: UiPromptAttachment[], cwd?: string, clientMessageIdOrRequestId?: string | ClientTurnIdentity, prepared?: PreparedPrompt, configuration?: NewThreadConfiguration): Promise<NewThreadResult>;
  getPreparedThreadCapability(cwd?: string): Promise<PreparedThreadCapability>;
  forkThread(entryId: string, expectedSessionId?: string): Promise<HostActionResult>;
  threadTree(sessionId?: string): Promise<UiThreadTree>;
  navigateThreadTree(entryId: string, options?: { summarize?: boolean }, expectedSessionId?: string): Promise<ThreadTreeNavigationResult>;
  duplicateThread(expectedSessionId?: string): Promise<HostActionResult>;
  switchSession(path: string): Promise<HostActionResult>;
  openProject(path: string): Promise<HostActionResult>;
  removeProject(path: string): Promise<HostActionResult>;
  renameThread(title: string, expectedSessionId?: string): Promise<HostActionResult>;
  recoverThread(): Promise<HostActionResult>;

  // Sending and controlling one turn of a running thread.
  /** `backendKind` names the runtime of a thread that does not exist yet; ignored with a `sessionId`. */
  preparePrompt(text: string, sessionId?: string, skill?: UiSkillDraft, backendKind?: ThreadBackendKind): Promise<PreparedPrompt | undefined>;
  sendPrompt(text: string, attachments?: UiPromptAttachment[], sessionId?: string, clientMessageIdOrIdentity?: string | ClientTurnIdentity, prepared?: PreparedPrompt): Promise<void>;
  steer(text: string, attachments?: UiPromptAttachment[], sessionId?: string, clientMessageIdOrIdentity?: string | ClientTurnIdentity, prepared?: PreparedPrompt): Promise<void>;
  followUp(text: string, attachments?: UiPromptAttachment[], sessionId?: string, clientMessageIdOrIdentity?: string | ClientTurnIdentity, prepared?: PreparedPrompt): Promise<void>;
  abort(sessionId?: string): Promise<void>;
  /** Parks a message in the thread's host-kept queue; it leaves when the thread's turn ends. */
  queueMessage(sessionId: string, text: string, attachments: UiPromptAttachment[], skillDraft?: UiSkillDraft): Promise<{ id: string }>;
  /** Takes queued messages back out, in full: one by id, or all of them. */
  takeQueued(sessionId: string, id?: string): Promise<UiQueuedPrompt[]>;
  moveQueued(sessionId: string, id: string, toIndex: number): Promise<void>;
  /** Continues a thread a provider limit stopped: now, at the reset, or cancels the scheduled resume. */
  resumeLimited(sessionId: string, when: "now" | "reset" | "cancel"): Promise<void>;
  runShellAction(command: string, includeInContext?: boolean, expectedCwd?: string): Promise<ShellActionResult>;

  // Reading transcript history and durable tool output.
  loadTranscript(sessionId: string, cursor?: HostTranscriptCursor): Promise<TranscriptPage>;
  readToolOutput(sessionId: string, toolCallId: string): Promise<UiToolOutputReadResult | undefined>;
  /** A deferred tool's output (`outputDeferred`), as the transcript would have carried it. */
  toolOutput(sessionId: string, toolCallId: string): Promise<UiToolOutputPreview | undefined>;
  copyThreadMarkdown(expectedSessionId?: string): Promise<void>;
  readImagePreview(path: string): Promise<UiImagePreview | undefined>;
  /** A `tau-ext:` URL for a workspace PDF, image, audio or video; the window's own process serves it. */
  shareFile(path: string): Promise<UiSharedFile>;

  // Model, thinking level, and context for the active thread.
  setModel(provider: string, id: string): Promise<HostActionResult>;
  setThinkingLevel(level: string): Promise<HostActionResult>;
  /** The interaction mode the thread's next turns run in; the active thread without `expectedSessionId`. */
  setMode(mode: string, expectedSessionId?: string): Promise<HostActionResult>;
  compactContext(): Promise<HostActionResult>;

  // Desktop/host extension lifecycle and the generic host-extension channel.
  reloadRuntime(): Promise<void>;
  /** Kits and packages only; every runtime keeps running. */
  reloadExtensions(): Promise<void>;
  answerExtensionUi(id: string, answer: ExtensionUiAnswer): Promise<void>;
  syncExtensionUi(): Promise<void>;
  /** `only` asks for just those extension ids, so a client can swap one module instead of all of them. */
  loadDesktopExtensions(cwd: string, sharedExports: Record<string, string[]>, only?: readonly string[]): Promise<DesktopExtensionLoadResult>;
  invokeHostExtension(extensionId: string, command: string, input?: unknown): Promise<unknown>;
  listHostExtensions(): Promise<HostExtensionSummary[]>;
  inspectExtensions(cwd: string): Promise<ExtensionInspection>;
  setHostExtensionActive(id: string, active: boolean): Promise<HostExtensionSummary[]>;
  grantExtension(id: string, grant: boolean): Promise<void>;

  // Rebuilding, reloading, and restarting the workbench itself.
  prepareWorkbenchReload(mode: WorkbenchReloadMode): Promise<WorkbenchReloadPreparation>;
  releaseWorkbenchReload(): Promise<void>;
  rebuildWorkbench(): Promise<WorkbenchBuildResult>;
  workbenchSource(): Promise<{ path?: string }>;
  relaunchWorkbench(): Promise<void>;
  /** Restarts into a downloaded update. */
  installUpdate(): Promise<{ installing: boolean }>;

  // Host configuration as code.
  getConfig(workspaceId?: string): Promise<TauConfig>;
  updateConfig(patch: Partial<TauConfig>, scope?: "global" | "project", workspaceId?: string): Promise<TauConfig>;
  /** The host and project files apart, for showing where a setting's value comes from. */
  getConfigLayers(workspaceId?: string): Promise<ConfigLayers>;
  /** Removes setting keys from one level, so the level below shows through. */
  clearConfig(keys: readonly string[], scope?: "global" | "project", workspaceId?: string): Promise<ConfigLayers>;
  getModelsConfig(): Promise<CustomProviderConfig[]>;
  /** What a runtime offers a thread that does not exist yet; undefined when it cannot say. */
  runtimeCatalog(kind: ThreadBackendKind): Promise<UiRuntimeCatalog | undefined>;
  /**
   * Every runtime's catalog the host holds, stale or not, less those the
   * client names in `known` (kind to `checkedAt`); `revalidate` makes it ask
   * again those that are some minutes old, and a change arrives as a
   * `runtime-catalog` event.
   */
  runtimeCatalogs(revalidate?: boolean, known?: Record<string, number>): Promise<UiRuntimeCatalog[]>;
  addModelProvider(input: CustomProviderInput): Promise<UiModel[]>;
  inspectSystemPrompt(threadId?: string, workspaceId?: string): Promise<SystemPromptInspection>;
  listUserThemes(workspaceId?: string): Promise<UserTheme[]>;
  openExternalEditor(text?: string): Promise<ExternalEditorResult>;

  // Clipboard, window chrome, and the host event stream.
  readonly platform: string;
  copyText(text: string): Promise<void>;
  copyImage(dataUrl: string): Promise<void>;
  /** A notification the client's OS draws; resolves when it was clicked or dismissed. */
  showNotification(notification: SystemNotification): Promise<SystemNotificationOutcome>;
  /** The count on the client's app icon; 0 clears it. */
  setBadge(count: number): Promise<void>;
  /** A menu the client's OS draws at a point of the window; the chosen id, or undefined. Refused where none is drawn. */
  showContextMenu(entries: NativeMenuEntry[], point: MenuPoint): Promise<string | undefined>;
  /** Asks the window's own process (`src/shared/window-shell.ts`); refused where the client has none. */
  windowAction(action: WindowAction): Promise<unknown>;
  onHostEvent(listener: (event: HostEvent) => void): () => void;
  /**
   * Whether the host announced a capability in its hello. `local-files` means
   * the host's paths are paths of this machine, so opening or copying one makes
   * sense; without it the workbench offers neither.
   */
  hasCapability(capability: string): boolean;
  /** Whether the link to the host is whole, being repaired, refetching state, or refused. */
  getConnectionState(): HostConnectionState;
  /** Why the connection is `refused`, written for the user; undefined otherwise. */
  getConnectionRefusal(): string | undefined;
  onConnectionState(listener: (state: HostConnectionState) => void): () => void;
  /**
   * The Tau versions the hellos reported: the host's, and the window process's
   * when that is a process apart from the host. Either is unknown until its
   * hello was answered.
   */
  getVersions(): { host?: string; window?: string };
  onVersions(listener: () => void): () => void;

  // Who else may connect to the host (Settings → Connections, ADR 0023). The owner's alone.
  listConnections(): Promise<UiConnections>;
  createPairingLink(input?: { label?: string; lifetimeMs?: number }): Promise<UiCreatedPairingLink>;
  revokePairingLink(id: string): Promise<{ revoked: boolean }>;
  revokeClient(id: string): Promise<{ revoked: boolean }>;
  /** Closes every other connection on the old host token; this one carries on with the new one. */
  rotateHostToken(): Promise<void>;
  /** The host's machine runs it as a system service; the owner's alone. */
  serviceStatus(): Promise<UiHostService>;
  /** Installs (or repairs) the service; the host answering may be replaced by the one it starts. */
  installService(): Promise<UiHostService>;
  uninstallService(): Promise<UiHostService>;
}

/**
 * Builds the typed host surface; the method names are the protocol. With a
 * second connection, the methods of `CLIENT_SIDE_METHODS` travel there instead:
 * a window whose host runs in another process still copies to its own
 * clipboard and rebuilds its own workbench (ADR 0021).
 */
const WINDOW_EVENT_TYPES = new Set<string>(["app-update", "window-shell"]);

export function createHostClient(connection: HostConnection, local?: HostConnection): HostClient {
  const route = (method: string) => (local && isClientSideMethod(method) ? local : connection);
  const call = <T>(method: string, params: readonly unknown[] = []) => route(method).request<T>(method, params);
  return {
    bootstrap: async () => {
      const bootstrap = await call<HostBootstrap>("bootstrap");
      // Which calls run as jobs depends on the extensions the host just started.
      void connection.refreshJobMethods();
      return bootstrap;
    },
    newSession: (initialPrompt, attachments, cwd, clientMessageIdOrRequestId, prepared, configuration) =>
      call<NewThreadResult>("new-session", [initialPrompt, attachments, cwd, clientMessageIdOrRequestId, prepared, configuration]),
    getPreparedThreadCapability: (cwd) => call<PreparedThreadCapability>("prepared-thread-capability", [cwd]),
    forkThread: (entryId, expectedSessionId) => call<HostActionResult>("fork-thread", [entryId, expectedSessionId]),
    threadTree: (sessionId) => call<UiThreadTree>("thread-tree", [sessionId]),
    navigateThreadTree: (entryId, options, expectedSessionId) =>
      call<ThreadTreeNavigationResult>("navigate-thread-tree", [entryId, options, expectedSessionId]),
    duplicateThread: (expectedSessionId) => call<HostActionResult>("duplicate-thread", [expectedSessionId]),
    switchSession: (path) => call<HostActionResult>("switch-session", [path]),
    openProject: (path) => call<HostActionResult>("open-project", [path]),
    removeProject: (path) => call<HostActionResult>("remove-project", [path]),
    renameThread: (title, expectedSessionId) => call<HostActionResult>("rename-thread", [title, expectedSessionId]),
    recoverThread: () => call<HostActionResult>("recover-thread"),

    preparePrompt: (text, sessionId, skill, backendKind) => call<PreparedPrompt | undefined>("prepare-prompt", [text, sessionId, skill, backendKind]),
    sendPrompt: (text, attachments, sessionId, clientMessageIdOrIdentity, prepared) =>
      call<void>("prompt", [text, attachments, sessionId, clientMessageIdOrIdentity, prepared]),
    steer: (text, attachments, sessionId, clientMessageIdOrIdentity, prepared) =>
      call<void>("steer", [text, attachments, sessionId, clientMessageIdOrIdentity, prepared]),
    followUp: (text, attachments, sessionId, clientMessageIdOrIdentity, prepared) =>
      call<void>("follow-up", [text, attachments, sessionId, clientMessageIdOrIdentity, prepared]),
    abort: (sessionId) => call<void>("abort", [sessionId]),
    queueMessage: (sessionId, text, attachments, skillDraft) => call<{ id: string }>("queue-message", [sessionId, text, attachments, skillDraft]),
    takeQueued: (sessionId, id) => call<UiQueuedPrompt[]>("take-queued", [sessionId, id]),
    moveQueued: (sessionId, id, toIndex) => call<void>("move-queued", [sessionId, id, toIndex]),
    resumeLimited: (sessionId, when) => call<void>("resume-limited", [sessionId, when]),
    runShellAction: (command, includeInContext, expectedCwd) =>
      call<ShellActionResult>("run-shell-action", [command, includeInContext, expectedCwd]),

    loadTranscript: (sessionId, cursor) => call<TranscriptPage>("transcript-page", [sessionId, cursor]),
    readToolOutput: (sessionId, toolCallId) => call<UiToolOutputReadResult | undefined>("read-tool-output", [sessionId, toolCallId]),
    toolOutput: (sessionId, toolCallId) => call<UiToolOutputPreview | undefined>("tool-output", [sessionId, toolCallId]),
    // The host exports the text, the client's own clipboard takes it.
    copyThreadMarkdown: async (expectedSessionId) => {
      const markdown = await call<string | undefined>("copy-thread-markdown", [expectedSessionId]);
      if (typeof markdown === "string" && markdown) await call<void>("copy-text", [markdown]);
    },
    readImagePreview: (path) => call<UiImagePreview | undefined>("read-image-preview", [path]),
    shareFile: (path) => call<UiSharedFile>("share-file", [path]),

    setModel: (provider, id) => call<HostActionResult>("set-model", [provider, id]),
    setThinkingLevel: (level) => call<HostActionResult>("set-thinking", [level]),
    setMode: (mode, expectedSessionId) => call<HostActionResult>("set-mode", [mode, expectedSessionId]),
    compactContext: () => call<HostActionResult>("compact-context"),

    reloadRuntime: () => call<void>("reload-runtime"),
    reloadExtensions: () => call<void>("reload-extensions"),
    answerExtensionUi: (id, answer) => call<void>("answer-extension-ui", [id, answer]),
    syncExtensionUi: () => call<void>("sync-extension-ui"),
    loadDesktopExtensions: (cwd, sharedExports, only) => call<DesktopExtensionLoadResult>("desktop-extensions", [cwd, sharedExports, only]),
    // A command an extension declared long-running waits on `job-done` instead
    // of on one long response, so the host can report progress and be cancelled.
    invokeHostExtension: (extensionId, command, input) => connection.isJobMethod("host-extension", extensionId, command)
      ? connection.runJob<unknown>("host-extension", [extensionId, command, input])
      : call<unknown>("host-extension", [extensionId, command, input]),
    listHostExtensions: () => call<HostExtensionSummary[]>("host-extensions"),
    inspectExtensions: (cwd) => call<ExtensionInspection>("inspect-extensions", [cwd]),
    setHostExtensionActive: (id, active) => call<HostExtensionSummary[]>("host-extension-active", [id, active]),
    grantExtension: (id, grant) => call<void>("extension-grant", [id, grant]),

    prepareWorkbenchReload: (mode) => call<WorkbenchReloadPreparation>("prepare-workbench-reload", [mode]),
    releaseWorkbenchReload: () => call<void>("release-workbench-reload"),
    rebuildWorkbench: () => {
      // A job when the connection that answers it offers jobs; a client-side
      // rebuild is one plain request instead.
      const target = route("rebuild-workbench");
      return target.isJobMethod("rebuild-workbench")
        ? target.runJob<WorkbenchBuildResult>("rebuild-workbench")
        : call<WorkbenchBuildResult>("rebuild-workbench");
    },
    workbenchSource: () => call<{ path?: string }>("workbench-source"),
    relaunchWorkbench: () => call<void>("relaunch-workbench"),
    installUpdate: () => call<{ installing: boolean }>("install-update"),
    getConfig: (workspaceId) => call<TauConfig>("get-config", [workspaceId]),
    updateConfig: (patch, scope, workspaceId) => call<TauConfig>("update-config", [patch, scope, workspaceId]),
    getConfigLayers: (workspaceId) => call<ConfigLayers>("get-config-layers", [workspaceId]),
    clearConfig: (keys, scope, workspaceId) => call<ConfigLayers>("clear-config", [keys, scope, workspaceId]),
    getModelsConfig: () => call<CustomProviderConfig[]>("get-models-config"),
    runtimeCatalog: (kind) => call<UiRuntimeCatalog | undefined>("runtime-catalog", [kind]),
    runtimeCatalogs: (revalidate, known) => call<UiRuntimeCatalog[]>("runtime-catalogs", [revalidate === true, known ?? {}]),
    addModelProvider: (input) => call<UiModel[]>("add-model-provider", [input]),
    inspectSystemPrompt: (threadId, workspaceId) => call<SystemPromptInspection>("inspect-system-prompt", [threadId, workspaceId]),
    listUserThemes: (workspaceId) => call<UserTheme[]>("list-user-themes", [workspaceId]),
    openExternalEditor: (text) => call<ExternalEditorResult>("open-external-editor", [text]),

    // The machine the window runs on, not the host's transport: macOS window chrome keys on it.
    platform: local?.platform ?? connection.platform,
    copyText: (text) => call<void>("copy-text", [text]),
    copyImage: (dataUrl) => call<void>("copy-image", [dataUrl]),
    showNotification: (notification) => call<SystemNotificationOutcome>("notify", [notification]),
    setBadge: (count) => call<void>("set-badge", [count]),
    showContextMenu: async (entries, point) => (await call<{ id?: string } | undefined>("context-menu", [entries, point]))?.id,
    windowAction: (action) => call<unknown>("window-action", [action]),
    // The window's own process publishes these on its own transport; the host never does.
    onHostEvent: (listener) => {
      const offHost = connection.onEvent(listener);
      const offWindow = local?.onEvent((event) => { if (WINDOW_EVENT_TYPES.has(event.type)) listener(event); });
      return () => { offHost(); offWindow?.(); };
    },
    hasCapability: connection.hasCapability,
    getConnectionState: connection.getState,
    getConnectionRefusal: connection.getRefusal,
    onConnectionState: (listener) => connection.onState(listener),
    getVersions: () => ({ host: connection.getHostVersion(), window: local?.getHostVersion() }),
    onVersions: (listener) => {
      const offHost = connection.onHello(listener);
      const offWindow = local?.onHello(listener);
      return () => { offHost(); offWindow?.(); };
    },

    listConnections: () => call<UiConnections>("connections-list"),
    createPairingLink: (input) => call<UiCreatedPairingLink>("connections-create-link", [input ?? {}]),
    revokePairingLink: (id) => call<{ revoked: boolean }>("connections-revoke-link", [id]),
    revokeClient: (id) => call<{ revoked: boolean }>("connections-revoke-client", [id]),
    rotateHostToken: async () => {
      const { token } = await call<{ token: string }>("connections-rotate-host-token");
      connection.updateToken(token);
    },
    serviceStatus: () => call<UiHostService>("service-status"),
    installService: () => call<UiHostService>("service-install"),
    uninstallService: () => call<UiHostService>("service-uninstall"),
  };
}
