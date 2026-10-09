import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultUpdateChannel, type UpdateChannel } from "../shared/app-version.js";
import { compareVersions } from "../shared/runtime-version.js";
import { HOST_UPDATE_METHODS, type HostUpdateInstaller, type HostUpdatePhase, type HostUpdateSettings, type HostUpdateStatus } from "../shared/host-updates.js";
import { HOST_ERROR } from "../shared/host-transport.js";
import type { HostMethodContext } from "./host-jobs.js";
import { isHostOwner } from "./host-invocation.js";
import { ownerRefusal } from "./host-method-access.js";
import type { ClientCalls } from "./client-calls.js";
import { WINDOW_SERVICES_ID } from "./window-extensions.js";
import {
  ChecksumMismatch,
  downloadVerified,
  pickReleaseFile,
  readUpdateRelease,
  releaseFileUrl,
  releaseInfoName,
  safeReleaseName,
  type Fetch,
  type UpdateRelease,
  type UpdateFeed,
  type UpdateLog,
} from "./release-feed.js";
import type { StagedUpdate, UpdateInstaller } from "./update-installers.js";

/**
 * The machine's own updater, in the host process (K103): a host without a
 * window checks, downloads and installs by itself. Where a Tau window runs on
 * the machine, that window's updater installs, as it always did, and this one
 * only asks it to.
 */

/** A Tau window on this machine, reached through core's window half. */
export interface WindowUpdatePort {
  /** Whether a window on this machine is attached at all. */
  attached(): boolean;
  /** Whether it can install (a packaged app a person sees), and what it downloaded. */
  state(): Promise<{ installs: boolean; downloaded?: string } | undefined>;
  /** Installs now when downloaded, else as soon as the download is done. */
  install(): Promise<{ started: boolean; reason?: string }>;
}

export interface HostUpdaterOptions {
  version: string;
  arch: string;
  platform: NodeJS.Platform;
  /** Absent where this copy cannot replace itself; `unsupported` says why. */
  installer?: UpdateInstaller;
  unsupported?: string;
  feed?: UpdateFeed;
  /** A local feed (`TAU_UPDATE_FEED_URL`), for tests. */
  feedOverride?: string;
  releaseKeys: readonly string[];
  /** Downloads and the settings file. */
  dir: string;
  fetch: Fetch;
  /** `updates.channel` of this machine's config, read before each check. */
  channel(): Promise<UpdateChannel | undefined>;
  /** Saves an implicit nightly preference before installing a stable release. */
  preserveNightlyChannel?(): Promise<void>;
  window?: WindowUpdatePort;
  /** A service host leaves to be started again on the new version. Absent: the next start runs it. */
  restart?(): void;
  /** An installer that closes this process and starts it again itself (Windows). */
  exit?(): void;
  publish(status: HostUpdateStatus): void;
  log: UpdateLog;
  now?(): number;
  startupDelayMs?: number;
  intervalMs?: number;
  /** How long no turn must have run before an automatic install. */
  quietMs?: number;
}

const DEFAULT_STARTUP_DELAY_MS = 2 * 60_000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_QUIET_MS = 15 * 60_000;
const SETTINGS_FILE = "settings.json";
/** The answer to the install request goes out before the host leaves. */
const LEAVE_DELAY_MS = 1_500;

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n", 1)[0]?.trim() || "unknown error";
}

