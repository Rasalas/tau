import { Menu, MenuItem, dialog } from "electron";

/**
 * The part of electron-updater's `autoUpdater` Tau uses. Naming it here keeps
 * the policy below testable without an updater, a feed or a packaged app.
 */
export interface DesktopUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: "update-available" | "update-not-available" | "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdateLog {
  info(label: string, detail?: unknown): void;
  warn(label: string, detail?: unknown): void;
  error(label: string, detail?: unknown): void;
}

export interface AppUpdatesOptions {
  updater: DesktopUpdater;
  /**
   * Off outside an installed Tau. A checkout is what someone is working on;
   * replacing it from a release would be the wrong thing every time.
   */
  enabled: boolean;
  log: UpdateLog;
  /** Announces a version waiting on disk, so the workbench can offer a restart. */
  onDownloaded(version: string): void;
  /** Answers a check the user asked for; the default is a message box. */
  tell?(message: string): void;
  /** How long after start the first check waits, so it never races bootstrap. */
  startupDelayMs?: number;
}

export interface AppUpdates {
  /** Schedules the one check an installed Tau makes on its own. */
  checkOnStartup(): void;
  /** The check behind "Check for updates…"; every outcome is reported. */
  checkForUpdates(): Promise<void>;
  /** Quits and installs what was downloaded. False when nothing is waiting. */
  install(): boolean;
  /** The version on disk, if a download finished. */
  downloaded(): string | undefined;
}

const DEFAULT_STARTUP_DELAY_MS = 8_000;

/** An update feed answers a failure with headers and a body; the reason is the first line. */
function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n", 1)[0]?.trim() || "unknown error";
}

export function createAppUpdates(options: AppUpdatesOptions): AppUpdates {
  const { updater, enabled, log, onDownloaded } = options;
  const tell = options.tell ?? ((message: string) => { void dialog.showMessageBox({ message: "Software update", detail: message, buttons: ["OK"] }); });
  let ready: string | undefined;
  /** Set while a check the user asked for is in flight, so only that one reports. */
  let asked = false;
  /** The failure the event listener already handled; `checkForUpdates` rejects with it too. */
  let handled: unknown;

  updater.on("update-available", (info) => {
    log.info("update.available", info.version);
    if (asked) tell(`Tau ${info.version} is downloading. You will be told when it is ready.`);
    asked = false;
  });
  updater.on("update-not-available", () => {
    log.info("update.none");
    if (asked) tell("Tau is up to date.");
    asked = false;
  });
  updater.on("update-downloaded", (info) => {
    ready = info.version;
    log.info("update.downloaded", info.version);
    onDownloaded(info.version);
  });
  updater.on("error", (error) => {
    handled = error;
    log.warn("update.failed", error);
    if (asked) tell(`The update check failed: ${reason(error)}`);
    asked = false;
  });

  // Installing is the user's call, but a Tau that is quit anyway may as well
  // come back updated.
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  async function check(): Promise<void> {
    try {
      await updater.checkForUpdates();
    } catch (error) {
      // A failed check arrives twice, as the `error` event and as this
      // rejection. Only the copy the listener never saw is worth a second line.
      if (error === handled) return;
      log.warn("update.check.failed", error);
      if (asked) tell(`The update check failed: ${reason(error)}`);
      asked = false;
    }
  }

  return {
    checkOnStartup() {
      if (!enabled) {
        log.info("update.disabled", "Not an installed Tau.");
        return;
      }
      setTimeout(() => void check(), options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS);
    },
    async checkForUpdates() {
      if (!enabled) {
        tell("This Tau runs from a checkout, so it updates with `git pull` and `npm run build`.");
        return;
      }
      if (ready) {
        tell(`Tau ${ready} is ready. Restart to install it.`);
        return;
      }
      asked = true;
      await check();
    },
    install() {
      if (!ready) return false;
      log.info("update.installing", ready);
      updater.quitAndInstall();
      return true;
    },
    downloaded: () => ready,
  };
}

/**
 * Adds "Check for updates…" to the menu Electron builds by default: beside
 * "About Tau" on macOS, at the end of Help everywhere else.
 */
export function installUpdateMenuItem(run: () => void, platform: string = process.platform): void {
  const menu = Menu.getApplicationMenu();
  const submenu = (platform === "darwin" ? menu?.items[0] : menu?.items.at(-1))?.submenu;
  if (!menu || !submenu) return;
  const item = new MenuItem({ label: "Check for updates…", click: () => run() });
  if (platform === "darwin") submenu.insert(1, item);
  else submenu.append(item);
  Menu.setApplicationMenu(menu);
}
