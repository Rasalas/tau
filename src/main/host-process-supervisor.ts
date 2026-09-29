import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DATA_FOLDER_BUSY_EXIT_CODE, dataFolderBusy, describeDataFolderOwner, waitForDataFolderFree } from "./data-folder-lock.js";
import type { HostLogger } from "./host-log.js";
import { HostUplink } from "./host-uplink.js";
import { killProcessTree } from "./platform-process.js";

/** `<userData>/host.json`: how a later window finds the host that is already running. */
export interface HostProcessDescriptor {
  pid: number;
  url: string;
  tokenPath: string;
  startedAt: string;
  version: string;
  /** Set by a host a service manager started: it wrote this file itself, and quitting a window leaves it running. */
  service?: string;
}

/**
 * The machine's service for this userData, as far as a window needs it
 * (`host-service.ts`). A host it runs is the host of this userData: a window
 * adopts it and starts none of its own.
 */
export interface HostServiceControl {
  installed(): Promise<boolean>;
  start(): Promise<void>;
  restart(): Promise<void>;
  /** Points the unit at this app and restarts it. */
  repair(): Promise<void>;
}

export interface HostProcessSupervisorOptions {
  /** `dist-electron/main/headless.js`. */
  entry: string;
  /** Electron's binary in Node mode, so the host resolves the same modules the window does. */
  execPath: string;
  userData: string;
  workspace?: string;
  /** Tau's version; a host built from another one is replaced, not adopted. */
  version: string;
  env?: NodeJS.ProcessEnv;
  logger?: HostLogger;
  /** The host would not stay up; the window shows this with the log path. */
  onFatal?(failure: { message: string; logPath: string }): void;
  /** A restart bound a different port; the window has to point its client at it. */
  onUrlChanged?(url: string): void;
  /** Replaceable for tests: anything that takes an argv and gives a child process. */
  spawnProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  startTimeoutMs?: number;
  restartDelayMs?: number;
  service?: HostServiceControl;
  /** How long a service host may take to answer after a start or a restart. */
  serviceStartTimeoutMs?: number;
  /** How often an adopted service host's `host.json` is read for a restart or a new port. */
  serviceCheckMs?: number;
  /** How often an adopted host without a service is checked for an exit. */
  adoptedCheckMs?: number;
  /** How long a host that owns this userData but does not answer is waited for before the window gives up. */
  silentOwnerTimeoutMs?: number;
  silentOwnerPollMs?: number;
  /** How long a signalled host gets before the next, harder signal. */
  signalGraceMs?: number;
}

export interface RunningHost {
  url: string;
  token: string;
  tokenPath: string;
  pid: number;
  /** True when this host was already running and was adopted rather than started. */
  adopted: boolean;
  /** The service manager that runs it, when a service does. */
  service?: string;
}

/** How often a host may crash and be restarted before the supervisor gives up. */
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const SERVICE_START_TIMEOUT_MS = 30_000;
const SERVICE_CHECK_MS = 2_000;
const SILENT_OWNER_TIMEOUT_MS = 30_000;
const SILENT_OWNER_POLL_MS = 1_000;
const SIGNAL_GRACE_MS = 10_000;
/** How long a new host waits for one that is on its way out to let go of the data folder. */
const FOLDER_FREE_TIMEOUT_MS = 15_000;
/** How many rotated host logs are kept beside the current one. */
const KEPT_LOGS = 5;

const LISTENING = /tau-host listening on (ws:\/\/\S+)/u;
/** The whole path up to the note in parentheses: a Windows profile path often has a space. */
const TOKEN_LINE = /^token: (.+?)(?: \([^()\\/]*\))?\r?$/mu;

/** The socket and the token file a starting host announces on stdout, once both lines are in. */
export function parseHostAnnouncement(output: string): { url: string; tokenPath: string } | undefined {
  const url = LISTENING.exec(output)?.[1];
  const tokenPath = TOKEN_LINE.exec(output)?.[1];
  return url && tokenPath ? { url, tokenPath } : undefined;
}

