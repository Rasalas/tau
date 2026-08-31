import { execFile } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from "electron";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AccessLevel, ExtensionUiAnswer, HostEvent, ServiceTier, UiPromptAttachment } from "../shared/contracts.js";
import { PiHost } from "./pi-host.js";
import { assertAllowedCloneSource } from "./clone-source.js";
import { ProjectHistory } from "./project-history.js";
import { readBoundedImagePreview } from "./image-preview.js";
import { loadDesktopExtensions } from "./desktop-extensions.js";
import { rebuildWorkbench } from "./workbench-build.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const currentDir = dirname(fileURLToPath(import.meta.url));
const defaultWorkspace = process.env.TAU_WORKSPACE || process.cwd();
const safeMode = process.env.TAU_NO_EXTENSIONS === "1";
const execFileAsync = promisify(execFile);

async function rendererImagePreview(path: string) {
  const preview = await readBoundedImagePreview(path);
  if (!preview) return undefined;
  const image = nativeImage.createFromDataURL(preview.dataUrl);
  const size = image.getSize();
  const longest = Math.max(size.width, size.height);
  if (image.isEmpty() || longest <= 1_400) return preview;
  const scale = 1_400 / longest;
  const resized = image.resize({
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
    quality: "best",
  });
  return { name: preview.name, dataUrl: `data:image/png;base64,${resized.toPNG().toString("base64")}` };
}

async function listDirectories(requested?: string) {
  const candidate = requested?.trim() || homedir();
  if (!isAbsolute(candidate)) throw new Error("Choose an absolute folder path.");
  const path = await realpath(candidate);
  const entries = await readdir(path, { withFileTypes: true });
  return {
    path,
    ...(dirname(path) !== path ? { parent: dirname(path) } : {}),
    directories: entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true })),
  };
}

function repositoryFolderName(repositoryUrl: string): string {
  const normalized = repositoryUrl.trim().replace(/[\\/]+$/u, "").replace(/\.git$/iu, "");
  const name = normalized.split(/[\\/:]/u).filter(Boolean).at(-1) ?? "repository";
  return name.replace(/[^a-z0-9._-]+/giu, "-") || "repository";
}
let mainWindow: BrowserWindow | undefined;
let host: PiHost | undefined;
let hostReady: Promise<unknown> | undefined;
let projectHistory: ProjectHistory;
let shutdownStarted = false;
let shutdownComplete = false;
/** One build at a time; a second request joins the running one. */
let rebuild: Promise<unknown> | undefined;

