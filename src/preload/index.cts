import { contextBridge, ipcRenderer } from "electron";
import type { DiffLoadOptions, HostEvent, TauDesktopApi } from "../shared/contracts.js";
import { isHostUpdate } from "../shared/host-protocol.js";

const api: TauDesktopApi = {
  platform: process.platform,
  bootstrap: () => ipcRenderer.invoke("tau:bootstrap"),
  loadTranscript: (sessionId, cursor) => ipcRenderer.invoke("tau:transcript-page", sessionId, cursor),
  preparePrompt: (text, sessionId, skill) => ipcRenderer.invoke("tau:prepare-prompt", text, sessionId, skill),
  sendPrompt: (text, attachments, sessionId, clientMessageIdOrIdentity, prepared) => ipcRenderer.invoke("tau:prompt", text, attachments, sessionId, clientMessageIdOrIdentity, prepared),
  runShellAction: (command, includeInContext, expectedCwd) => ipcRenderer.invoke("tau:run-shell-action", command, includeInContext, expectedCwd),
  steer: (text, attachments, sessionId, clientMessageIdOrIdentity, prepared) => ipcRenderer.invoke("tau:steer", text, attachments, sessionId, clientMessageIdOrIdentity, prepared),
  followUp: (text, attachments, sessionId, clientMessageIdOrIdentity, prepared) => ipcRenderer.invoke("tau:follow-up", text, attachments, sessionId, clientMessageIdOrIdentity, prepared),
  abort: (sessionId) => ipcRenderer.invoke("tau:abort", sessionId),
  newSession: (initialPrompt, attachments, cwd, clientMessageIdOrRequestId, prepared) => ipcRenderer.invoke("tau:new-session", initialPrompt, attachments, cwd, clientMessageIdOrRequestId, prepared),
  getPreparedThreadCapability: (cwd) => ipcRenderer.invoke("tau:prepared-thread-capability", cwd),
  forkThread: (entryId, expectedSessionId) => ipcRenderer.invoke("tau:fork-thread", entryId, expectedSessionId),
  switchSession: (path) => ipcRenderer.invoke("tau:switch-session", path),
  setModel: (provider, id) => ipcRenderer.invoke("tau:set-model", provider, id),
  setThinkingLevel: (level) => ipcRenderer.invoke("tau:set-thinking", level),
  compactContext: () => ipcRenderer.invoke("tau:compact-context"),
  recoverThread: () => ipcRenderer.invoke("tau:recover-thread"),
  reloadRuntime: () => ipcRenderer.invoke("tau:reload-runtime"),
  setServiceTier: (tier) => ipcRenderer.invoke("tau:set-service-tier", tier),
  setAccessLevel: (level) => ipcRenderer.invoke("tau:set-access-level", level),
  resolveToolApproval: (id, allowed) => ipcRenderer.invoke("tau:resolve-tool-approval", id, allowed),
  answerExtensionUi: (id, answer) => ipcRenderer.invoke("tau:answer-extension-ui", id, answer),
  syncExtensionUi: () => ipcRenderer.invoke("tau:sync-extension-ui"),
  renameThread: (title, expectedSessionId) => ipcRenderer.invoke("tau:rename-thread", title, expectedSessionId),
  copyText: (text) => ipcRenderer.invoke("tau:copy-text", text),
  copyThreadMarkdown: (expectedSessionId) => ipcRenderer.invoke("tau:copy-thread-markdown", expectedSessionId),
  readImagePreview: (path) => ipcRenderer.invoke("tau:read-image-preview", path),
  generateThreadTitle: (provider, modelId, force, expectedSessionId) => ipcRenderer.invoke("tau:generate-thread-title", provider, modelId, force, expectedSessionId),
  chooseWorkspace: () => ipcRenderer.invoke("tau:choose-workspace"),
  listDirectories: (path) => ipcRenderer.invoke("tau:list-directories", path),
  openProject: (path) => ipcRenderer.invoke("tau:open-project", path),
  removeProject: (path) => ipcRenderer.invoke("tau:remove-project", path),
  cloneProject: (repositoryUrl) => ipcRenderer.invoke("tau:clone-project", repositoryUrl),
  getFileTree: (path) => ipcRenderer.invoke("tau:file-tree", path),
  getChanges: () => ipcRenderer.invoke("tau:changes"),
  getFileDiff: (path, options?: DiffLoadOptions) => ipcRenderer.invoke("tau:file-diff", path, options),
  getTurnFileDiff: (sessionId, checkpointId, path, options?: DiffLoadOptions) => ipcRenderer.invoke("tau:turn-file-diff", sessionId, checkpointId, path, options),
  getTurnFiles: (sessionId, checkpointId, cursor, limit) => ipcRenderer.invoke("tau:turn-files", sessionId, checkpointId, cursor, limit),
  commit: (message, push) => ipcRenderer.invoke("tau:commit", message, push),
  push: () => ipcRenderer.invoke("tau:push"),
  getWorkspaceInfo: () => ipcRenderer.invoke("tau:workspace-info"),
  createWorktree: (branch, baseRef) => ipcRenderer.invoke("tau:create-worktree", branch, baseRef),
  switchRef: (ref) => ipcRenderer.invoke("tau:switch-ref", ref),
  listEditors: () => ipcRenderer.invoke("tau:list-editors"),
  openInEditor: (editorId, path) => ipcRenderer.invoke("tau:open-in-editor", editorId, path),
  loadDesktopExtensions: (cwd, sharedExports) => ipcRenderer.invoke("tau:desktop-extensions", cwd, sharedExports),
  rebuildWorkbench: () => ipcRenderer.invoke("tau:rebuild-workbench"),
  relaunchWorkbench: () => ipcRenderer.invoke("tau:relaunch-workbench"),
  onHostEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: HostEvent) => {
      // IPC payloads are untrusted. In particular, never let a contradictory
      // cursor/hasMore/completeness tuple enter the renderer state machine.
      if (payload?.type === "host-update" && !isHostUpdate(payload.update)) return;
      listener(payload);
    };
    ipcRenderer.on("tau:host-event", handler);
    return () => ipcRenderer.removeListener("tau:host-event", handler);
  },
};

contextBridge.exposeInMainWorld("tau", api);