export class HostUpdater {
  private phase: HostUpdatePhase;
  private reason: string | undefined;
  private latest: string | undefined;
  private release: UpdateRelease | undefined;
  private staged: StagedUpdate | undefined;
  private progress: number | undefined;
  private checkedAt: number | undefined;
  private installer: HostUpdateInstaller;
  private settings: Required<HostUpdateSettings>;
  private channelNow: UpdateChannel;
  private readonly running = new Set<string>();
  private lastTurnEnd: number;
  /** Someone asked for this install; it goes as soon as no turn runs. */
  private requested = false;
  /** A version whose install failed is not retried on its own; asking again does. */
  private failedVersion: string | undefined;
  private work: Promise<unknown> = Promise.resolve();
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly options: HostUpdaterOptions) {
    this.phase = options.installer || options.window ? "idle" : "unsupported";
    this.reason = this.phase === "unsupported" ? options.unsupported ?? "This copy of Tau cannot update itself." : undefined;
    this.installer = options.installer ? "host" : "none";
    this.settings = this.readSettings();
    this.channelNow = defaultUpdateChannel(options.version);
    this.lastTurnEnd = this.now();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  status(): HostUpdateStatus {
    return {
      version: this.options.version,
      phase: this.phase,
      channel: this.channelNow,
      automatic: this.settings.automatic,
      installer: this.installer,
      devicesMayInstall: this.settings.devicesMayInstall,
      platform: this.options.platform,
      arch: this.options.arch,
      ...(this.options.installer ? { method: this.options.installer.method } : {}),
      ...(this.latest ? { latest: this.latest } : {}),
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.phase === "downloading" && this.progress !== undefined ? { progress: this.progress } : {}),
      ...(this.phase === "waiting" ? { runningTurns: this.running.size } : {}),
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
    };
  }

  /** First check soon after start, then one every interval. */
  start(): void {
    if (this.phase === "unsupported" || this.timers.length > 0) return;
    const first = setTimeout(() => void this.check().catch(() => undefined), this.options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS);
    const every = setInterval(() => void this.check().catch(() => undefined), this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    first.unref?.();
    every.unref?.();
    this.timers = [first, every];
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) { clearTimeout(timer); clearInterval(timer); }
    clearTimeout(this.quietTimer);
    this.timers = [];
  }

  /** Turns start and end here: a running turn holds an install back. */
  observe(event: { type: string; sessionId?: string | undefined; running?: boolean }): void {
    if (event.type === "config-changed") {
      void this.refreshChannel();
      return;
    }
    if (event.type !== "agent-status" || !event.sessionId) return;
    if (event.running) {
      this.running.add(event.sessionId);
      return;
    }
    if (!this.running.delete(event.sessionId)) return;
    this.lastTurnEnd = this.now();
    if (this.phase === "waiting") this.emit();
    if (this.running.size === 0) void this.serialize(() => this.maybeInstall());
  }

  updateSettings(patch: HostUpdateSettings): HostUpdateStatus {
    this.settings = {
      automatic: patch.automatic ?? this.settings.automatic,
      devicesMayInstall: patch.devicesMayInstall ?? this.settings.devicesMayInstall,
    };
    try {
      mkdirSync(this.options.dir, { recursive: true });
      writeFileSync(join(this.options.dir, SETTINGS_FILE), `${JSON.stringify(this.settings, null, 2)}\n`);
    } catch (error) {
      this.options.log.warn("host-update.settings.failed", error);
    }
    this.options.log.info("host-update.settings", this.settings);
    this.emit();
    if (this.settings.automatic && this.phase === "available") void this.serialize(() => this.download().then(() => this.maybeInstall()));
    else if (this.settings.automatic) void this.serialize(() => this.maybeInstall());
    return this.status();
  }

  /** Asks the feed now. A newer release downloads right away when updates are automatic. */
  check(): Promise<HostUpdateStatus> {
    return this.serialize(async () => {
      await this.checkNow();
      if (this.settings.automatic && this.phase === "available" && this.installer === "host") {
        await this.download();
        await this.maybeInstall();
      }
      return this.status();
    });
  }

  /**
   * "Update now": downloads when needed and installs as soon as no turn runs.
   * Where a Tau window on this machine installs, it is asked to.
   */
  install(): Promise<HostUpdateStatus> {
    return this.serialize(async () => {
      if (this.phase === "unsupported") throw new Error(this.reason ?? "This copy of Tau cannot update itself.");
      if (this.phase === "installing" || this.phase === "installed") return this.status();
      await this.checkNow();
      if (!this.latest || compareVersions(this.options.version, this.latest) >= 0) return this.status();
      this.requested = true;
      if (this.installer === "host" && !this.staged) await this.download();
      await this.maybeInstall();
      return this.status();
    });
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.work.then(run, run);
    this.work = next.catch(() => undefined);
    return next;
  }

  private emit(): void {
    if (!this.disposed) this.options.publish(this.status());
  }

  private set(phase: HostUpdatePhase, reason?: string): void {
    this.phase = phase;
    this.reason = reason;
    this.emit();
  }

  private readSettings(): Required<HostUpdateSettings> {
    try {
      const value = JSON.parse(readFileSync(join(this.options.dir, SETTINGS_FILE), "utf8")) as HostUpdateSettings;
      return { automatic: value.automatic !== false, devicesMayInstall: value.devicesMayInstall !== false };
    } catch {
      return { automatic: true, devicesMayInstall: true };
    }
  }

  private async refreshChannel(): Promise<UpdateChannel> {
    const wanted = await this.options.channel().catch(() => undefined);
    const channel = wanted ?? defaultUpdateChannel(this.options.version);
    if (channel !== this.channelNow) {
      this.channelNow = channel;
      // What the other channel offered is not this one's.
      this.latest = undefined;
      this.release = undefined;
      if (this.phase !== "unsupported" && this.phase !== "installing" && this.phase !== "installed") this.phase = "idle";
      this.emit();
    }
    return channel;
  }

  /** A window on this machine installs when it can; otherwise this host does. */
  private async refreshInstaller(): Promise<void> {
    let next: HostUpdateInstaller = this.options.installer ? "host" : "none";
    if (this.options.window?.attached()) {
      const state = await this.options.window.state().catch(() => undefined);
      if (state?.installs) next = "window";
    }
    this.installer = next;
  }

  private async checkNow(): Promise<void> {
    if (this.phase === "unsupported" || this.phase === "installing" || this.phase === "installed") return;
    const channel = await this.refreshChannel();
    await this.refreshInstaller();
    const before = this.phase;
    this.set("checking");
    try {
      const release = await readUpdateRelease({
        fetch: this.options.fetch, channel, feed: this.options.feed, override: this.options.feedOverride,
        name: releaseInfoName(this.options.platform, this.options.arch), keys: this.options.releaseKeys, log: this.options.log,
      });
      const { info } = release;
      // An unavailable feed cannot replace a newer download with an older one.
      if (channel === "nightly" && this.staged && compareVersions(this.staged.version, info.version) > 0) {
        this.latest = this.staged.version;
        this.checkedAt = this.now();
        this.set(this.requested && this.running.size > 0 ? "waiting" : "ready");
        return;
      }
      if (channel === "nightly" && release.channel === "stable" && compareVersions(info.version, this.options.version) > 0) await this.options.preserveNightlyChannel?.();
      this.release = release;
      this.latest = info.version;
      this.checkedAt = this.now();
      this.options.log.info("host-update.checked", { channel, latest: info.version, signed: info.signed });
      if (compareVersions(this.options.version, info.version) >= 0) {
        this.drop();
        this.set("current");
      } else if (this.staged?.version === info.version) {
        this.set(this.requested && this.running.size > 0 ? "waiting" : "ready");
      } else {
        this.set("available");
      }
    } catch (error) {
      this.checkedAt = this.now();
      this.options.log.warn("host-update.check.failed", error);
      // A download that is here stays installable; a feed that did not answer changes nothing about it.
      if (this.staged) this.set(before === "waiting" ? "waiting" : "ready");
      else this.set("failed", `The update check failed: ${message(error)}`);
    }
  }

  private async download(): Promise<void> {
    const release = this.release;
    const info = release?.info;
    const method = this.options.installer?.method;
    if (!release || !info || !method || this.installer !== "host") return;
    if (this.staged?.version === info.version) return;
    const blocked = await this.options.installer!.blocked();
    if (blocked) {
      this.set("available", blocked);
      return;
    }
    const file = pickReleaseFile(info.files, method, this.options.arch);
    const name = file ? safeReleaseName(file.url) : undefined;
    if (!file || !name) {
      this.set("failed", `The release lists nothing for this ${method} install on ${this.options.arch}.`);
      return;
    }
    const { channel, base } = release;
    const url = releaseFileUrl(name, info.version, channel, base, this.options.feed, this.options.feedOverride);
    mkdirSync(this.options.dir, { recursive: true });
    const target = join(this.options.dir, name);
    this.progress = 0;
    this.set("downloading");
    try {
      await downloadVerified(this.options.fetch, url, target, file, undefined, (received, total) => {
        if (!total) return;
        const percent = Math.min(100, Math.floor((received / total) * 10) * 10);
        if (percent !== this.progress) {
          this.progress = percent;
          this.emit();
        }
      });
      this.removeOthers(name);
      this.staged = { version: info.version, channel, file: target, sha512: file.sha512, ...(file.size !== undefined ? { size: file.size } : {}) };
      this.options.log.info("host-update.downloaded", { version: info.version, file: name });
      this.set("ready");
    } catch (error) {
      this.options.log.warn("host-update.download.failed", error);
      this.set("failed", error instanceof ChecksumMismatch ? error.message : `The download failed: ${message(error)}`);
    } finally {
      this.progress = undefined;
    }
  }

  /** Installs when asked or when quiet, and never while a turn runs. */
  private async maybeInstall(): Promise<void> {
    if (this.disposed || this.phase === "installing" || this.phase === "installed" || this.phase === "unsupported") return;
    const ready = this.installer === "window" ? Boolean(this.latest && compareVersions(this.options.version, this.latest) < 0) : Boolean(this.staged);
    if (!ready) return;
    if (this.running.size > 0) {
      if (this.requested) this.set("waiting");
      return;
    }
    if (!this.requested) {
      // The window's own updater installs on its own terms; this host only passes a request on.
      if (!this.settings.automatic || this.installer === "window" || this.failedVersion === this.staged?.version) return;
      const quiet = this.options.quietMs ?? DEFAULT_QUIET_MS;
      const left = this.lastTurnEnd + quiet - this.now();
      if (left > 0) {
        clearTimeout(this.quietTimer);
        this.quietTimer = setTimeout(() => void this.serialize(() => this.maybeInstall()), left);
        this.quietTimer.unref?.();
        return;
      }
    }
    if (this.installer === "window") await this.installThroughWindow();
    else await this.installHere();
  }

  private async installThroughWindow(): Promise<void> {
    this.set("installing", "A Tau window on this machine installs it and restarts.");
    try {
      const result = await this.options.window!.install();
      this.options.log.info("host-update.window", result);
      if (!result.started) this.set("downloading", result.reason ?? "The Tau window on this machine downloads it and installs it then.");
    } catch (error) {
      this.requested = false;
      this.set("failed", `The Tau window did not install it: ${message(error)}`);
    }
  }

  private async installHere(): Promise<void> {
    const staged = this.staged!;
    const blocked = await this.options.installer!.blocked();
    if (blocked) {
      this.requested = false;
      this.set("ready", blocked);
      return;
    }
    this.options.log.info("host-update.installing", { version: staged.version, method: this.options.installer!.method });
    this.set("installing");
    try {
      const after = await this.options.installer!.install(staged);
      this.requested = false;
      this.drop();
      if (after === "restart" && this.options.restart) {
        this.set("installed", `Tau ${staged.version} is installed; the host restarts into it.`);
        this.options.log.info("host-update.restart", staged.version);
        setTimeout(() => this.options.restart!(), LEAVE_DELAY_MS);
      } else if (after === "exit" && this.options.exit) {
        this.set("installed", `Tau ${staged.version} installs now; the host starts again after it.`);
        setTimeout(() => this.options.exit!(), LEAVE_DELAY_MS);
      } else {
        this.set("installed", `Tau ${staged.version} is installed; it runs from the next start.`);
      }
    } catch (error) {
      this.requested = false;
      this.failedVersion = staged.version;
      this.options.log.warn("host-update.install.failed", error);
      this.set("failed", message(error));
    }
  }

  /** Forgets the download; the file goes with it. */
  private drop(): void {
    if (this.staged) rmSync(this.staged.file, { force: true });
    this.staged = undefined;
  }

  private removeOthers(keep: string): void {
    try {
      for (const entry of readdirSync(this.options.dir)) {
        if (entry !== keep && entry !== SETTINGS_FILE) rmSync(join(this.options.dir, entry), { force: true, recursive: true });
      }
    } catch {
      // Nothing to tidy.
    }
  }
}

