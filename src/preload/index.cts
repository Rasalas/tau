import { contextBridge, ipcRenderer } from "electron";
import type { HostEvent, TauDesktopApi } from "../shared/contracts.js";

const api: TauDesktopApi = {
  platform: process.platform,
  bootstrap: () => ipcRenderer.invoke("tau:bootstrap"),
  loadTranscript: (sessionId, cursor) => ipcRenderer.invoke("tau:transcript-page", sessionId, cursor),
  sendPrompt: (text) => ipcRenderer.invoke("tau:prompt", text),
  steer: (text) => ipcRenderer.invoke("tau:steer", text),
  abort: () => ipcRenderer.invoke("tau:abort"),
  newSession: () => ipcRenderer.invoke("tau:new-session"),
  switchSession: (path) => ipcRenderer.invoke("tau:switch-session", path),
  setModel: (provider, id) => ipcRenderer.invoke("tau:set-model", provider, id),
  setThinkingLevel: (level) => ipcRenderer.invoke("tau:set-thinking", level),
  compactContext: () => ipcRenderer.invoke("tau:compact-context"),
  setAccessLevel: (level) => ipcRenderer.invoke("tau:set-access-level", level),
  resolveToolApproval: (id, allowed) => ipcRenderer.invoke("tau:resolve-tool-approval", id, allowed),
  generateThreadTitle: (provider, modelId, force) => ipcRenderer.invoke("tau:generate-thread-title", provider, modelId, force),
  chooseWorkspace: () => ipcRenderer.invoke("tau:choose-workspace"),
  openProject: (path) => ipcRenderer.invoke("tau:open-project", path),
  cloneProject: (repositoryUrl) => ipcRenderer.invoke("tau:clone-project", repositoryUrl),
  getFileTree: () => ipcRenderer.invoke("tau:file-tree"),
  getChanges: () => ipcRenderer.invoke("tau:changes"),
  getFileDiff: (path) => ipcRenderer.invoke("tau:file-diff", path),
  commit: (message, push) => ipcRenderer.invoke("tau:commit", message, push),
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
