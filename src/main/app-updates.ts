import { dialog } from "electron";
import { DEFAULT_UPDATE_CHANNEL, defaultUpdateChannel, isNightlyVersion, type UpdateChannel } from "../shared/app-version.js";
import { NIGHTLY_TAG, UNPACKED_UPDATES, type LinuxInstall, type UpdateFeed, type UpdateLog } from "./release-feed.js";

// Moved to release-feed.ts, which the host process can load without Electron.
export { DEB_EXECUTABLE, DEB_PACKAGE, NIGHTLY_TAG, UNPACKED_UPDATES, linuxInstall, readUpdateFeed, type LinuxInstall, type UpdateFeed, type UpdateLog } from "./release-feed.js";

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
  on(event: "update-available" | "update-not-available" | "update-downloaded", listener: (info: UpdateInfo) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

/** What electron-updater reports about a release; `releaseNotes` is the release's body, or one per version. */
export interface UpdateInfo {
  version: string;
  releaseNotes?: unknown;
}

export type UpdateFeedOptions =
  | { provider: "github"; owner: string; repo: string }
  | { provider: "generic"; url: string };

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

export interface AppUpdatesOptions {
  updater: DesktopUpdater;
  /**
   * Off outside an installed Tau. A checkout is what someone is working on;
   * replacing it from a release would be the wrong thing every time.
   */
  enabled: boolean;
  /** Why this installed Tau cannot update itself; a check the user asks for says it. */
  unsupported?: string;
  /**
   * Installs a waiting version when Tau quits (default). Off where installing
   * asks for a password, so the prompt only follows the Restart the user chose.
   */
  installOnQuit?: boolean;
  log: UpdateLog;
  /** Announces a version waiting on disk, so the workbench can offer a restart. */
  onDownloaded(version: string, info: UpdateInfo): void;
  /** Answers a check the user asked for; the default is a message box. */
  tell?(message: string): void;
  /** How long after start the first check waits, so it never races bootstrap. */
  startupDelayMs?: number;
  /** How long between the checks after the first; a Tau left open for days still hears of a release. */
  pollIntervalMs?: number;
  /** The version running now; a nightly one may go back to the older stable release. */
  currentVersion?: string;
  /** The feed the build names; without it only the feed in `app-update.yml` is used, whatever the channel. */
  feed?: UpdateFeed;
  /** `updates.channel` as the config holds it now, read before every check; unset follows the running build. */
  channel?(): Promise<UpdateChannel | undefined>;
  /** False where nobody sees the window (a test instance, an invisible display): the host installs there. */
  interactive?: boolean;
}

export interface AppUpdates {
  /** Schedules the checks an installed Tau makes on its own: one soon after start, then one every poll interval. */
  start(): void;
  /** Ends the checks `start` scheduled. */
  stop(): void;
  /** The check behind "Check for updates…"; every outcome is reported. */
  checkForUpdates(): Promise<void>;
  /** Quits and installs what was downloaded. False when nothing is waiting. */
  install(): boolean;
  /** The version on disk, if a download finished. */
  downloaded(): string | undefined;
  /** Re-reads the channel after a config change and checks at once when it moved. */
  channelChanged(): Promise<void>;
  /** Whether this window installs its machine's updates: an installed Tau a person sees. */
  installs(): boolean;
  /** Installs now when downloaded; otherwise checks, and installs once the download is done (K103). */
  installWhenReady(): { started: boolean; reason?: string };
}

const DEFAULT_STARTUP_DELAY_MS = 8_000;
const DEFAULT_POLL_INTERVAL_MS = 60 * 60_000;

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
  /** Set once the user chose to install; a failure then is theirs to hear about. */
  let installing = false;
  /** The failure the event listener already handled; `checkForUpdates` rejects with it too. */
  let handled: unknown;
  /** The host asked for an install; the download finishing is the moment. */
  let installOnDownload = false;

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
    onDownloaded(info.version, info);
    if (installOnDownload) {
      installOnDownload = false;
      log.info("update.installing", ready);
      installing = true;
      updater.quitAndInstall();
    }
  });
  updater.on("error", (error) => {
    handled = error;
    log.warn("update.failed", error);
    if (installing) tell(installFailure(ready, error));
    else if (asked) tell(`The update check failed: ${reason(error)}`);
    installing = false;
    asked = false;
  });

  // Installing is the user's call, but a Tau that is quit anyway may as well
  // come back updated.
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = options.installOnQuit ?? true;

  let applied: UpdateChannel | undefined;
  async function applyChannel(): Promise<UpdateChannel> {
    const fallback = defaultUpdateChannel(options.currentVersion);
    const wanted = (await (options.channel?.() ?? Promise.resolve(undefined)).catch(() => undefined)) ?? fallback;
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

  let checking: Promise<void> | undefined;
  function check(): Promise<void> {
    checking ??= (async () => {
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
    })().finally(() => { checking = undefined; });
    return checking;
  }

  let first: ReturnType<typeof setTimeout> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  /** A poll skips while a version waits on disk; the next one follows the channel as it is then. */
  const poll = () => { if (!ready) void check(); };

  return {
    start() {
      if (!enabled || options.unsupported) {
        log.info("update.disabled", options.unsupported ?? "Not an installed Tau.");
        return;
      }
      if (interval) return;
      first = setTimeout(poll, options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS);
      interval = setInterval(poll, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    },
    stop() {
      clearTimeout(first);
      clearInterval(interval);
      interval = undefined;
    },
    async checkForUpdates() {
      if (options.unsupported) {
        tell(options.unsupported);
        return;
      }
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
      installing = true;
      updater.quitAndInstall();
      return true;
    },
    downloaded: () => ready,
    installs: () => enabled && !options.unsupported && options.interactive !== false,
    installWhenReady() {
      if (!enabled || options.unsupported || options.interactive === false) return { started: false, reason: options.unsupported ?? "This window does not install updates." };
      if (ready) {
        log.info("update.installing", ready);
        installing = true;
        updater.quitAndInstall();
        return { started: true };
      }
      installOnDownload = true;
      void check();
      return { started: false, reason: "The Tau window on this machine downloads it and installs it then." };
    },
    async channelChanged() {
      if (!enabled || options.unsupported || applied === undefined || ready) return;
      const before = applied;
      if ((await applyChannel()) !== before) await check();
    },
  };
}

/** electron-updater runs pkexec for a package; 126 is its dialog closed. */
function installFailure(version: string | undefined, error: unknown): string {
  const name = version ? `Tau ${version}` : "The update";
  if (/exited with code 126\b/u.test(reason(error))) return `${name} was not installed: the password dialog was closed. Restart again to install it.`;
  return `${name} was not installed: ${reason(error)}`;
}

/** The updater classes of electron-updater a Linux Tau picks between. */
export interface LinuxUpdaters {
  AppImageUpdater: new () => DesktopUpdater;
  DebUpdater: new () => DesktopUpdater;
}

/**
 * The updater of a Linux install and how it installs. A .deb installs with
 * `dpkg -i` through pkexec's password dialog (electron-updater's DebUpdater),
 * so it does so on Restart only, never on quit.
 */
export function linuxUpdates(updaters: LinuxUpdaters, install: LinuxInstall): Pick<AppUpdatesOptions, "installOnQuit" | "unsupported"> & { updater?: DesktopUpdater } {
  if (install === "appimage") return { updater: new updaters.AppImageUpdater() };
  if (install === "deb") return { updater: new updaters.DebUpdater(), installOnQuit: false };
  return { unsupported: UNPACKED_UPDATES };
}
