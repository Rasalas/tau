import type {
  DesktopExtensionLoadResult,
  ExtensionInspection,
  ExtensionUiAnswer,
  HostExtensionSummary,
  PreparedPrompt,
  PreparedThreadCapability,
  ShellActionResult,
  TauDesktopApi,
  ThreadTreeNavigationResult,
  UiImagePreview,
  UiPromptAttachment,
  UiSkillDraft,
  UiThreadTree,
  UiToolOutputReadResult,
  WorkbenchBuildResult,
  WorkbenchReloadMode,
  WorkbenchReloadPreparation,
  HostEvent,
  ClientTurnIdentity,
} from "../shared/contracts";
import type { HostActionResult, NewThreadResult, TranscriptPage } from "../shared/host-protocol";
import type { HostBootstrap } from "../shared/contracts";
import type { HostTranscriptCursor } from "../shared/transcript-cursor";
import { HostConnection, createElectronHostTransport, type HostConnectionState } from "./host-connection";

/**
 * Transport-neutral view of the desktop host. Every method is one call of the
 * versioned host protocol on a `HostConnection`; Electron IPC and the local
 * socket are two transports under it. No renderer module outside this file and
 * `main.tsx` may reach `window.tau`.
 */
export interface HostClient {
  // Thread lifecycle and navigation: create, resume, switch, and manage projects.
  bootstrap(): Promise<HostBootstrap>;
  newSession(initialPrompt?: string, attachments?: UiPromptAttachment[], cwd?: string, clientMessageIdOrRequestId?: string | ClientTurnIdentity, prepared?: PreparedPrompt): Promise<NewThreadResult>;
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
  preparePrompt(text: string, sessionId?: string, skill?: UiSkillDraft): Promise<PreparedPrompt | undefined>;
  sendPrompt(text: string, attachments?: UiPromptAttachment[], sessionId?: string, clientMessageIdOrIdentity?: string | ClientTurnIdentity, prepared?: PreparedPrompt): Promise<void>;
  steer(text: string, attachments?: UiPromptAttachment[], sessionId?: string, clientMessageIdOrIdentity?: string | ClientTurnIdentity, prepared?: PreparedPrompt): Promise<void>;
  followUp(text: string, attachments?: UiPromptAttachment[], sessionId?: string, clientMessageIdOrIdentity?: string | ClientTurnIdentity, prepared?: PreparedPrompt): Promise<void>;
  abort(sessionId?: string): Promise<void>;
  runShellAction(command: string, includeInContext?: boolean, expectedCwd?: string): Promise<ShellActionResult>;

  // Reading transcript history and durable tool output.
  loadTranscript(sessionId: string, cursor?: HostTranscriptCursor): Promise<TranscriptPage>;
  readToolOutput(sessionId: string, toolCallId: string): Promise<UiToolOutputReadResult | undefined>;
  copyThreadMarkdown(expectedSessionId?: string): Promise<void>;
  readImagePreview(path: string): Promise<UiImagePreview | undefined>;

  // Model, thinking level, and context for the active thread.
  setModel(provider: string, id: string): Promise<HostActionResult>;
  setThinkingLevel(level: string): Promise<HostActionResult>;
  compactContext(): Promise<HostActionResult>;

  // Desktop/host extension lifecycle and the generic host-extension channel.
  reloadRuntime(): Promise<void>;
  answerExtensionUi(id: string, answer: ExtensionUiAnswer): Promise<void>;
  syncExtensionUi(): Promise<void>;
  loadDesktopExtensions(cwd: string, sharedExports: Record<string, string[]>): Promise<DesktopExtensionLoadResult>;
  invokeHostExtension(extensionId: string, command: string, input?: unknown): Promise<unknown>;
  listHostExtensions(): Promise<HostExtensionSummary[]>;
  inspectExtensions(cwd: string): Promise<ExtensionInspection>;
  setHostExtensionActive(id: string, active: boolean): Promise<HostExtensionSummary[]>;
  grantExtension(id: string, grant: boolean): Promise<void>;

  // Rebuilding, reloading, and restarting the workbench itself.
  prepareWorkbenchReload(mode: WorkbenchReloadMode): Promise<WorkbenchReloadPreparation>;
  releaseWorkbenchReload(): Promise<void>;
  rebuildWorkbench(): Promise<WorkbenchBuildResult>;
  relaunchWorkbench(): Promise<void>;

