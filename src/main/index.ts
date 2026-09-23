import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, Notification, session, shell } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopExtensionLoadResult as WorkbenchDesktopExtensions, HostBootstrap, HostEvent, WorkbenchBuildResult } from "../shared/contracts.js";
import { PiHost } from "./pi-host.js";
import { primeOpenCodeCatalog } from "./pi-model-runtime.js";
import { selectDefaultBackend } from "./runtime-adapters.js";
import { ProjectHistory } from "./project-history.js";
import { readBoundedImagePreview } from "./image-preview.js";
import { validateImageDataUrl } from "./image-clipboard.js";
import { loadDesktopExtensions } from "./desktop-extensions.js";
import { DesktopBundleStore, registerDesktopBundleScheme, serveDesktopBundles } from "./extension-bundle-server.js";
import { SharedFileStore } from "./shared-files.js";
import { rebuildWorkbench } from "./workbench-build.js";
import { WorkbenchReloader } from "./workbench-reloader.js";
import { ManagedWorkbenchSource } from "./managed-workbench-source.js";
import { NO_BUNDLED_KITS, inspectBundledKits, loadBundledKitDesktopHalves, loadBundledKitWindowHalves, shippedHostExtensions } from "./bundled-kits.js";
import { getAgentDir, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { inspectExtensionPackages, loadHostExtensionPackages } from "./extension-packages.js";
import { installShellEnvironment } from "./shell-environment.js";
import { configureAppIdentity, installSingleInstance } from "./single-instance.js";
import { EXTENSION_API_VERSION, type ExtensionHostVersions } from "../shared/extension-compat.js";
import { HostLog } from "./host-log.js";
import { HostPushLog } from "./host-push-log.js";
import { HostPushCoalescer } from "./host-push-coalescer.js";
import { HostJobRunner } from "./host-jobs.js";
import { createClientHostMethods, createHostMethods, createUnsupportedHostMethods, type ClientHostPlatform, type HostMethodTable } from "./host-methods.js";
import { HostClientRegistry } from "./host-clients.js";
import { installElectronHostTransport, type ElectronHostTransport } from "./host-transport-electron.js";
import { startSocketHostTransport, type SocketHostTransport } from "./host-transport-socket.js";
import { clientHostToken, readOrCreateHostToken } from "./host-token.js";
import { HOST_CAPABILITY, type HostPushEvent } from "../shared/host-transport.js";
import { WorkspaceIdentity, readOrCreateHostId } from "./workspace-identity.js";
import { resolveStartupWorkspace } from "./startup-workspace.js";
import { WindowHost } from "./window-host.js";
import { trustRemoteHost, type RemoteHostTrust } from "./remote-host-trust.js";
import { resolveHostTls } from "./host-tls.js";
import { parseListen } from "./host-listen.js";
import { WINDOW_SERVICES_ID } from "./window-extensions.js";
import { createWindowAttention, OVERLAY_BADGE_SIZE, overlayBadgeBitmap } from "./window-attention.js";
import { showWindowContextMenu } from "./window-context-menu.js";
import type { MenuPoint, NativeMenuEntry } from "../shared/context-menu.js";
import { defaultHostConfigManager } from "./host-config.js";
import electronUpdater from "electron-updater";
import { createAppUpdates, installUpdateMenuItem, readUpdateFeed, type AppUpdates } from "./app-updates.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
/** The packaged launcher sets this when it hands execution to a built checkout. */
const workbenchRoot = process.env.TAU_WORKBENCH_ROOT || app.getAppPath();
/**
 * The icon a checkout runs with, or nothing. `assets/` is electron-builder's
 * `buildResources` and stays out of the archive, so an installed Tau has no
 * such file — it wears the icon the installer baked into the bundle. Setting
 * one from a path that is not there throws, which used to take the window with
 * it: `app.dock.setIcon` runs in the same `whenReady` callback that creates it.
 */
const shippedIconPath = join(workbenchRoot, "assets/tau-icon.png");
const appIconPath = existsSync(shippedIconPath) ? shippedIconPath : undefined;
const requestedWorkspace = process.env.TAU_WORKSPACE;
const safeMode = process.env.TAU_NO_EXTENSIONS === "1";
/**
 * `TAU_HOST_URL=ws://machine:7788` points this window at a host somebody else
 * runs. Without it the window starts and supervises a host process of its own
 * (ADR 0021); either way the renderer reaches it through `?host=`.
 */
const remoteHostUrl = process.env.TAU_HOST_URL;
/** `TAU_HOST_INPROCESS=1` keeps the old shape for one release: the host in this process. */
const inProcessHost = process.env.TAU_HOST_INPROCESS === "1";

// Identity (and so userData) must be set before anything reads app.getPath("userData").
configureAppIdentity(app, process.env.TAU_USER_DATA);
// Both must happen before the app is ready: a privileged scheme cannot be added later.
const desktopBundles = new DesktopBundleStore();
const EMPTY_DESKTOP_EXTENSIONS: WorkbenchDesktopExtensions = { bundles: [], errors: [], skipped: [] };
registerDesktopBundleScheme();
const hostLog = new HostLog({ dir: join(app.getPath("userData"), "logs") });

// Every extension is compiled by esbuild, which spawns a binary that cannot
// live in the archive. `packaged-app` redirects it while it loads.
if (app.isPackaged && !process.env.ESBUILD_BINARY_PATH) {
  hostLog.warn("esbuild.binary.missing", "Nothing outside the archive to spawn; extensions cannot be compiled.");
}

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
/** Where the kits Tau ships are read from and where their compiled halves are cached. */
const kitOptions = {
  appPath: workbenchRoot,
  cacheDir: join(app.getPath("userData"), "host-extensions"),
  versions: extensionVersions,
};
/** Both transports report their clients here; the host publishes the count. */
const hostClients = new HostClientRegistry();

let lastPickedDirectory: string | undefined;
const hostOptions = {
  // TAU_RUNTIME_ADAPTER names the backend new threads get; a non-Pi kind needs its extension installed.
  defaultBackendKind: selectDefaultBackend(undefined, { safeMode }),
  hostExtensions: safeMode ? [] : shippedHostExtensions(kitOptions, (label, detail) => hostLog.warn(label, detail)),
  // A userData cache dir keeps compiled extension code out of the shared
  // system temp dir, which every local user can otherwise browse.
  hostExtensionPackages: (cwd: string) => loadHostExtensionPackages(cwd, getAgentDir(), {
    versions: extensionVersions,
    cacheDir: join(app.getPath("userData"), "host-extensions"),
  }),
  logger: hostLog,
  workspaceIdentity,
  clients: hostClients,
  // A checkout edits `kits/`; an installed Tau has only the prebuilt ones.
  appPath: workbenchRoot,
  // A kit's own state lives under this instance's userData, so TAU_USER_DATA
  // isolates a dev instance's kit state the way it isolates everything else.
  kitStateDir: join(app.getPath("userData"), "kit-state"),
  sessionUsageCachePath: join(app.getPath("userData"), "session-usage.json"),
  turnsInFlightPath: join(app.getPath("userData"), "turns-in-flight.json"),
  threadTrashDir: join(app.getPath("userData"), "thread-trash"),
  sessionLineageCachePath: join(app.getPath("userData"), "session-lineage.json"),
  platform: {
    pickDirectory: async (options?: { buttonLabel?: string; message?: string; createDirectory?: boolean }) => {
      const result = await dialog.showOpenDialog(mainWindow!, {
        // Electron 43+ opens in Downloads unless told otherwise; start where the last pick ended.
        ...(lastPickedDirectory ? { defaultPath: lastPickedDirectory } : {}),
        ...(options?.buttonLabel ? { buttonLabel: options.buttonLabel } : {}),
        ...(options?.message ? { message: options.message } : {}),
        properties: ["openDirectory", ...(options?.createDirectory ? ["createDirectory" as const] : [])],
      });
      const picked = result.filePaths[0];
      if (picked) lastPickedDirectory = dirname(picked);
      return picked;
    },
  },
};

/** The clipboard takes W3C `ClipboardItem`s since Electron 44; an image goes on it as PNG. */
async function copyImageToClipboard(dataUrl: string): Promise<void> {
  const image = nativeImage.createFromDataURL(validateImageDataUrl(dataUrl));
  if (image.isEmpty()) throw new Error("Invalid image data.");
  await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(image.toPNG())], { type: "image/png" }) })]);
}

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
/** Streamed text and tool output are merged here before they are numbered. */
const pushes = new HostPushCoalescer((event) => {
  const push = pushLog.record(event);
  transport?.deliver(push);
  socketTransport?.deliver(push);
  return push.seq;
});
const jobs = new HostJobRunner(broadcast);
let host: PiHost | undefined;
let hostReady: Promise<unknown> | undefined;
/** The host this window is a client of, when it does not run one in process. */
let windowHost: WindowHost | undefined;
/** How the window trusts the host `TAU_HOST_URL` names; unset for a supervised one. */
let remoteTrust: RemoteHostTrust | undefined;
/** Why this window will not talk to that host; the workbench shows it in place of the link state. */
let hostRefusal: string | undefined;
let workbenchLoading = false;
/** Set when the last window closed: quitting then leaves the host running. */
let quitAfterWindowClosed = false;
let projectHistory: ProjectHistory;
let updates: AppUpdates | undefined;
let shutdownStarted = false;
let shutdownComplete = false;
/** One build at a time; a second request joins the running one. */
let rebuild: Promise<WorkbenchBuildResult> | undefined;
const managedWorkbenchSource = app.isPackaged ? new ManagedWorkbenchSource({
  userData: app.getPath("userData"),
  version: app.getVersion(),
  seedDirectory: join(process.resourcesPath, "tau-source"),
  installedModulesDirectory: join(process.resourcesPath, "app.asar.unpacked", "node_modules"),
  electronTypesDirectory: join(process.resourcesPath, "tau-source-vendor", "electron"),
  typescriptDirectory: join(process.resourcesPath, "tau-source-vendor", "typescript"),
}) : undefined;
const workbenchReloader = new WorkbenchReloader({
  packaged: app.isPackaged,
  appPath: workbenchRoot,
  userData: app.getPath("userData"),
  app,
  managedSource: managedWorkbenchSource,
  rebuild: rebuildWorkbench,
});
/** Notifications and the icon badge: the renderer asks, this process draws them. */
const windowAttention = createWindowAttention({
  isSupported: () => Notification.isSupported(),
  // Silent: whoever raised it plays its own sound, or none.
  create: (notification) => new Notification({ ...notification, silent: true }),
  reveal: () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return true;
  },
  setBadgeCount: (count) => app.setBadgeCount(count),
  ...(process.platform === "win32" ? {
    setOverlayBadge: (count: number) => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      const icon = count > 0 ? nativeImage.createFromBitmap(overlayBadgeBitmap(), { width: OVERLAY_BADGE_SIZE, height: OVERLAY_BADGE_SIZE }) : null;
      mainWindow.setOverlayIcon(icon, count > 0 ? `${count} unseen` : "");
      return true;
    },
  } : {}),
  log: (label, detail) => hostLog.info(label, { ...detail as object, ...(app.dock ? { dock: app.dock.getBadge() } : {}) }),
});
/** Right-click menus the page asks for; the coordinates arrive in CSS pixels of the page. */
const windowContextMenu = (entries: NativeMenuEntry[], point: MenuPoint): Promise<string | undefined> => showWindowContextMenu({
  platform: process.platform,
  popup: (template, at, closed) => {
    if (!mainWindow || mainWindow.isDestroyed()) { closed(); return; }
    const zoom = mainWindow.webContents.getZoomFactor();
    Menu.buildFromTemplate(template).popup({ window: mainWindow, x: Math.round(at.x * zoom), y: Math.round(at.y * zoom), callback: closed });
  },
}, entries, point);
/** Workspace files the page loads by URL; only a host on this machine has files here to serve. */
const sharedFiles = new SharedFileStore(() => remoteHostUrl ? undefined : windowHost?.activeWorkspace || host?.activeWorkspacePath());
/** Tracks repeated renderer crashes so a second one within the window gives up on reloading. */
let lastRenderProcessGoneAt: number | undefined;