type Method = (params: readonly unknown[], context: HostMethodContext) => Promise<unknown>;

const unsupported = (): Error => Object.assign(new Error("This host has no updater: it runs inside a Tau window, which updates itself."), { code: HOST_ERROR.unsupported });

function decodeSettings(value: unknown): HostUpdateSettings {
  const item = value as Record<string, unknown> | undefined;
  if (!item || typeof item !== "object") throw Object.assign(new Error("update-settings: expected an object."), { code: HOST_ERROR.invalidRequest });
  const flag = (key: string) => {
    if (item[key] === undefined) return {};
    if (typeof item[key] !== "boolean") throw Object.assign(new Error(`update-settings: ${key} must be true or false.`), { code: HOST_ERROR.invalidRequest });
    return { [key]: item[key] };
  };
  return { ...flag("automatic"), ...flag("devicesMayInstall") };
}

/**
 * `update-status`, `update-check`, `update-install` and `update-settings`
 * (K103). Installing asks for Full access (the method's class) and, for a
 * paired device, the owner's leave (`devicesMayInstall`); only the host
 * token changes that leave.
 */
export function createUpdateMethods(updater: () => HostUpdater | undefined): Record<string, Method> {
  const need = (): HostUpdater => updater() ?? (() => { throw unsupported(); })();
  return {
    [HOST_UPDATE_METHODS.status]: async () => need().status(),
    [HOST_UPDATE_METHODS.check]: async () => need().check(),
    [HOST_UPDATE_METHODS.install]: async (_params, context) => {
      const service = need();
      if (!isHostOwner(context.principal) && !service.status().devicesMayInstall) {
        throw Object.assign(new Error("This machine's owner does not let paired devices install updates (Settings → About there)."), { code: HOST_ERROR.forbidden });
      }
      return service.install();
    },
    [HOST_UPDATE_METHODS.settings]: async (params, context) => {
      const patch = decodeSettings(params[0]);
      if (patch.devicesMayInstall !== undefined && !isHostOwner(context.principal)) throw ownerRefusal();
      return need().updateSettings(patch);
    },
  };
}

/** Core's window half on this machine: only a window here, never a paired device's. */
export function localWindowUpdatePort(calls: Pick<ClientCalls, "call" | "hasLocalWindow">): WindowUpdatePort {
  const ask = (command: string) => calls.call(WINDOW_SERVICES_ID, command, undefined, { window: "host", timeoutMs: 10_000 });
  return {
    attached: () => calls.hasLocalWindow(WINDOW_SERVICES_ID),
    state: async () => {
      const value = await ask("update-state") as { installs?: unknown; downloaded?: unknown } | null;
      if (!value || typeof value !== "object") return undefined;
      return { installs: value.installs === true, ...(typeof value.downloaded === "string" ? { downloaded: value.downloaded } : {}) };
    },
    install: async () => {
      const value = await ask("update-install") as { started?: unknown; reason?: unknown } | null;
      return { started: value?.started === true, ...(typeof value?.reason === "string" ? { reason: value.reason } : {}) };
    },
  };
}
