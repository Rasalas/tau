import { Menu, MenuItem, dialog } from "electron";
import { DEFAULT_UPDATE_CHANNEL, isNightlyVersion, type UpdateChannel } from "../shared/app-version.js";

/**
 * The part of electron-updater's `autoUpdater` Tau uses. Naming it here keeps
 * the policy below testable without an updater, a feed or a packaged app.
 */
export interface DesktopUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  setFeedURL(options: UpdateFeedOptions): void;
  on(event: "update-available" | "update-not-available" | "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

/** The repository `publish:` in electron-builder.yml names; the build writes it to `app-update.yml`. */
export interface UpdateFeed {
  owner: string;
  repo: string;
}

export type UpdateFeedOptions =
  | { provider: "github"; owner: string; repo: string }
  | { provider: "generic"; url: string };

/** The tag the release workflow moves to every nightly build. */
export const NIGHTLY_TAG = "nightly";

/**
 * Where each channel reads its feed. Stable is the GitHub provider, which asks
 * for the latest release and so never sees a prerelease. Nightly is one fixed
 * tag that moves, which the GitHub provider cannot follow (it wants a semver
 * tag per build), so it reads that tag's `latest*.yml` as a plain URL.
 */
export function feedFor(channel: UpdateChannel, feed: UpdateFeed): UpdateFeedOptions {
  return channel === "nightly"
    ? { provider: "generic", url: `https://github.com/${feed.owner}/${feed.repo}/releases/download/${NIGHTLY_TAG}` }
    : { provider: "github", owner: feed.owner, repo: feed.repo };
}

/** The GitHub feed in an installed app's `app-update.yml`, or undefined for any other provider. */
export function readUpdateFeed(text: string): UpdateFeed | undefined {
  const value = (key: string) => new RegExp(`^${key}:\\s*['"]?([^'"\\s#]+)`, "mu").exec(text)?.[1];
  if (value("provider") !== "github") return undefined;
  const owner = value("owner");
  const repo = value("repo");
  return owner && repo ? { owner, repo } : undefined;
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
  /** The version running now; a nightly one may go back to the older stable release. */
  currentVersion?: string;
  /** The feed the build names; without it only the feed in `app-update.yml` is used, whatever the channel. */
  feed?: UpdateFeed;
  /** `updates.channel` as the config holds it now; read before every check. */
  channel?(): Promise<UpdateChannel>;
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
  /** Re-reads the channel after a config change and checks at once when it moved. */
  channelChanged(): Promise<void>;
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

  let applied: UpdateChannel | undefined;
  async function applyChannel(): Promise<UpdateChannel> {
    const wanted = await (options.channel?.() ?? Promise.resolve(DEFAULT_UPDATE_CHANNEL)).catch(() => DEFAULT_UPDATE_CHANNEL);
    const channel = wanted === "nightly" && !options.feed ? DEFAULT_UPDATE_CHANNEL : wanted;
    if (channel === applied) return channel;
    if (wanted !== channel) log.warn("update.channel.unavailable", "No GitHub feed in this build; staying on stable.");
    // The first stable check keeps the feed the build wrote; only a switch needs a new one.
    if (options.feed && (applied !== undefined || channel !== "stable")) updater.setFeedURL(feedFor(channel, options.feed));
    updater.allowPrerelease = channel === "nightly";
    // Leaving nightly means going back to the last stable release, which is older.
    updater.allowDowngrade = channel === "stable" && isNightlyVersion(options.currentVersion ?? "");
    applied = channel;
    log.info("update.channel", channel);
    return channel;
  }

  async function check(): Promise<void> {
    try {
      await applyChannel();
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
    async channelChanged() {
      if (!enabled || applied === undefined || ready) return;
      const before = applied;
      if ((await applyChannel()) !== before) await check();
    },
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
