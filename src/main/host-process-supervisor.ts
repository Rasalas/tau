import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { HostLogger } from "./host-log.js";
import { HostUplink } from "./host-uplink.js";

/** `<userData>/host.json`: how a later window finds the host that is already running. */
export interface HostProcessDescriptor {
  pid: number;
  url: string;
  tokenPath: string;
  startedAt: string;
  version: string;
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
}

export interface RunningHost {
  url: string;
  token: string;
  tokenPath: string;
  pid: number;
  /** True when this host was already running and was adopted rather than started. */
  adopted: boolean;
}

/** How often a host may crash and be restarted before the supervisor gives up. */
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
/** How many rotated host logs are kept beside the current one. */
const KEPT_LOGS = 5;

const LISTENING = /tau-host listening on (ws:\/\/\S+)/u;
const TOKEN_LINE = /^token: (\S+)/mu;

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
    };
  } catch {
    return undefined;
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
  /** The port a restart asks for again, so the window's client keeps its URL. */
  private preferredPort = 0;

  constructor(private readonly options: HostProcessSupervisorOptions) {}

  get descriptor(): RunningHost | undefined {
    return this.running;
  }

  get logFile(): string {
    return this.logPath;
  }

  /** Adopts the host named in `host.json` when it is alive and current; starts one otherwise. */
  async start(): Promise<RunningHost> {
    const adopted = await this.adopt();
    if (adopted) {
      this.running = adopted;
      return adopted;
    }
    return this.spawnHost();
  }

  /**
   * Asks the host to shut down and waits for it, then signals. A host that is
   * meant to outlive this window is detached instead.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    const running = this.running;
    if (!running) return;
    try {
      const uplink = new HostUplink({ url: running.url, token: running.token, requestTimeoutMs: SHUTDOWN_TIMEOUT_MS });
      await uplink.request("host.shutdown").catch(() => undefined);
      uplink.close();
    } catch {
      // Unreachable already: the signal below is the fallback.
    }
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    while (Date.now() < deadline && processAlive(running.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (processAlive(running.pid)) {
      this.options.logger?.warn("host-process.sigterm", { pid: running.pid });
      try { process.kill(running.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    await rm(hostDescriptorPath(this.options.userData), { force: true }).catch(() => undefined);
    this.running = undefined;
  }

  /** Leaves the host running: the user asked for it in the background. */
  detach(): void {
    this.detached = true;
    this.stopping = true;
    this.child?.unref();
  }

  private async adopt(): Promise<RunningHost | undefined> {
    const descriptor = await readHostDescriptor(this.options.userData);
    if (!descriptor || !processAlive(descriptor.pid)) return undefined;
    const token = await readFile(descriptor.tokenPath, "utf8").then((value) => value.trim()).catch(() => "");
    if (!token) return undefined;
    const hello = await HostUplink.probe(descriptor.url, token);
    if (!hello) return undefined;
    if (hello.hostVersion !== this.options.version) {
      this.options.logger?.info("host-process.version-changed", { was: hello.hostVersion, now: this.options.version });
      await this.shutdownForeign(descriptor, token);
      return undefined;
    }
    this.options.logger?.info("host-process.adopted", { pid: descriptor.pid, url: descriptor.url });
    this.preferredPort = portOf(descriptor.url);
    return { ...descriptor, token, adopted: true };
  }

  /** A host of another version is asked to leave before a current one starts. */
  private async shutdownForeign(descriptor: HostProcessDescriptor, token: string): Promise<void> {
    const uplink = new HostUplink({ url: descriptor.url, token, requestTimeoutMs: SHUTDOWN_TIMEOUT_MS });
    await uplink.request("host.shutdown").catch(() => undefined);
    uplink.close();
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    while (Date.now() < deadline && processAlive(descriptor.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (processAlive(descriptor.pid)) {
      try { process.kill(descriptor.pid, "SIGTERM"); } catch { /* already gone */ }
    }
  }

  private async spawnHost(): Promise<RunningHost> {
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
    // The window's own host stays on loopback in plaintext; TLS is for a listener beyond it.
    delete env.TAU_HOST_TLS;
    delete env.TAU_HOST_TLS_CERT;
    delete env.TAU_HOST_TLS_KEY;

    const child = (this.options.spawnProcess ?? defaultSpawn)(this.options.execPath, [this.options.entry], env);
    this.child = child;
    this.stopping = false;

    let output = "";
    const started = new Promise<{ url: string; tokenPath: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The host did not report a socket within ${this.startTimeout()}ms.`)), this.startTimeout());
      const read = (chunk: Buffer | string): void => {
        const text = String(chunk);
        logStream.write(text);
        output += text.slice(0, 4_000);
        const url = LISTENING.exec(output)?.[1];
        const tokenPath = TOKEN_LINE.exec(output)?.[1];
        if (url && tokenPath) {
          clearTimeout(timer);
          resolve({ url, tokenPath });
        }
      };
      child.stdout?.on("data", read);
      child.stderr?.on("data", (chunk: Buffer) => { logStream.write(String(chunk)); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`The host exited with ${code ?? "a signal"} before it listened.`)); });
    });

    const { url, tokenPath } = await started;
    const token = await readFile(tokenPath, "utf8").then((value) => value.trim());
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
    const descriptor: HostProcessDescriptor = {
      pid: running.pid,
      url: running.url,
      tokenPath: running.tokenPath,
      startedAt: new Date().toISOString(),
      version: this.options.version,
    };
    await mkdir(this.options.userData, { recursive: true }).catch(() => undefined);
    await writeFile(hostDescriptorPath(this.options.userData), `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
  }

  private onExit(code: number | null, signal: string | null): void {
    if (this.stopping || this.detached) return;
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
    setTimeout(() => {
      void this.restart()
        .then((running) => { if (running.url !== previous) this.options.onUrlChanged?.(running.url); })
        .catch((error: unknown) => {
          this.options.logger?.error("host-process.restart-failed", error);
          this.options.onFatal?.({ message: `Tau's host could not be restarted: ${String(error)}`, logPath: this.logPath });
        });
    }, this.options.restartDelayMs ?? 250 * this.restarts.length).unref?.();
  }

  /**
   * A restart asks for the port the window's client already knows. Somebody
   * else may hold it by now — then any port will do and the window is told.
   */
  private async restart(): Promise<RunningHost> {
    try {
      return await this.spawnHost();
    } catch (error) {
      if (this.preferredPort === 0) throw error;
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

function portOf(url: string): number {
  try { return Number(new URL(url).port) || 0; } catch { return 0; }
}