const primaryInstance = installSingleInstance(app, () => mainWindow, () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

function publish(event: HostEvent): void {
  // Mirrored to the log file so nothing is lost once the window is gone.
  if (event.type === "event-log") hostLog.info(event.label, event.detail);
  // Drop a deactivated extension's bundle so tau-ext: returns 404 for it rather
  // than serving code the user switched off until the next full reload.
  if (event.type === "extension-deactivated") desktopBundles.remove(event.extensionId);
  if (event.type === "config-changed") void updates?.channelChanged();
  broadcast(event);
}

/** One sequence for every transport, so a replay is the same list everywhere. */
function broadcast(event: HostPushEvent): void {
  pushes.publish(event);
}

/** What the renderer is told: which host to speak to, and as which client. */
function workbenchQuery(): Record<string, string> {
  return {
    ...(safeMode ? { safeMode: "1" } : {}),
    // Which client this window claims to be (ADR 0016). Unset is `desktop`;
    // setting it is how the desktop window shows what a smaller one leaves out.
    ...(process.env.TAU_CLIENT_PROFILE ? { profile: process.env.TAU_CLIENT_PROFILE } : {}),
    ...(windowHost ? { host: windowHost.hostUrl || remoteHostUrl || "" } : {}),
    // A refused host never gets the token, so the page does not hold it either.
    ...(hostRefusal ? { hostRefused: hostRefusal } : windowHost?.hostToken ? { token: windowHost.hostToken } : {}),
  };
}

async function createWindow(): Promise<void> {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : openWindow();
  // The token travels in the window's own query string, never on a command line.
  await loadWorkbench(window, workbenchQuery());
}

/** The window without its workbench; a remote host's trust question needs it before anything loads. */
function openWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1080,
    minHeight: 680,
    titleBarStyle: "hiddenInset",
    // Centres the native traffic lights (14pt since the macOS 26 SDK) in Tau's 52px title bar.
    trafficLightPosition: { x: 19, y: 19 },
    backgroundColor: "#11110f",
    ...(appIconPath ? { icon: appIconPath } : {}),
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
  return mainWindow;
}

