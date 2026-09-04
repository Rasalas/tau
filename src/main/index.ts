import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientTurnIdentity, ExtensionUiAnswer, HostEvent, UiPromptAttachment } from "../shared/contracts.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import { PiHost } from "./pi-host.js";
import { selectDefaultBackend } from "./runtime-adapters.js";
import { ProjectHistory } from "./project-history.js";
import { readBoundedImagePreview } from "./image-preview.js";
import { validateImageDataUrl } from "./image-clipboard.js";
import { loadDesktopExtensions } from "./desktop-extensions.js";
import { rebuildWorkbench } from "./workbench-build.js";
import { bundledHostExtensions } from "./extensions/index.js";
import { getAgentDir, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { inspectExtensionPackages, loadHostExtensionPackages } from "./extension-packages.js";
import { installShellEnvironment } from "./shell-environment.js";
import { configureAppIdentity, installSingleInstance } from "./single-instance.js";
import { EXTENSION_API_VERSION, type ExtensionHostVersions } from "../shared/extension-compat.js";
import { HostLog } from "./host-log.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const appIconPath = join(app.getAppPath(), "assets/tau-icon.png");
const defaultWorkspace = process.env.TAU_WORKSPACE || process.cwd();
const safeMode = process.env.TAU_NO_EXTENSIONS === "1";

// Identity (and so userData) must be set before anything reads app.getPath("userData").
configureAppIdentity(app, process.env.TAU_USER_DATA);
const hostLog = new HostLog({ dir: join(app.getPath("userData"), "logs") });

process.on("uncaughtException", (error) => {
  hostLog.error("process.uncaughtException", error);
  dialog.showErrorBox("Tau hit an unexpected error and needs to close", `Details were written to:\n${hostLog.filePath}`);
  app.exit(1);
});
process.on("unhandledRejection", (reason) => {
  // Not fatal on its own: log it and keep running, unlike an uncaught exception.
  hostLog.error("process.unhandledRejection", reason);
});

/** What a package's `engines` is checked against. */
const extensionVersions: ExtensionHostVersions = { tau: app.getVersion(), pi: PI_VERSION, api: EXTENSION_API_VERSION };
const hostOptions = {
  // TAU_RUNTIME_ADAPTER names the backend new threads get; a non-Pi kind needs its extension installed.
  defaultBackendKind: selectDefaultBackend(undefined, { safeMode }),
  hostExtensions: safeMode ? [] : bundledHostExtensions(),
  // A userData cache dir keeps compiled extension code out of the shared
  // system temp dir, which every local user can otherwise browse.
  hostExtensionPackages: (cwd: string) => loadHostExtensionPackages(cwd, getAgentDir(), {
    versions: extensionVersions,
    cacheDir: join(app.getPath("userData"), "host-extensions"),
  }),
  logger: hostLog,
  platform: {
    pickDirectory: async (options?: { buttonLabel?: string; message?: string; createDirectory?: boolean }) => {
      const result = await dialog.showOpenDialog(mainWindow!, {
        ...(options?.buttonLabel ? { buttonLabel: options.buttonLabel } : {}),
        ...(options?.message ? { message: options.message } : {}),
        properties: ["openDirectory", ...(options?.createDirectory ? ["createDirectory" as const] : [])],
      });
      return result.filePaths[0];
    },
  },
};

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

let mainWindow: BrowserWindow | undefined;
let host: PiHost | undefined;
let hostReady: Promise<unknown> | undefined;
let projectHistory: ProjectHistory;
let shutdownStarted = false;
let shutdownComplete = false;
/** One build at a time; a second request joins the running one. */
let rebuild: Promise<unknown> | undefined;
/** Tracks repeated renderer crashes so a second one within the window gives up on reloading. */
let lastRenderProcessGoneAt: number | undefined;

const primaryInstance = installSingleInstance(app, () => mainWindow);

function publish(event: HostEvent): void {
  // Mirrored to the log file so nothing is lost once the window is gone.
  if (event.type === "event-log") hostLog.info(event.label, event.detail);
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
    icon: appIconPath,
    webPreferences: {
      preload: join(currentDir, "../preload/bundle.cjs"),
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
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    hostLog.error("renderer.render-process-gone", details);
    const now = Date.now();
    const repeatedFailure = lastRenderProcessGoneAt !== undefined && now - lastRenderProcessGoneAt < 30_000;
    lastRenderProcessGoneAt = now;
    if (repeatedFailure) {
      dialog.showErrorBox("Tau's window keeps crashing", `Details were written to:\n${hostLog.filePath}`);
      return;
    }
    mainWindow?.webContents.reload();
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

/**
 * A host that cannot start (a misconfigured backend, say) says so instead of
 * leaving `hostReady` rejected forever with every IPC call failing silently.
 * The `.catch()` here also keeps this promise itself from ever looking like
 * an unhandled rejection.
 */
function watchHostStart<T>(ready: Promise<T>): Promise<T> {
  ready.catch((error: unknown) => {
    hostLog.error("host.start.failed", error);
    const detail = error instanceof Error ? error.message : String(error);
    const choice = dialog.showMessageBoxSync({
      type: "error",
      buttons: ["Relaunch Tau", "Quit"],
      defaultId: 0,
      message: "Tau could not start its runtime",
      detail: `${detail}\n\nDetails were written to:\n${hostLog.filePath}`,
    });
    if (choice === 0) app.relaunch();
    app.exit(1);
  });
  return ready;
}

function installIpc(): void {
  ipcMain.handle("tau:bootstrap", async () => {
    if (!host) {
      host = new PiHost(defaultWorkspace, publish, projectHistory, safeMode, true, hostOptions);
      host.onWindowTitle = (title) => { if (!mainWindow?.isDestroyed()) mainWindow?.setTitle(title); };
      hostReady = watchHostStart(host.start());
      return hostReady;
    }
    await hostReady;
    return host.bootstrap();
  });
  ipcMain.handle("tau:transcript-page", async (_event, sessionId: string, cursor?: HostTranscriptCursor) => (await requireHostReady()).loadTranscript(sessionId, cursor));
  ipcMain.handle("tau:prepare-prompt", async (_event, text: string, sessionId?: string, skill?: import("../shared/contracts.js").UiSkillDraft) => (await requireHostReady()).preparePrompt(text, sessionId, skill));
  ipcMain.handle("tau:prompt", async (_event, text: string, attachments?: UiPromptAttachment[], sessionId?: string, clientMessageIdOrIdentity?: string | ClientTurnIdentity, prepared?: import("../shared/contracts.js").PreparedPrompt) => (await requireHostReady()).prompt(text, attachments, sessionId, clientMessageIdOrIdentity, prepared));
  ipcMain.handle("tau:run-shell-action", async (_event, command: string, includeInContext?: boolean, expectedCwd?: string) => (await requireHostReady()).runShellAction(command, includeInContext, expectedCwd));
  ipcMain.handle("tau:steer", async (_event, text: string, attachments?: UiPromptAttachment[], sessionId?: string, clientMessageIdOrIdentity?: string | ClientTurnIdentity, prepared?: import("../shared/contracts.js").PreparedPrompt) => (await requireHostReady()).steer(text, attachments, sessionId, clientMessageIdOrIdentity, prepared));
  ipcMain.handle("tau:follow-up", async (_event, text: string, attachments?: UiPromptAttachment[], sessionId?: string, clientMessageIdOrIdentity?: string | ClientTurnIdentity, prepared?: import("../shared/contracts.js").PreparedPrompt) => (await requireHostReady()).followUp(text, attachments, sessionId, clientMessageIdOrIdentity, prepared));
  // Stopping must not queue behind host readiness: a thread stuck on a question
  // is exactly what the user is trying to get out of.
  ipcMain.handle("tau:abort", async (_event, sessionId?: string) => host?.abort(sessionId));
  ipcMain.handle("tau:new-session", async (_event, initialPrompt?: string, attachments?: UiPromptAttachment[], cwd?: string, clientMessageIdOrRequestId?: string | ClientTurnIdentity, prepared?: import("../shared/contracts.js").PreparedPrompt) =>
    (await requireHostReady()).newSession(initialPrompt, attachments, cwd, clientMessageIdOrRequestId, prepared));
  ipcMain.handle("tau:prepared-thread-capability", async (_event, cwd?: string) =>
    (await requireHostReady()).getPreparedThreadCapability(cwd));
  ipcMain.handle("tau:fork-thread", async (_event, entryId: string, expectedSessionId?: string) => (await requireHostReady()).forkThread(entryId, expectedSessionId));
  ipcMain.handle("tau:thread-tree", async (_event, sessionId?: string) => (await requireHostReady()).threadTree(sessionId));
  ipcMain.handle("tau:navigate-thread-tree", async (_event, entryId: string, options?: { summarize?: boolean }, expectedSessionId?: string) => (await requireHostReady()).navigateThreadTree(entryId, options, expectedSessionId));
  ipcMain.handle("tau:duplicate-thread", async (_event, expectedSessionId?: string) => (await requireHostReady()).duplicateThread(expectedSessionId));
  ipcMain.handle("tau:switch-session", async (_event, path: string) => (await requireHostReady()).switchSession(path));
  ipcMain.handle("tau:set-model", async (_event, provider: string, id: string) => (await requireHostReady()).setModel(provider, id));
  ipcMain.handle("tau:set-thinking", async (_event, level: string) => (await requireHostReady()).setThinkingLevel(level));
  ipcMain.handle("tau:compact-context", async () => (await requireHostReady()).compactContext());
  ipcMain.handle("tau:reload-runtime", async () => (await requireHostReady()).reloadRuntime());
  // Answering must never wait for a ready host: the host is blocked on this very
  // question, so requiring readiness here would deadlock startup.
  ipcMain.handle("tau:answer-extension-ui", (_event, id: string, answer: ExtensionUiAnswer) => host?.answerExtensionUi(id, answer));
  ipcMain.handle("tau:sync-extension-ui", () => host?.replayOpenUiPrompts());
  ipcMain.handle("tau:recover-thread", async () => (await requireHostReady()).recoverThread());
  ipcMain.handle("tau:rename-thread", async (_event, title: string, expectedSessionId?: string) => (await requireHostReady()).renameThread(title, expectedSessionId));
  ipcMain.handle("tau:copy-text", (_event, text: string) => clipboard.writeText(text));
  ipcMain.handle("tau:copy-image", (_event, dataUrl: unknown) => {
    const image = nativeImage.createFromDataURL(validateImageDataUrl(dataUrl));
    if (image.isEmpty()) throw new Error("Invalid image data.");
    clipboard.writeImage(image);
  });
  ipcMain.handle("tau:read-tool-output", async (_event, sessionId: string, toolCallId: string) => (await requireHostReady()).readToolOutput(sessionId, toolCallId));
  ipcMain.handle("tau:copy-thread-markdown", async (_event, expectedSessionId?: string) => {
    clipboard.writeText(await (await requireHostReady()).exportThreadMarkdown(expectedSessionId));
  });
  ipcMain.handle("tau:read-image-preview", async (_event, path: string) => rendererImagePreview(path));
  // Host extensions reach the renderer through this single channel; core does
  // not grow an IPC entry per feature.
  ipcMain.handle("tau:host-extension", async (_event, extensionId: string, command: string, input?: unknown) =>
    (await requireHostReady()).invokeHostExtension(extensionId, command, input));
  ipcMain.handle("tau:host-extensions", async () => (await requireHostReady()).listHostExtensions());
  ipcMain.handle("tau:inspect-extensions", async (_event, cwd: string) => inspectExtensionPackages(cwd, getAgentDir(), { versions: extensionVersions }));
  ipcMain.handle("tau:host-extension-active", async (_event, id: string, active: boolean) => (await requireHostReady()).setHostExtensionActive(id, active));
  ipcMain.handle("tau:prepare-workbench-reload", async (_event, mode: import("../shared/contracts.js").WorkbenchReloadMode) =>
    (await requireHostReady()).prepareWorkbenchReload(mode));
  ipcMain.handle("tau:release-workbench-reload", async () => (await requireHostReady()).releaseWorkbenchReload());
  ipcMain.handle("tau:desktop-extensions", async (_event, cwd: string, sharedExports: Record<string, string[]>) =>
    loadDesktopExtensions(cwd, getAgentDir(), { sharedExports, versions: extensionVersions }));
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
  ipcMain.handle("tau:open-project", async (_event, path: string) => (await requireHostReady()).setWorkspace(path));
  ipcMain.handle("tau:remove-project", async (_event, path: string) => (await requireHostReady()).removeProject(path));
}

if (primaryInstance) app.whenReady().then(async () => {
  hostLog.info("app.ready", {
    tauVersion: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    pid: process.pid,
    userData: app.getPath("userData"),
  });
  app.dock?.setIcon(appIconPath);
  projectHistory = new ProjectHistory(join(app.getPath("userData"), "projects.json"));
  // The host and every tool it spawns (Pi's tools, runtimes, editors) see the
  // login shell's PATH, not the one a Dock launch inherits.
  const [shellEnvironment] = await Promise.all([
    installShellEnvironment().catch((error: unknown) => { hostLog.warn("shell-environment.failed", error); return undefined; }),
    projectHistory.load(),
  ]);
  if (shellEnvironment?.installed.length) console.log(`shell environment: ${shellEnvironment.installed.join(", ")} from ${shellEnvironment.pathSource}`);
  // Prepare the host before creating the renderer so bootstrap is a read of
  // already-started work, not the first expensive lifecycle operation.
  host = new PiHost(defaultWorkspace, publish, projectHistory, safeMode, true, hostOptions);
  hostReady = watchHostStart(host.start());
  installIpc();
  await createWindow();
});

if (primaryInstance) app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

if (primaryInstance) app.on("child-process-gone", (_event, details) => {
  hostLog.error("app.child-process-gone", details);
});

if (primaryInstance) app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

if (primaryInstance) app.on("before-quit", (event) => {
  if (!host || shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  void host.dispose()
    .catch((error) => hostLog.error("host.shutdown.failed", error))
    .finally(() => {
      shutdownComplete = true;
      app.quit();
    });
});
