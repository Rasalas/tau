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

/**
 * Transport-neutral view of the desktop host. Electron IPC is one
 * implementation (`createElectronHostClient`); a remote host would be another.
 * No renderer module outside this file and `main.tsx` may reach `window.tau`.
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
}

/** Thin delegation to the Electron preload bridge; carries no logic of its own. */
export function createElectronHostClient(api: TauDesktopApi): HostClient {
  return {
    bootstrap: () => api.bootstrap(),
    newSession: (initialPrompt, attachments, cwd, clientMessageIdOrRequestId, prepared) =>
      api.newSession(initialPrompt, attachments, cwd, clientMessageIdOrRequestId, prepared),
    getPreparedThreadCapability: (cwd) => api.getPreparedThreadCapability(cwd),
    forkThread: (entryId, expectedSessionId) => api.forkThread(entryId, expectedSessionId),
    threadTree: (sessionId) => api.threadTree(sessionId),
    navigateThreadTree: (entryId, options, expectedSessionId) => api.navigateThreadTree(entryId, options, expectedSessionId),
    duplicateThread: (expectedSessionId) => api.duplicateThread(expectedSessionId),
    switchSession: (path) => api.switchSession(path),
    openProject: (path) => api.openProject(path),
    removeProject: (path) => api.removeProject(path),
    renameThread: (title, expectedSessionId) => api.renameThread(title, expectedSessionId),
    recoverThread: () => api.recoverThread(),

    preparePrompt: (text, sessionId, skill) => api.preparePrompt(text, sessionId, skill),
    sendPrompt: (text, attachments, sessionId, clientMessageIdOrIdentity, prepared) =>
      api.sendPrompt(text, attachments, sessionId, clientMessageIdOrIdentity, prepared),
    steer: (text, attachments, sessionId, clientMessageIdOrIdentity, prepared) =>
      api.steer(text, attachments, sessionId, clientMessageIdOrIdentity, prepared),
    followUp: (text, attachments, sessionId, clientMessageIdOrIdentity, prepared) =>
      api.followUp(text, attachments, sessionId, clientMessageIdOrIdentity, prepared),
    abort: (sessionId) => api.abort(sessionId),
    runShellAction: (command, includeInContext, expectedCwd) => api.runShellAction(command, includeInContext, expectedCwd),

    loadTranscript: (sessionId, cursor) => api.loadTranscript(sessionId, cursor),
    readToolOutput: (sessionId, toolCallId) => api.readToolOutput(sessionId, toolCallId),
    copyThreadMarkdown: (expectedSessionId) => api.copyThreadMarkdown(expectedSessionId),
    readImagePreview: (path) => api.readImagePreview(path),

    setModel: (provider, id) => api.setModel(provider, id),
    setThinkingLevel: (level) => api.setThinkingLevel(level),
    compactContext: () => api.compactContext(),

    reloadRuntime: () => api.reloadRuntime(),
    answerExtensionUi: (id, answer) => api.answerExtensionUi(id, answer),
    syncExtensionUi: () => api.syncExtensionUi(),
    loadDesktopExtensions: (cwd, sharedExports) => api.loadDesktopExtensions(cwd, sharedExports),
    invokeHostExtension: (extensionId, command, input) => api.invokeHostExtension(extensionId, command, input),
    listHostExtensions: () => api.listHostExtensions(),
    inspectExtensions: (cwd) => api.inspectExtensions(cwd),
    setHostExtensionActive: (id, active) => api.setHostExtensionActive(id, active),
    grantExtension: (id, grant) => api.grantExtension(id, grant),

    prepareWorkbenchReload: (mode) => api.prepareWorkbenchReload(mode),
    releaseWorkbenchReload: () => api.releaseWorkbenchReload(),
    rebuildWorkbench: () => api.rebuildWorkbench(),
    relaunchWorkbench: () => api.relaunchWorkbench(),

    platform: api.platform,
    copyText: (text) => api.copyText(text),
    copyImage: (dataUrl) => api.copyImage(dataUrl),
    onHostEvent: (listener) => api.onHostEvent(listener),
  };
}
