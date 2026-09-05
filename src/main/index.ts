import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, session, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostBootstrap, HostEvent, WorkbenchBuildResult } from "../shared/contracts.js";
import { PiHost } from "./pi-host.js";
import { selectDefaultBackend } from "./runtime-adapters.js";
import { ProjectHistory } from "./project-history.js";
import { readBoundedImagePreview } from "./image-preview.js";
import { validateImageDataUrl } from "./image-clipboard.js";
import { loadDesktopExtensions } from "./desktop-extensions.js";
import { DesktopBundleStore, registerDesktopBundleScheme, serveDesktopBundles } from "./extension-bundle-server.js";
import { rebuildWorkbench } from "./workbench-build.js";
import { bundledHostExtensions } from "./extensions/index.js";
import { getAgentDir, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { inspectExtensionPackages, loadHostExtensionPackages } from "./extension-packages.js";
import { installShellEnvironment } from "./shell-environment.js";
import { configureAppIdentity, installSingleInstance } from "./single-instance.js";
import { EXTENSION_API_VERSION, type ExtensionHostVersions } from "../shared/extension-compat.js";
import { HostLog } from "./host-log.js";
import { HostPushLog } from "./host-push-log.js";
import { HostJobRunner } from "./host-jobs.js";
import { createHostMethods, createUnsupportedHostMethods, type HostMethodTable } from "./host-methods.js";
import { installElectronHostTransport, type ElectronHostTransport } from "./host-transport-electron.js";
import { startSocketHostTransport, type SocketHostTransport } from "./host-transport-socket.js";
import { clientHostToken, readOrCreateHostToken } from "./host-token.js";
import { HOST_CAPABILITY, type HostPushEvent } from "../shared/host-transport.js";
import { WorkspaceIdentity, readOrCreateHostId } from "./workspace-identity.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const appIconPath = join(app.getAppPath(), "assets/tau-icon.png");
const defaultWorkspace = process.env.TAU_WORKSPACE || process.cwd();
const safeMode = process.env.TAU_NO_EXTENSIONS === "1";
/**
 * `TAU_HOST_URL=ws://machine:7788` turns this process into a client: the window
 * speaks the protocol over that socket and nothing local starts. The renderer
 * takes the same URL through `?host=`, which it already understands.
 */
const remoteHostUrl = process.env.TAU_HOST_URL;

// Identity (and so userData) must be set before anything reads app.getPath("userData").
configureAppIdentity(app, process.env.TAU_USER_DATA);
// Both must happen before the app is ready: a privileged scheme cannot be added later.
const desktopBundles = new DesktopBundleStore();
registerDesktopBundleScheme();
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
// Clients name workspaces by an id of this host, never by one of its paths.
const workspaceIdentity = new WorkspaceIdentity(readOrCreateHostId(join(app.getPath("userData"), "host-id")));
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
  workspaceIdentity,
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
let transport: ElectronHostTransport | undefined;
let socketTransport: SocketHostTransport | undefined;
const pushLog = new HostPushLog();
const jobs = new HostJobRunner(broadcast);
let host: PiHost | undefined;
let hostReady: Promise<unknown> | undefined;
let projectHistory: ProjectHistory;
let shutdownStarted = false;
let shutdownComplete = false;
/** One build at a time; a second request joins the running one. */
let rebuild: Promise<WorkbenchBuildResult> | undefined;
/** Tracks repeated renderer crashes so a second one within the window gives up on reloading. */
let lastRenderProcessGoneAt: number | undefined;

const primaryInstance = installSingleInstance(app, () => mainWindow);

function publish(event: HostEvent): void {
  // Mirrored to the log file so nothing is lost once the window is gone.
  if (event.type === "event-log") hostLog.info(event.label, event.detail);
  broadcast(event);
}

/** One sequence for every transport, so a replay is the same list everywhere. */
function broadcast(event: HostPushEvent): void {
  const push = pushLog.record(event);
  transport?.deliver(push);
  socketTransport?.deliver(push);
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
      // The preload bundle uses only contextBridge and ipcRenderer, both of
      // which survive the sandbox; nothing in the renderer needs Node.
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      nodeIntegrationInSubFrames: false,
      spellcheck: false,
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

  // The token travels in the window's own query string, never on a command line.
  const remoteToken = remoteHostUrl ? clientHostToken() : undefined;
  const query: Record<string, string> = {
    ...(safeMode ? { safeMode: "1" } : {}),
    ...(remoteHostUrl ? { host: remoteHostUrl } : {}),
    ...(remoteToken ? { token: remoteToken } : {}),
  };
  if (process.env.TAU_DEV_SERVER_URL) {
    const url = new URL(process.env.TAU_DEV_SERVER_URL);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    await mainWindow.loadURL(url.toString());
  } else {
    await mainWindow.loadFile(join(currentDir, "../../dist/index.html"), { query });
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

/** Everything this machine can answer for itself; a client of a remote host has none of it. */
function createLocalHostMethods(): HostMethodTable {
  return createHostMethods({
    bootstrap: async () => {
      if (!host) {
        host = new PiHost(defaultWorkspace, publish, projectHistory, safeMode, true, hostOptions);
        host.onWindowTitle = (title) => { if (!mainWindow?.isDestroyed()) mainWindow?.setTitle(title); };
        hostReady = watchHostStart(host.start());
        return hostReady as Promise<HostBootstrap>;
      }
      await hostReady;
      return host.bootstrap();
    },
    requireHost: requireHostReady,
    host: () => host,
    jobs,
    platform: {
      copyText: (text) => clipboard.writeText(text),
      copyImage: (dataUrl) => {
        const image = nativeImage.createFromDataURL(validateImageDataUrl(dataUrl));
        if (image.isEmpty()) throw new Error("Invalid image data.");
        clipboard.writeImage(image);
      },
      readImagePreview: rendererImagePreview,
      inspectExtensions: async (cwd) => inspectExtensionPackages(cwd, getAgentDir(), { versions: extensionVersions }),
      loadDesktopExtensions: async (cwd, sharedExports) => {
        const result = await loadDesktopExtensions(cwd, getAgentDir(), { sharedExports, versions: extensionVersions });
        // Each sync replaces the served set, so an edited extension never keeps its old URL alive.
        desktopBundles.clear();
        return { ...result, bundles: result.bundles.map((bundle) => ({ ...bundle, url: desktopBundles.publish(bundle.id, bundle.code) })) };
      },
      rebuildWorkbench: (context) => {
        if (rebuild) return rebuild;
        rebuild = rebuildWorkbench(app.getAppPath(), {
          onOutput: (line) => {
            context.progress(line);
            publish({ type: "event-log", label: "workbench.build", detail: line, timestamp: Date.now() });
          },
        }).finally(() => { rebuild = undefined; });
        return rebuild;
      },
      relaunchWorkbench: () => {
        app.relaunch();
        app.quit();
      },
    },
  });
}

function installTransport(): void {
  const methods = remoteHostUrl
    ? createUnsupportedHostMethods(`This window is a client of the host at ${remoteHostUrl}; local operations (clipboard, image previews, workbench rebuild) are not available here.`)
    : createLocalHostMethods();
  transport = installElectronHostTransport({
    ipcMain,
    methods,
    pushLog,
    hostVersion: app.getVersion(),
    capabilities: remoteHostUrl ? [] : [HOST_CAPABILITY.jobs, HOST_CAPABILITY.replay, HOST_CAPABILITY.localFiles],
    send: (channel, payload) => { if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send(channel, payload); },
  });
  // A second transport for a client that is not this window; off unless asked for.
  const listen = process.env.TAU_HOST_LISTEN;
  if (!listen) return;
  void startSocketHostTransport({
    listen,
    methods,
    pushLog,
    hostVersion: app.getVersion(),
    capabilities: [HOST_CAPABILITY.jobs, HOST_CAPABILITY.replay],
    token: readOrCreateHostToken(),
    allowNonLoopback: process.env.TAU_HOST_INSECURE === "1",
    logger: hostLog,
  }).then((started) => { socketTransport = started; })
    .catch((error: unknown) => hostLog.error("host-transport-socket.failed", error));
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
  serveDesktopBundles(desktopBundles);
  // Nothing in the workbench asks for a camera, a microphone or a location, and
  // an extension rendering inside it must not be able to ask on its behalf.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  projectHistory = new ProjectHistory(join(app.getPath("userData"), "projects.json"), undefined, hostLog, (path) => workspaceIdentity.ref(path));
  // The host and every tool it spawns (Pi's tools, runtimes, editors) see the
  // login shell's PATH, not the one a Dock launch inherits.
  const [shellEnvironment] = await Promise.all([
    installShellEnvironment().catch((error: unknown) => { hostLog.warn("shell-environment.failed", error); return undefined; }),
    projectHistory.load(),
  ]);
  if (shellEnvironment?.installed.length) console.log(`shell environment: ${shellEnvironment.installed.join(", ")} from ${shellEnvironment.pathSource}`);
  // Prepare the host before creating the renderer so bootstrap is a read of
  // already-started work, not the first expensive lifecycle operation.
  installTransport();
  if (!remoteHostUrl) {
    host = new PiHost(defaultWorkspace, publish, projectHistory, safeMode, true, hostOptions);
    hostReady = watchHostStart(host.start());
  }
  await createWindow();
});

if (primaryInstance) app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// `webviewTag` is off, so this only ever fires on a bug or on injected markup.
if (primaryInstance) app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
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
