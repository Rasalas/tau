import { contextBridge, ipcRenderer } from "electron";
import type { DiffLoadOptions, HostEvent, TauDesktopApi } from "../shared/contracts.js";

const api: TauDesktopApi = {
  platform: process.platform,
  bootstrap: () => ipcRenderer.invoke("tau:bootstrap"),
  loadTranscript: (sessionId, cursor) => ipcRenderer.invoke("tau:transcript-page", sessionId, cursor),
  sendPrompt: (text, attachments) => ipcRenderer.invoke("tau:prompt", text, attachments),
  runShellAction: (command, includeInContext, expectedCwd) => ipcRenderer.invoke("tau:run-shell-action", command, includeInContext, expectedCwd),
  steer: (text, attachments) => ipcRenderer.invoke("tau:steer", text, attachments),
  abort: () => ipcRenderer.invoke("tau:abort"),
  newSession: () => ipcRenderer.invoke("tau:new-session"),
  switchSession: (path) => ipcRenderer.invoke("tau:switch-session", path),
  setModel: (provider, id) => ipcRenderer.invoke("tau:set-model", provider, id),
  setThinkingLevel: (level) => ipcRenderer.invoke("tau:set-thinking", level),
  compactContext: () => ipcRenderer.invoke("tau:compact-context"),
  reloadRuntime: () => ipcRenderer.invoke("tau:reload-runtime"),
  setServiceTier: (tier) => ipcRenderer.invoke("tau:set-service-tier", tier),
  setAccessLevel: (level) => ipcRenderer.invoke("tau:set-access-level", level),
  resolveToolApproval: (id, allowed) => ipcRenderer.invoke("tau:resolve-tool-approval", id, allowed),
  renameThread: (title, expectedSessionId) => ipcRenderer.invoke("tau:rename-thread", title, expectedSessionId),
  copyText: (text) => ipcRenderer.invoke("tau:copy-text", text),
  generateThreadTitle: (provider, modelId, force, expectedSessionId) => ipcRenderer.invoke("tau:generate-thread-title", provider, modelId, force, expectedSessionId),
  chooseWorkspace: () => ipcRenderer.invoke("tau:choose-workspace"),
  openProject: (path) => ipcRenderer.invoke("tau:open-project", path),
  cloneProject: (repositoryUrl) => ipcRenderer.invoke("tau:clone-project", repositoryUrl),
  getFileTree: (path) => ipcRenderer.invoke("tau:file-tree", path),
  getChanges: () => ipcRenderer.invoke("tau:changes"),
  getFileDiff: (path, options?: DiffLoadOptions) => ipcRenderer.invoke("tau:file-diff", path, options),
  commit: (message, push) => ipcRenderer.invoke("tau:commit", message, push),
  push: () => ipcRenderer.invoke("tau:push"),
  getWorkspaceInfo: () => ipcRenderer.invoke("tau:workspace-info"),
  createWorktree: (branch) => ipcRenderer.invoke("tau:create-worktree", branch),
  switchRef: (ref) => ipcRenderer.invoke("tau:switch-ref", ref),
  listEditors: () => ipcRenderer.invoke("tau:list-editors"),
  openInEditor: (editorId, path) => ipcRenderer.invoke("tau:open-in-editor", editorId, path),
  onHostEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: HostEvent) => listener(payload);
    ipcRenderer.on("tau:host-event", handler);
    return () => ipcRenderer.removeListener("tau:host-event", handler);
  },
};

contextBridge.exposeInMainWorld("tau", api);