function publish(event: HostEvent): void {
  if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send("tau:host-event", event);
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1080,
    minHeight: 680,
    titleBarStyle: "hiddenInset",
    // Centres the native traffic lights in Tau's 46px title bar.
    trafficLightPosition: { x: 19, y: 15 },
    backgroundColor: "#11110f",
    webPreferences: {
      preload: join(currentDir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Links in agent output open in the browser; nothing may navigate the workbench away.
  const openExternally = (url: string): void => {
    if (/^https?:\/\//u.test(url)) void shell.openExternal(url);
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url === mainWindow?.webContents.getURL()) return;
    event.preventDefault();
    openExternally(url);
  });

  if (process.env.TAU_DEV_SERVER_URL) {
    const url = new URL(process.env.TAU_DEV_SERVER_URL);
    if (safeMode) url.searchParams.set("safeMode", "1");
    await mainWindow.loadURL(url.toString());
  } else {
    await mainWindow.loadFile(join(currentDir, "../../dist/index.html"), {
      query: safeMode ? { safeMode: "1" } : {},
    });
  }
}

async function requireHostReady(): Promise<PiHost> {
  await hostReady;
  if (!host) throw new Error("No host available.");
  return host;
}

function installIpc(): void {
  ipcMain.handle("tau:bootstrap", async () => {
    if (!host) {
      host = new PiHost(defaultWorkspace, publish, projectHistory, safeMode);
      host.onWindowTitle = (title) => { if (!mainWindow?.isDestroyed()) mainWindow?.setTitle(title); };
      hostReady = host.start();
      return hostReady;
    }
    await hostReady;
    return host.bootstrap();
  });
  ipcMain.handle("tau:transcript-page", async (_event, sessionId: string, cursor?: string) => (await requireHostReady()).loadTranscript(sessionId, cursor));
  ipcMain.handle("tau:prompt", async (_event, text: string, attachments?: UiPromptAttachment[], sessionId?: string) => (await requireHostReady()).prompt(text, attachments, sessionId));
  ipcMain.handle("tau:run-shell-action", async (_event, command: string, includeInContext?: boolean, expectedCwd?: string) => (await requireHostReady()).runShellAction(command, includeInContext, expectedCwd));
  ipcMain.handle("tau:steer", async (_event, text: string, attachments?: UiPromptAttachment[], sessionId?: string) => (await requireHostReady()).steer(text, attachments, sessionId));
  ipcMain.handle("tau:follow-up", async (_event, text: string, attachments?: UiPromptAttachment[], sessionId?: string) => (await requireHostReady()).followUp(text, attachments, sessionId));
  // Stopping must not queue behind host readiness: a thread stuck on a question
  // is exactly what the user is trying to get out of.
  ipcMain.handle("tau:abort", async (_event, sessionId?: string) => host?.abort(sessionId));
  ipcMain.handle("tau:new-session", async (_event, initialPrompt?: string, attachments?: UiPromptAttachment[], cwd?: string, requestId?: string) =>
    (await requireHostReady()).newSession(initialPrompt, attachments, cwd, requestId));
  ipcMain.handle("tau:prepared-thread-capability", async (_event, cwd?: string) =>
    (await requireHostReady()).getPreparedThreadCapability(cwd));
  ipcMain.handle("tau:fork-thread", async (_event, entryId: string, expectedSessionId?: string) => (await requireHostReady()).forkThread(entryId, expectedSessionId));
  ipcMain.handle("tau:switch-session", async (_event, path: string) => (await requireHostReady()).switchSession(path));
  ipcMain.handle("tau:set-model", async (_event, provider: string, id: string) => (await requireHostReady()).setModel(provider, id));
  ipcMain.handle("tau:set-thinking", async (_event, level: string) => (await requireHostReady()).setThinkingLevel(level));
  ipcMain.handle("tau:compact-context", async () => (await requireHostReady()).compactContext());
  ipcMain.handle("tau:reload-runtime", async () => (await requireHostReady()).reloadRuntime());
  ipcMain.handle("tau:set-access-level", async (_event, level: AccessLevel) => (await requireHostReady()).setAccessLevel(level));
  ipcMain.handle("tau:resolve-tool-approval", async (_event, id: string, allowed: boolean) => (await requireHostReady()).resolveToolApproval(id, allowed));
  // Answering must never wait for a ready host: the host is blocked on this very
  // question, so requiring readiness here would deadlock startup.
  ipcMain.handle("tau:answer-extension-ui", (_event, id: string, answer: ExtensionUiAnswer) => host?.answerExtensionUi(id, answer));
  ipcMain.handle("tau:sync-extension-ui", () => host?.replayOpenUiPrompts());
  ipcMain.handle("tau:set-service-tier", async (_event, tier: ServiceTier) => (await requireHostReady()).setServiceTier(tier));
  ipcMain.handle("tau:recover-thread", async () => (await requireHostReady()).recoverThread());
  ipcMain.handle("tau:rename-thread", async (_event, title: string, expectedSessionId?: string) => (await requireHostReady()).renameThread(title, expectedSessionId));
  ipcMain.handle("tau:copy-text", (_event, text: string) => clipboard.writeText(text));
  ipcMain.handle("tau:copy-thread-markdown", async (_event, expectedSessionId?: string) => {
    clipboard.writeText(await (await requireHostReady()).exportThreadMarkdown(expectedSessionId));
  });
  ipcMain.handle("tau:read-image-preview", async (_event, path: string) => rendererImagePreview(path));
  ipcMain.handle("tau:generate-thread-title", async (_event, provider: string, modelId: string, force?: boolean, expectedSessionId?: string) => (await requireHostReady()).generateThreadTitle(provider, modelId, force, expectedSessionId));
  ipcMain.handle("tau:file-tree", async (_event, path?: string) => (await requireHostReady()).getFileTree(path));
  ipcMain.handle("tau:changes", async () => (await requireHostReady()).getChanges());
  ipcMain.handle("tau:file-diff", async (_event, path: string, options?: import("../shared/contracts.js").DiffLoadOptions) => (await requireHostReady()).getFileDiff(path, options));
  ipcMain.handle("tau:commit", async (_event, message: string, push: boolean) => (await requireHostReady()).commit(message, push));
  ipcMain.handle("tau:push", async () => (await requireHostReady()).push());
  ipcMain.handle("tau:workspace-info", async () => (await requireHostReady()).getWorkspaceInfo());
  ipcMain.handle("tau:create-worktree", async (_event, branch: string, baseRef?: string) => (await requireHostReady()).createWorktree(branch, baseRef));
  ipcMain.handle("tau:switch-ref", async (_event, ref: string) => (await requireHostReady()).switchRef(ref));
  ipcMain.handle("tau:list-editors", async () => (await requireHostReady()).listEditors());
  ipcMain.handle("tau:open-in-editor", async (_event, editorId: string, path?: string) => (await requireHostReady()).openInEditor(editorId, path));
  ipcMain.handle("tau:list-directories", async (_event, path?: string) => listDirectories(path));
  ipcMain.handle("tau:desktop-extensions", async (_event, cwd: string, sharedExports: Record<string, string[]>) =>
    loadDesktopExtensions(cwd, getAgentDir(), { sharedExports }));
  ipcMain.handle("tau:rebuild-workbench", async () => {
    if (rebuild) return rebuild;
    rebuild = rebuildWorkbench(app.getAppPath(), {
      onOutput: (line) => publish({ type: "event-log", label: "workbench.build", detail: line, timestamp: Date.now() }),
    }).finally(() => { rebuild = undefined; });
    return rebuild;
  });
  ipcMain.handle("tau:relaunch-workbench", () => {
    app.relaunch();
    app.quit();
  });
  ipcMain.handle("tau:choose-workspace", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory"] });
    const selected = result.filePaths[0];
    return selected ? (await requireHostReady()).setWorkspace(selected) : undefined;
  });
  ipcMain.handle("tau:open-project", async (_event, path: string) => (await requireHostReady()).setWorkspace(path));
  ipcMain.handle("tau:remove-project", async (_event, path: string) => (await requireHostReady()).removeProject(path));
  ipcMain.handle("tau:clone-project", async (_event, repositoryUrl: string) => {
    const url = assertAllowedCloneSource(repositoryUrl);
    const result = await dialog.showOpenDialog(mainWindow!, {
      buttonLabel: "Clone here",
      message: "Choose the parent folder for the cloned project",
      properties: ["openDirectory", "createDirectory"],
    });
    const parent = result.filePaths[0];
    if (!parent) return undefined;
    const readyHost = await requireHostReady();
    const destination = join(parent, repositoryFolderName(url));
    await execFileAsync("git", ["clone", "--", url, destination], {
      timeout: 10 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return readyHost.setWorkspace(destination);
  });
}

app.whenReady().then(async () => {
  projectHistory = new ProjectHistory(join(app.getPath("userData"), "projects.json"));
  await projectHistory.load();
  // Prepare the host before creating the renderer so bootstrap is a read of
  // already-started work, not the first expensive lifecycle operation.
  host = new PiHost(defaultWorkspace, publish, projectHistory, safeMode);
  hostReady = host.start();
  installIpc();
  await createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on("before-quit", (event) => {
  if (!host || shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  void host.dispose()
    .catch((error) => console.error("Tau host shutdown failed", error))
    .finally(() => {
      shutdownComplete = true;
      app.quit();
    });
});