export function hostDescriptorPath(userData: string): string {
  return join(userData, "host.json");
}

export async function readHostDescriptor(userData: string): Promise<HostProcessDescriptor | undefined> {
  try {
    const parsed = JSON.parse(await readFile(hostDescriptorPath(userData), "utf8")) as Partial<HostProcessDescriptor>;
    if (typeof parsed.pid !== "number" || typeof parsed.url !== "string") return undefined;
    return {
      pid: parsed.pid,
      url: parsed.url,
      tokenPath: parsed.tokenPath ?? "",
      startedAt: parsed.startedAt ?? "",
      version: parsed.version ?? "",
      ...(typeof parsed.service === "string" && parsed.service ? { service: parsed.service } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function writeHostDescriptor(userData: string, descriptor: HostProcessDescriptor): Promise<void> {
  await mkdir(userData, { recursive: true }).catch(() => undefined);
  await writeFile(hostDescriptorPath(userData), `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Asks a host to stop with `host.shutdown` and waits for it, then signals.
 * Used for a host of another version and by a service host taking over.
 * Resolves once the host is gone and, given its `userData`, has let go of it.
 */
export async function retireHost(
  descriptor: Pick<HostProcessDescriptor, "pid" | "url">,
  token: string,
  userData?: string,
  options: { logger?: HostLogger; graceMs?: number } = {},
): Promise<void> {
  if (!processAlive(descriptor.pid)) return;
  const uplink = new HostUplink({ url: descriptor.url, token, requestTimeoutMs: SHUTDOWN_TIMEOUT_MS });
  await uplink.request("host.shutdown").catch(() => undefined);
  uplink.close();
  await endHost(descriptor.pid, userData, { ...options, askedMs: options.graceMs ?? SHUTDOWN_TIMEOUT_MS });
}

async function waitUntil(done: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await done()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Waits `askedMs` for a host that was asked to stop, then sends SIGTERM and,
 * when that is ignored too, SIGKILL. Returns once the process is gone and its
 * data folder is free, or held by somebody else by now; throws when even
 * SIGKILL left it running.
 */
export async function endHost(
  pid: number,
  userData: string | undefined,
  options: { logger?: HostLogger; askedMs?: number; graceMs?: number } = {},
): Promise<void> {
  const grace = options.graceMs ?? SIGNAL_GRACE_MS;
  if (!await waitUntil(() => !processAlive(pid), options.askedMs ?? 0)) {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      options.logger?.warn(`host-process.${signal.toLowerCase()}`, { pid });
      try { process.kill(pid, signal); } catch { /* already gone */ }
      if (await waitUntil(() => !processAlive(pid), grace)) break;
    }
    if (processAlive(pid)) throw new Error(`Tau's host (pid ${pid}) is still running after SIGKILL.`);
  }
  // A dead process holds no lock; one still held is another host's, which the caller meets next.
  if (userData && !await waitUntil(async () => !await dataFolderBusy(userData), 1_000)) {
    options.logger?.warn("host-process.folder-still-held", { pid, owner: await describeDataFolderOwner(userData) });
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Keeps the newest logs and drops the rest; a host that restarts often must not fill the disk. */
export function pruneHostLogs(directory: string, keep = KEPT_LOGS): void {
  try {
    const files = readdirSync(directory).filter((name) => /^host-out-.*\.log$/u.test(name)).sort();
    for (const name of files.slice(0, Math.max(0, files.length - keep))) {
      try { unlinkSync(join(directory, name)); } catch { /* a log we cannot delete is not a failure */ }
    }
  } catch {
    // No log directory yet; the next start creates it.
  }
}

/**
 * The host as its own process, started and watched by the window's process.
 * Threads belong to that process, so closing the window ends nothing, and a
 * window that opens later adopts the host it finds in `host.json` instead of
 * starting a second one (ADR 0021).
 */
export class HostProcessSupervisor {
  private child: ChildProcess | undefined;
  private running: RunningHost | undefined;
  private restarts: number[] = [];
  private stopping = false;
  private detached = false;
  private logPath = "";
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  /** The port a restart asks for again, so the window's client keeps its URL. */
  private preferredPort = 0;
  /** Reads an adopted service host's `host.json` for a restart or a new port. */
  private serviceCheck: ReturnType<typeof setInterval> | undefined;
  private adoptedCheck: ReturnType<typeof setInterval> | undefined;
  private checking = false;
  /** When an adopted service host was first found gone; it gets one start and some time. */
  private serviceGoneSince: number | undefined;
  /** The service would not run this version; this window runs a host of its own until it restarts. */
  private serviceRefused = false;

  constructor(private readonly options: HostProcessSupervisorOptions) {}

  get descriptor(): RunningHost | undefined {
    return this.running;
  }

  get logFile(): string {
    return this.logPath;
  }

  /**
   * Adopts the host named in `host.json` when it is alive and current, starts
   * the installed service when there is one, and starts a host otherwise.
   */
  async start(): Promise<RunningHost> {
    this.stopping = false;
    const adopted = await this.adopt() ?? await this.startService() ?? await this.awaitSilentOwner();
    if (adopted) {
      this.settle(adopted);
      return adopted;
    }
    try {
      return await this.spawnHost();
    } catch (error) {
      // Another host took the folder between the check and the spawn: that one is adopted, or waited out once.
      if (this.stopping || !await dataFolderBusy(this.options.userData)) throw error;
      const owner = await this.awaitSilentOwner();
      if (!owner) return this.spawnHost();
      this.settle(owner);
      return owner;
    }
  }

  /**
   * Asks the host to shut down and waits for it, then signals. A host that is
   * meant to outlive this window is detached instead, and a service host is
   * the service manager's to stop. A pending restart is cancelled, and a host
   * still starting is ended.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.stopServiceCheck();
    this.stopAdoptedCheck();
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const starting = this.child && this.child.pid !== this.running?.pid ? this.child : undefined;
    if (starting) await endChild(starting);
    const running = this.running;
    if (!running) return;
    if (running.service) {
      this.running = undefined;
      return;
    }
    try {
      // The file, not the token read at start: a rotation may have replaced it since.
      const token = await readFile(running.tokenPath, "utf8").then((value) => value.trim()).catch(() => "") || running.token;
      const uplink = new HostUplink({ url: running.url, token, requestTimeoutMs: SHUTDOWN_TIMEOUT_MS });
      await uplink.request("host.shutdown").catch(() => undefined);
      uplink.close();
    } catch {
      // Unreachable already: the signal below is the fallback.
    }
    await endHost(running.pid, this.options.userData, this.endOptions(this.options.signalGraceMs ?? SHUTDOWN_TIMEOUT_MS))
      .catch((error: unknown) => this.options.logger?.error("host-process.stop-failed", error));
    await rm(hostDescriptorPath(this.options.userData), { force: true }).catch(() => undefined);
    this.running = undefined;
  }

  /** Leaves the host running: the user asked for it in the background. */
  detach(): void {
    this.detached = true;
    this.stopping = true;
    this.stopServiceCheck();
    this.stopAdoptedCheck();
    this.child?.unref();
  }

  private async adopt(): Promise<RunningHost | undefined> {
    const found = await this.probeDescriptor();
    if (!found) return undefined;
    const { descriptor, token, version } = found;
    if (version !== this.options.version) {
      this.options.logger?.info("host-process.version-changed", { was: version, now: this.options.version, service: descriptor.service });
      if (descriptor.service && this.options.service) return this.updateService(descriptor.pid);
      await retireHost(descriptor, token, this.options.userData, this.endOptions());
      return undefined;
    }
    this.options.logger?.info("host-process.adopted", { pid: descriptor.pid, url: descriptor.url, service: descriptor.service });
    return this.adopted(descriptor, token);
  }

  /** The host `host.json` names, when it is alive and answers its token. */
  private async probeDescriptor(): Promise<{ descriptor: HostProcessDescriptor; token: string; version: string } | undefined> {
    const descriptor = await readHostDescriptor(this.options.userData);
    if (!descriptor || !processAlive(descriptor.pid)) return undefined;
    const token = await readFile(descriptor.tokenPath, "utf8").then((value) => value.trim()).catch(() => "");
    if (!token) return undefined;
    const hello = await HostUplink.probe(descriptor.url, token);
    if (!hello) return undefined;
    return { descriptor, token, version: hello.hostVersion };
  }

  private endOptions(askedMs?: number): { logger?: HostLogger; graceMs?: number; askedMs?: number } {
    return {
      ...(this.options.logger ? { logger: this.options.logger } : {}),
      ...(this.options.signalGraceMs !== undefined ? { graceMs: this.options.signalGraceMs } : {}),
      ...(askedMs !== undefined ? { askedMs } : {}),
    };
  }

  /**
   * Another host holds this userData and did not answer (busy, hung, or its
   * token unreadable). A second host beside it would take over its threads
   * while it still writes them, so none is started: the owner is probed again
   * until it answers or goes, and otherwise the window is told who it is.
   */
  private async awaitSilentOwner(): Promise<RunningHost | undefined> {
    const userData = this.options.userData;
    if (!await dataFolderBusy(userData)) return undefined;
    const owner = await describeDataFolderOwner(userData);
    this.options.logger?.warn("host-process.owner-silent", { owner });
    const deadline = Date.now() + (this.options.silentOwnerTimeoutMs ?? SILENT_OWNER_TIMEOUT_MS);
    while (!this.stopping) {
      await new Promise((resolve) => setTimeout(resolve, this.options.silentOwnerPollMs ?? SILENT_OWNER_POLL_MS));
      if (!await dataFolderBusy(userData)) return undefined;
      const adopted = await this.adopt();
      if (adopted) return adopted;
      if (Date.now() >= deadline) break;
    }
    throw new Error(
      `Another Tau host${owner ? ` (${owner})` : ""} owns this data folder (${userData}) and does not answer. `
      + "Tau did not start a second host beside it. Quit that host, or wait until it answers, and start Tau again.",
    );
  }

  private adopted(descriptor: HostProcessDescriptor, token: string): RunningHost {
    this.preferredPort = portOf(descriptor.url);
    return {
      url: descriptor.url,
      token,
      tokenPath: descriptor.tokenPath,
      pid: descriptor.pid,
      adopted: true,
      ...(descriptor.service ? { service: descriptor.service } : {}),
    };
  }

  private settle(running: RunningHost): void {
    this.stopAdoptedCheck();
    this.running = running;
    this.serviceGoneSince = undefined;
    if (running.service) this.startServiceCheck();
    else if (running.adopted) {
      // It is no longer our child, so no child exit event will reach this window.
      this.adoptedCheck = setInterval(() => {
        if (this.stopping || this.detached || this.running !== running || processAlive(running.pid)) return;
        this.stopAdoptedCheck();
        this.onExit(null, null);
      }, this.options.adoptedCheckMs ?? SERVICE_CHECK_MS);
      this.adoptedCheck.unref?.();
    }
  }

  private stopAdoptedCheck(): void {
    clearInterval(this.adoptedCheck);
    this.adoptedCheck = undefined;
  }

  /** The service of this userData, started when it is installed and not running. */
  private async startService(): Promise<RunningHost | undefined> {
    const service = this.options.service;
    if (!service || this.serviceRefused || !await service.installed().catch(() => false)) return undefined;
    this.options.logger?.info("host-process.service-start");
    await service.start().catch((error: unknown) => this.options.logger?.warn("host-process.service-start-failed", error));
    const found = await this.waitForServiceHost(undefined);
    if (!found) {
      this.options.logger?.warn("host-process.service-silent", "The installed service started no host; this window runs its own.");
      return undefined;
    }
    if (found.version === this.options.version) return this.adopted(found.descriptor, found.token);
    return this.updateService(found.descriptor.pid);
  }

  /**
   * The service runs another Tau than this window. A restart picks up an app
   * updated in place; a unit that names another copy of Tau is pointed at this
   * one. Each is tried once: a service that still answers with another version
   * is stopped, and this window runs a host of its own. `SuccessfulExit` and
   * `Restart=on-failure` leave a stopped service stopped, so nothing loops.
   */
  private async updateService(runningPid: number): Promise<RunningHost | undefined> {
    const service = this.options.service!;
    let pid = runningPid;
    for (const step of ["restart", "repair"] as const) {
      this.options.logger?.info(`host-process.service-${step}`, { pid });
      try {
        await (step === "restart" ? service.restart() : service.repair());
      } catch (error: unknown) {
        this.options.logger?.warn(`host-process.service-${step}-failed`, error);
        continue;
      }
      const found = await this.waitForServiceHost(pid);
      if (!found) continue;
      if (found.version === this.options.version) return this.adopted(found.descriptor, found.token);
      pid = found.descriptor.pid;
    }
    this.serviceRefused = true;
    this.options.logger?.warn("host-process.service-refused", { version: this.options.version });
    const last = await this.probeDescriptor();
    if (last) await retireHost(last.descriptor, last.token, this.options.userData, this.endOptions());
    return undefined;
  }

  /** Waits for a service host other than `previousPid` to write `host.json` and answer. */
  private async waitForServiceHost(previousPid: number | undefined): Promise<{ descriptor: HostProcessDescriptor; token: string; version: string } | undefined> {
    const deadline = Date.now() + (this.options.serviceStartTimeoutMs ?? SERVICE_START_TIMEOUT_MS);
    while (Date.now() < deadline && !this.stopping) {
      const descriptor = await readHostDescriptor(this.options.userData);
      if (descriptor?.service && descriptor.pid !== previousPid && processAlive(descriptor.pid)) {
        const found = await this.probeDescriptor();
        if (found?.descriptor.pid === descriptor.pid) return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return undefined;
  }

  private startServiceCheck(): void {
    this.stopServiceCheck();
    this.serviceCheck = setInterval(() => void this.checkService(), this.options.serviceCheckMs ?? SERVICE_CHECK_MS);
    this.serviceCheck.unref?.();
  }

  private stopServiceCheck(): void {
    clearInterval(this.serviceCheck);
    this.serviceCheck = undefined;
  }

  /**
   * An adopted service host is the service manager's: it may restart it (an
   * update, a crash) or remove it. This window follows: to a restarted host,
   * and to a host of its own once the service is gone.
   */
  private async checkService(): Promise<void> {
    const running = this.running;
    if (this.checking || this.stopping || !running?.service) return;
    this.checking = true;
    try {
      const descriptor = await readHostDescriptor(this.options.userData);
      if (descriptor && processAlive(descriptor.pid)) {
        this.serviceGoneSince = undefined;
        if (descriptor.pid === running.pid && descriptor.url === running.url) return;
        const token = await readFile(descriptor.tokenPath, "utf8").then((value) => value.trim()).catch(() => running.token);
        this.options.logger?.info("host-process.service-moved", { pid: descriptor.pid, url: descriptor.url });
        // Somebody started a host that is not the service's; watch it like any other adopted host.
        if (!descriptor.service) this.stopServiceCheck();
        this.settle(this.adopted(descriptor, token));
        if (descriptor.url !== running.url) this.options.onUrlChanged?.(descriptor.url);
        return;
      }
      const installed = await this.options.service?.installed().catch(() => false);
      if (installed) {
        const now = Date.now();
        if (this.serviceGoneSince === undefined) {
          this.serviceGoneSince = now;
          await this.options.service?.start().catch((error: unknown) => this.options.logger?.warn("host-process.service-start-failed", error));
          return;
        }
        if (now - this.serviceGoneSince < (this.options.serviceStartTimeoutMs ?? SERVICE_START_TIMEOUT_MS)) return;
      }
      this.options.logger?.info("host-process.service-gone", { installed });
      this.stopServiceCheck();
      const own = await this.spawnHost();
      if (own.url !== running.url) this.options.onUrlChanged?.(own.url);
    } catch (error: unknown) {
      this.options.logger?.error("host-process.service-check-failed", error);
    } finally {
      this.checking = false;
    }
  }

  private async spawnHost(): Promise<RunningHost> {
    // One that is on its way out (a service host stopping, a retired host) gets a moment; one that stays is not joined.
    if (!await waitForDataFolderFree(this.options.userData, FOLDER_FREE_TIMEOUT_MS)) {
      const owner = await describeDataFolderOwner(this.options.userData);
      throw new Error(`Another Tau host${owner ? ` (${owner})` : ""} owns this data folder (${this.options.userData}); Tau did not start a second one.`);
    }
    const logDirectory = join(this.options.userData, "logs");
    mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
    pruneHostLogs(logDirectory);
    this.logPath = join(logDirectory, `host-out-${new Date().toISOString().replace(/[:.]/gu, "-")}.log`);
    const logStream = createWriteStream(this.logPath, { flags: "a", mode: 0o600 });

    const env: NodeJS.ProcessEnv = {
      ...(this.options.env ?? process.env),
      // The Electron binary as plain Node: same module resolution, same native
      // builds, no window. Without this the host would start a second app.
      ELECTRON_RUN_AS_NODE: "1",
      TAU_USER_DATA: this.options.userData,
      // The host answers hello with this, and a window adopts only a host of
      // its own version; a packaged app has no npm environment to read it from.
      TAU_HOST_VERSION: this.options.version,
      TAU_HOST_LISTEN: `127.0.0.1:${this.preferredPort}`,
      // The host is this machine, so its paths are the window's paths.
      TAU_HOST_LOCAL_FILES: "1",
      ...(this.options.workspace ? { TAU_WORKSPACE: this.options.workspace } : {}),
    };
    delete env.TAU_HOST_URL;
    delete env.TAU_HOST_INPROCESS;
    // The window's own host stays on loopback in plaintext. Listeners beyond it
    // are network access, which the host reads from its own settings.
    delete env.TAU_HOST_TLS;
    delete env.TAU_HOST_TLS_CERT;
    delete env.TAU_HOST_TLS_KEY;
    delete env.TAU_HOST_PROXY_LISTEN;

    const child = (this.options.spawnProcess ?? defaultSpawn)(this.options.execPath, [this.options.entry], env);
    this.child = child;

    let output = "";
    let errors = "";
    const started = new Promise<{ url: string; tokenPath: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The host did not report a socket within ${this.startTimeout()}ms.`)), this.startTimeout());
      const read = (chunk: Buffer | string): void => {
        const text = String(chunk);
        logStream.write(text);
        output += text.slice(0, 4_000);
        const announced = parseHostAnnouncement(output);
        if (announced) {
          clearTimeout(timer);
          resolve(announced);
        }
      };
      child.stdout?.on("data", read);
      child.stderr?.on("data", (chunk: Buffer) => {
        logStream.write(String(chunk));
        errors = `${errors}${String(chunk)}`.slice(-4_000);
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => {
        clearTimeout(timer);
        // It says which host owns the folder; that is the whole message.
        const busy = code === DATA_FOLDER_BUSY_EXIT_CODE ? errors.trim().split(/\r?\n/u).at(-1) : undefined;
        reject(new Error(busy ? `Tau's host did not start: ${busy}.` : `The host exited with ${code ?? "a signal"} before it listened.`));
      });
    });

    let url: string;
    let tokenPath: string;
    let token: string;
    try {
      ({ url, tokenPath } = await started);
      token = await readFile(tokenPath, "utf8").then((value) => value.trim());
      if (this.stopping) throw new Error("The host was stopped while it started.");
    } catch (error) {
      // Detached, it would outlive the window and every test that started it.
      await endChild(child);
      logStream.end();
      throw error;
    }
    this.preferredPort = portOf(url);
    const running: RunningHost = { url, token, tokenPath, pid: child.pid ?? 0, adopted: false };
    this.running = running;
    await this.writeDescriptor(running);
    this.options.logger?.info("host-process.started", { pid: running.pid, url, log: this.logPath });
    child.on("exit", (code, signal) => {
      // The log stream holds a file handle; a host that is gone needs none.
      logStream.end();
      this.onExit(code, signal);
    });
    return running;
  }

  private startTimeout(): number {
    return this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  }

  private async writeDescriptor(running: RunningHost): Promise<void> {
    await writeHostDescriptor(this.options.userData, {
      pid: running.pid,
      url: running.url,
      tokenPath: running.tokenPath,
      startedAt: new Date().toISOString(),
      version: this.options.version,
    });
  }

  private onExit(code: number | null, signal: string | null): void {
    if (this.stopping || this.detached) return;
    if (this.options.service && !this.serviceRefused) {
      void this.followService(code, signal);
      return;
    }
    this.scheduleRestart(code, signal);
  }

  /**
   * With a service installed, this host most likely stopped because the
   * service took over (`headless.ts`); the window follows it instead of
   * starting another. Without one, or when none answers, it is a crash.
   */
  private async followService(code: number | null, signal: string | null): Promise<void> {
    const previous = this.running;
    if (!await this.options.service!.installed().catch(() => false)) {
      this.scheduleRestart(code, signal);
      return;
    }
    const found = await this.waitForServiceHost(previous?.pid);
    if (this.stopping || this.detached) return;
    if (!found || found.version !== this.options.version) {
      this.scheduleRestart(code, signal);
      return;
    }
    this.options.logger?.info("host-process.service-took-over", { pid: found.descriptor.pid, url: found.descriptor.url });
    this.settle(this.adopted(found.descriptor, found.token));
    if (found.descriptor.url !== previous?.url) this.options.onUrlChanged?.(found.descriptor.url);
  }

  private scheduleRestart(code: number | null, signal: string | null): void {
    this.options.logger?.error("host-process.exited", { code, signal, log: this.logPath });
    const now = Date.now();
    this.restarts = [...this.restarts.filter((at) => now - at < RESTART_WINDOW_MS), now];
    if (this.restarts.length > MAX_RESTARTS) {
      this.options.onFatal?.({
        message: `Tau's host stopped ${this.restarts.length} times in a minute and was not restarted again.`,
        logPath: this.logPath,
      });
      return;
    }
    const previous = this.running?.url;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.restart()
        .then((running) => { if (running.url !== previous) this.options.onUrlChanged?.(running.url); })
        .catch((error: unknown) => {
          if (this.stopping) return;
          this.options.logger?.error("host-process.restart-failed", error);
          this.options.onFatal?.({ message: `Tau's host could not be restarted: ${String(error)}`, logPath: this.logPath });
        });
    }, this.options.restartDelayMs ?? 250 * this.restarts.length);
    this.restartTimer.unref?.();
  }

  /**
   * A restart asks for the port the window's client already knows. Somebody
   * else may hold it by now — then any port will do and the window is told.
   */
  private async restart(): Promise<RunningHost> {
    try {
      return await this.spawnHost();
    } catch (error) {
      if (this.preferredPort === 0 || this.stopping) throw error;
      this.options.logger?.warn("host-process.port-taken", { port: this.preferredPort });
      this.preferredPort = 0;
      return this.spawnHost();
    }
  }
}

function defaultSpawn(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  // Its own process group: a signal meant for the window (a terminal's Ctrl-C,
  // a stopped dev instance) must not take the host's threads with it.
  return spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
}

/** Signals a child's process group and waits until the child is gone. */
async function endChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  killProcessTree(child.pid, "SIGTERM");
  const timer = setTimeout(() => { if (child.pid !== undefined) killProcessTree(child.pid, "SIGKILL"); }, SHUTDOWN_TIMEOUT_MS);
  await exited;
  clearTimeout(timer);
}

function portOf(url: string): number {
  try { return Number(new URL(url).port) || 0; } catch { return 0; }
}