  // Clipboard, window chrome, and the host event stream.
  readonly platform: string;
  copyText(text: string): Promise<void>;
  copyImage(dataUrl: string): Promise<void>;
  onHostEvent(listener: (event: HostEvent) => void): () => void;
  /**
   * Whether the host announced a capability in its hello. `local-files` means
   * the host's paths are paths of this machine, so opening or copying one makes
   * sense; without it the workbench offers neither.
   */
  hasCapability(capability: string): boolean;
  /** Whether the link to the host is whole, being repaired, or refetching state. */
  getConnectionState(): HostConnectionState;
  onConnectionState(listener: (state: HostConnectionState) => void): () => void;
}

/** Builds the typed host surface over one connection; the method names are the protocol. */
export function createHostClient(connection: HostConnection): HostClient {
  const call = <T>(method: string, params: readonly unknown[] = []) => connection.request<T>(method, params);
  return {
    bootstrap: async () => {
      const bootstrap = await call<HostBootstrap>("bootstrap");
      // Which calls run as jobs depends on the extensions the host just started.
      void connection.refreshJobMethods();
      return bootstrap;
    },
    newSession: (initialPrompt, attachments, cwd, clientMessageIdOrRequestId, prepared) =>
      call<NewThreadResult>("new-session", [initialPrompt, attachments, cwd, clientMessageIdOrRequestId, prepared]),
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

    preparePrompt: (text, sessionId, skill) => call<PreparedPrompt | undefined>("prepare-prompt", [text, sessionId, skill]),
    sendPrompt: (text, attachments, sessionId, clientMessageIdOrIdentity, prepared) =>
      call<void>("prompt", [text, attachments, sessionId, clientMessageIdOrIdentity, prepared]),
    steer: (text, attachments, sessionId, clientMessageIdOrIdentity, prepared) =>
      call<void>("steer", [text, attachments, sessionId, clientMessageIdOrIdentity, prepared]),
    followUp: (text, attachments, sessionId, clientMessageIdOrIdentity, prepared) =>
      call<void>("follow-up", [text, attachments, sessionId, clientMessageIdOrIdentity, prepared]),
    abort: (sessionId) => call<void>("abort", [sessionId]),
    runShellAction: (command, includeInContext, expectedCwd) =>
      call<ShellActionResult>("run-shell-action", [command, includeInContext, expectedCwd]),

    loadTranscript: (sessionId, cursor) => call<TranscriptPage>("transcript-page", [sessionId, cursor]),
    readToolOutput: (sessionId, toolCallId) => call<UiToolOutputReadResult | undefined>("read-tool-output", [sessionId, toolCallId]),
    copyThreadMarkdown: (expectedSessionId) => call<void>("copy-thread-markdown", [expectedSessionId]),
    readImagePreview: (path) => call<UiImagePreview | undefined>("read-image-preview", [path]),

    setModel: (provider, id) => call<HostActionResult>("set-model", [provider, id]),
    setThinkingLevel: (level) => call<HostActionResult>("set-thinking", [level]),
    compactContext: () => call<HostActionResult>("compact-context"),

    reloadRuntime: () => call<void>("reload-runtime"),
    answerExtensionUi: (id, answer) => call<void>("answer-extension-ui", [id, answer]),
    syncExtensionUi: () => call<void>("sync-extension-ui"),
    loadDesktopExtensions: (cwd, sharedExports) => call<DesktopExtensionLoadResult>("desktop-extensions", [cwd, sharedExports]),
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
    rebuildWorkbench: () => connection.isJobMethod("rebuild-workbench")
      ? connection.runJob<WorkbenchBuildResult>("rebuild-workbench")
      : call<WorkbenchBuildResult>("rebuild-workbench"),
    relaunchWorkbench: () => call<void>("relaunch-workbench"),

    platform: connection.platform,
    copyText: (text) => call<void>("copy-text", [text]),
    copyImage: (dataUrl) => call<void>("copy-image", [dataUrl]),
    onHostEvent: (listener) => connection.onEvent(listener),
    hasCapability: connection.hasCapability,
    getConnectionState: connection.getState,
    onConnectionState: (listener) => connection.onState(listener),
  };
}

/** Electron IPC as one transport of the protocol; `main.tsx` builds this one. */
export function createElectronHostClient(api: TauDesktopApi): { client: HostClient; connection: HostConnection } {
  const connection = new HostConnection(createElectronHostTransport(api));
  return { client: createHostClient(connection), connection };
}