async function loadWorkbench(window: BrowserWindow, query: Record<string, string>): Promise<void> {
  workbenchLoading = true;
  try {
    if (process.env.TAU_DEV_SERVER_URL) {
      const url = new URL(process.env.TAU_DEV_SERVER_URL);
      for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
      await window.loadURL(url.toString());
    } else {
      await window.loadFile(join(currentDir, "../../dist/index.html"), { query });
    }
  } finally {
    workbenchLoading = false;
  }
  // A refusal that arrived while this page loaded is shown by loading it once more.
  if (hostRefusal && query.hostRefused !== hostRefusal && !window.isDestroyed()) await loadWorkbench(window, workbenchQuery());
}

/** The window stops talking to the host and says why, in its own connection state. */
function refuseRemoteHost(message: string): void {
  if (hostRefusal) return;
  hostRefusal = message;
  if (mainWindow && !mainWindow.isDestroyed() && !workbenchLoading && mainWindow.webContents.getURL()) void pointWindowAtHost();
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

/**
 * Starts the embedded host in the requested workspace, or in the last project
 * that still exists when that folder is gone: a deleted checkout must not turn
 * into the fatal dialog `watchHostStart` shows for a broken runtime.
 */
function startLocalHost(): void {
  const startup = resolveStartupWorkspace(requestedWorkspace, projectHistory.list());
  if (startup.missing) hostLog.warn("workspace.missing", { requested: startup.missing, fallback: startup.cwd });
  // Off the critical path: the first thread's runtime finds the models.dev catalog done, later ones share it.
  primeOpenCodeCatalog();
  host = new PiHost(startup.cwd, publish, projectHistory, safeMode, true, hostOptions);
  hostReady = watchHostStart(host.start());
}

/**
 * Starts or adopts the host process this window is a client of, or attaches to
 * the one `TAU_HOST_URL` names. A host that will not start is fatal: the window
 * has nothing to show without one.
 */
async function startHostProcess(): Promise<void> {
  windowHost = new WindowHost({
    userData: app.getPath("userData"),
    version: app.getVersion(),
    mainDirectory: currentDir,
    execPath: process.execPath,
    ...(requestedWorkspace ? { workspace: requestedWorkspace } : {}),
    logger: hostLog,
    onFatal: ({ message, logPath }) => {
      dialog.showErrorBox("Tau's host stopped", `${message}\n\nDetails were written to:\n${logPath || hostLog.filePath}`);
    },
    // A restarted host may have landed on another port; the window's client
    // only learns the new one by being pointed at it again.
    onUrlChanged: () => { void pointWindowAtHost(); },
    onEvent: (event) => {
      // Drop a deactivated extension's bundle so tau-ext: returns 404 for it
      // rather than serving code the user switched off.
      if (event.type === "extension-deactivated") desktopBundles.remove(event.extensionId);
      if (event.type === "config-changed") void updates?.channelChanged();
    },
    onCertificateRefused: (error) => remoteTrust?.refuse(error.presented),
  });
  if (remoteHostUrl) {
    remoteTrust = await trustRemoteHost(remoteHostUrl, {
      userData: app.getPath("userData"),
      ...(process.env.TAU_HOST_FINGERPRINT ? { fingerprint: process.env.TAU_HOST_FINGERPRINT } : {}),
      session: session.defaultSession,
      logger: hostLog,
      parent: openWindow(),
      onRefused: refuseRemoteHost,
    });
    if (!remoteTrust) return;
    windowHost.attach(remoteHostUrl, clientHostToken(), remoteTrust.fingerprint);
    await loadWindowHalves();
    return;
  }
  try {
    const running = await windowHost.startSupervised();
    await loadWindowHalves();
    hostLog.info("host-process.ready", { pid: running.pid, url: running.url, adopted: running.adopted });
  } catch (error: unknown) {
    hostLog.error("host-process.start.failed", error);
    dialog.showErrorBox(
      "Tau could not start its host",
      `${error instanceof Error ? error.message : String(error)}\n\nDetails were written to:\n${windowHost.logFile || hostLog.filePath}`,
    );
    app.exit(1);
  }
}

/** The kits' window halves: compiled here, called by the host over the protocol. */
async function loadWindowHalves(): Promise<void> {
  if (!windowHost) return;
  // Core's own half answers even in safe mode: a host with no window has no folder picker.
  windowHost.extensions.register(WINDOW_SERVICES_ID, () => ({
    handle: (command, input) => {
      if (command !== "pick-directory") throw new Error(`The window has no service "${command}".`);
      return hostOptions.platform.pickDirectory(input as Parameters<typeof hostOptions.platform.pickDirectory>[0]);
    },
  }));
  if (safeMode) return;
  const loaded = await loadBundledKitWindowHalves(kitOptions).catch((error: unknown) => {
    hostLog.error("window-extension.load.failed", error);
    return undefined;
  });
  if (!loaded) return;
  for (const failure of loaded.errors) hostLog.warn("window-extension.kit.failed", `${failure.path}: ${failure.message}`);
  windowHost.extensions.load(loaded.halves);
}

/** Points the open window at the host's current URL; used when a restart moved it. */
async function pointWindowAtHost(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await loadWorkbench(mainWindow, workbenchQuery());
}

/** Everything this machine can answer for itself; a client of a remote host has none of it. */
function createLocalHostMethods(): HostMethodTable {
  return createHostMethods({
    bootstrap: async () => {
      if (!host) {
        startLocalHost();
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
      copyImage: copyImageToClipboard,
      readImagePreview: rendererImagePreview,
      shareFile: (path) => sharedFiles.share(path),
      // The kits Tau ships are listed beside the installed packages, marked
      // `bundled`; safe mode loads none of them and reports none.
      inspectExtensions: async (cwd) => {
        const [kits, inspection] = await Promise.all([
          safeMode ? NO_BUNDLED_KITS : inspectBundledKits(kitOptions),
          inspectExtensionPackages(cwd, getAgentDir(), { versions: extensionVersions }),
        ]);
        return {
          ...inspection,
          ...(kits.distribution ? { distribution: { name: kits.distribution.name, version: kits.distribution.version } } : {}),
          packages: [...kits.packages, ...inspection.packages],
        };
      },
      loadDesktopExtensions: async (cwd, sharedExports, only) => {
        // The kits Tau ships travel the same road as an installed package's
        // desktop half; only their origin differs. Safe mode loads neither.
        const [kits, result] = await Promise.all([
          safeMode ? EMPTY_DESKTOP_EXTENSIONS : loadBundledKitDesktopHalves({ ...kitOptions, sharedExports, ...(only ? { only } : {}) }),
          loadDesktopExtensions(cwd, getAgentDir(), { sharedExports, versions: extensionVersions, ...(only ? { only } : {}) }),
        ]);
        return serveBundles({
          bundles: [...kits.bundles, ...result.bundles],
          errors: [...kits.errors, ...result.errors],
          skipped: result.skipped,
        }, only);
      },
      rebuildWorkbench: async (context, activeWorkspace) => runRebuild(context, activeWorkspace),
      workbenchSource: async () => managedWorkbenchSource ? managedWorkbenchSource.ensure() : workbenchRoot,
      relaunchWorkbench: () => workbenchReloader.relaunch(),
      installUpdate: () => updates?.install() ?? false,
      notify: windowAttention.notify,
      setBadge: windowAttention.setBadge,
      showContextMenu: windowContextMenu,
    },
  });
}

/** Turns the code the host compiled into the `tau-ext:` URLs the renderer imports. */
function serveBundles(result: WorkbenchDesktopExtensions, only?: readonly string[]): WorkbenchDesktopExtensions {
  // Each sync replaces the served set, so an edited extension never keeps its
  // old URL alive. A narrowed sync drops only what it rebuilds: the modules the
  // client keeps still have to be reachable.
  if (only) for (const id of only) desktopBundles.remove(id);
  else desktopBundles.clear();
  return {
    ...result,
    bundles: result.bundles.map((bundle) => ({
      ...bundle,
      url: desktopBundles.publish(bundle.id, bundle.code),
      ...(bundle.styles ? { stylesUrl: desktopBundles.publishStyles(bundle.id, bundle.styles) } : {}),
    })),
  };
}

/** What this machine answers for itself while the host answers for the threads. */
function createWindowPlatform(): ClientHostPlatform {
  return {
    copyText: (text) => clipboard.writeText(text),
    copyImage: copyImageToClipboard,
    readImagePreview: rendererImagePreview,
    shareFile: (path) => sharedFiles.share(path),
    loadDesktopExtensions: async (cwd, sharedExports, only) =>
      windowHost!.loadDesktopExtensions(cwd, sharedExports, only, (result) => serveBundles(result, only)),
    rebuildWorkbench: async (context) => runRebuild(context, windowHost?.activeWorkspace ?? requestedWorkspace ?? ""),
    workbenchSource: async () => managedWorkbenchSource ? managedWorkbenchSource.ensure() : workbenchRoot,
    relaunchWorkbench: () => workbenchReloader.relaunch(),
    installUpdate: () => updates?.install() ?? false,
    notify: windowAttention.notify,
    setBadge: windowAttention.setBadge,
    showContextMenu: windowContextMenu,
  };
}

/** One build at a time, wherever the request came from. */
function runRebuild(context: { progress(line: string): void }, activeWorkspace: string): Promise<WorkbenchBuildResult> {
  if (rebuild) return rebuild;
  rebuild = workbenchReloader.rebuild(activeWorkspace, {
    onOutput: (line) => {
      context.progress(line);
      publish({ type: "event-log", label: "workbench.build", detail: line, timestamp: Date.now() });
    },
  }).finally(() => { rebuild = undefined; });
  return rebuild;
}

function installTransport(): void {
  // A window whose host lives elsewhere answers only for its own machine; the
  // host's own methods would have nothing here to answer with.
  const methods = windowHost
    ? {
      ...createUnsupportedHostMethods(`This window is a client of the host at ${windowHost.hostUrl}; only its own machine answers here.`),
      ...createClientHostMethods(createWindowPlatform()),
    }
    : createLocalHostMethods();
  transport = installElectronHostTransport({
    ipcMain,
    workbenchContents: () => mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined,
    clients: hostClients,
    logger: hostLog,
    methods,
    pushLog,
    beforeReply: () => pushes.flush(),
    onSnapshotClient: () => pushes.resendWholeOutputs(),
    hostVersion: app.getVersion(),
    capabilities: windowHost ? [HOST_CAPABILITY.localFiles] : [HOST_CAPABILITY.jobs, HOST_CAPABILITY.replay, HOST_CAPABILITY.localFiles],
    send: (channel, payload) => { if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send(channel, payload); },
  });
  // A second transport for a client that is not this window; off unless asked for.
  const listen = process.env.TAU_HOST_LISTEN;
  if (!listen) return;
  let tls: ReturnType<typeof resolveHostTls>;
  try { tls = resolveHostTls(process.env, { userData: app.getPath("userData"), bindHost: parseListen(listen).host }); }
  catch (error: unknown) { hostLog.error("host-transport-socket.tls.failed", error); return; }
  void startSocketHostTransport({
    listen,
    methods,
    pushLog,
    beforeReply: () => pushes.flush(),
    onSnapshotClient: () => pushes.resendWholeOutputs(),
    hostVersion: app.getVersion(),
    capabilities: [HOST_CAPABILITY.jobs, HOST_CAPABILITY.replay],
    token: readOrCreateHostToken(),
    allowNonLoopback: process.env.TAU_HOST_INSECURE === "1",
    ...(tls ? { tls } : {}),
    clients: hostClients,
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
  if (appIconPath) app.dock?.setIcon(appIconPath);
  updates = createAppUpdates({
    updater: electronUpdater.autoUpdater,
    enabled: app.isPackaged,
    log: hostLog,
    onDownloaded: (version) => publish({ type: "app-update", version }),
    currentVersion: app.getVersion(),
    ...(app.isPackaged ? { feed: readUpdateFeedFile() } : {}),
    // This machine's config file: the updater belongs to the machine, not to a remote host.
    channel: async () => (await defaultHostConfigManager.read()).updates?.channel,
  });
  installUpdateMenuItem(() => void updates?.checkForUpdates());
  updates.checkOnStartup();
  serveDesktopBundles(desktopBundles, sharedFiles);
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
  if (!inProcessHost) await startHostProcess();
  installTransport();
  if (inProcessHost) startLocalHost();
  await createWindow();
});

if (primaryInstance) app.on("window-all-closed", () => {
  if (process.platform === "darwin") return;
  // The window is not the host any more: closing it leaves the threads
  // running, and the next start adopts them through host.json (ADR 0021).
  quitAfterWindowClosed = true;
  app.quit();
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

/**
 * Quitting ends the host too, unless the user asked for it to stay (Settings →
 * Defaults) or the window merely closed. A host in this process is disposed
 * the way it always was.
 */
if (primaryInstance) app.on("before-quit", (event) => {
  if (shutdownComplete || (!host && !windowHost)) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  void (async () => {
    if (host) await host.dispose().catch((error: unknown) => hostLog.error("host.shutdown.failed", error));
    if (windowHost) await windowHost.stop(quitAfterWindowClosed || await keepHostRunning());
  })()
    .catch((error: unknown) => hostLog.error("host.shutdown.failed", error))
    .finally(() => {
      shutdownComplete = true;
      app.quit();
    });
});

function readUpdateFeedFile() {
  try {
    return readUpdateFeed(readFileSync(join(process.resourcesPath, "app-update.yml"), "utf8"));
  } catch {
    return undefined;
  }
}

/** The "keep the host running" preference; read from the file, not from the host that is stopping. */
async function keepHostRunning(): Promise<boolean> {
  try {
    return (await defaultHostConfigManager.read()).hostBackground === true;
  } catch {
    return false;
  }
}
