import { spawn, type ChildProcessByStdio } from "node:child_process";
import { posix } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { AskpassBridge } from "./askpass.js";
import type { ServerCapabilities } from "./protocol.js";
import {
  isWithin, ServerPathError, touchesGit,
  type ServerArea, type ServerEntry, type ServerExecOptions, type ServerExecResult, type ServerFs, type ServerFsCallOptions, type ServerStat,
} from "./server-fs.js";
import { fileType, isNoSuchFile, SftpClient, type SftpAttrs } from "./sftp-client.js";
import {
  ensureControlDir, loopbackOnly, loopbackRefusal, parseSshG, shellQuote, sshBaseArgs, SSH_CONFIG_ENV, type SshTarget,
} from "./ssh-target.js";

/*
 * A server target over the system `ssh`: one ControlMaster connection per
 * target (none on Windows), the SFTP protocol over `ssh -s sftp` kept open,
 * and `exec` through the same master. Questions ssh has go to the askpass bridge.
 */

export interface SshTransportOptions {
  /** From `findCommand("ssh")`. */
  ssh: string;
  askpass: AskpassBridge;
  /** The project, for relative key paths. */
  baseDir?: string;
  /** The host's environment by default; `SSH_AUTH_SOCK` and the servers variables come from here. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Where `/tmp/tau-<uid>` goes; tests use their own. */
  controlRoot?: string;
  /** Counts each child process (`services.noteSubprocess`). */
  onSpawn?: () => void;
}

export class SshConnectError extends Error {
  constructor(message: string, readonly stderr = "") {
    super(message);
    this.name = "SshConnectError";
  }
}

const PROBE = "printf 'tau\\n'; printf '%s\\n' \"$HOME\"; uname -s; command -v sha256sum shasum tar git timeout";
const DEFAULT_EXEC_TIMEOUT = 60_000;
const DEFAULT_OUTPUT_CAP = 1024 * 1024;
/** How long a connection may wait on the user (dialogs) before it is given up. */
const CONNECT_TIMEOUT = 5 * 60_000;

export interface ProbeResult {
  shell: boolean;
  home?: string;
  os?: string;
  commands: string[];
}

export function parseProbe(stdout: string): ProbeResult {
  const lines = stdout.split(/\r?\n/u);
  if (lines[0] !== "tau") return { shell: false, commands: [] };
  const commands = lines.slice(3).map((line) => line.trim()).filter((line) => line.startsWith("/")).map((line) => posix.basename(line));
  return { shell: true, ...(lines[1] ? { home: lines[1] } : {}), ...(lines[2] ? { os: lines[2] } : {}), commands };
}

/** ssh's own error lines, without the banner noise; the last few say what went wrong. */
function sshFailure(stderr: string): string {
  const lines = stderr.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !/^(Warning: Permanently added|\*\*)/u.test(line));
  return lines.slice(-3).join(" ") || "ssh could not connect";
}

const statOf = (attrs: SftpAttrs): ServerStat => ({
  type: fileType(attrs.mode),
  size: attrs.size ?? 0,
  mtime: attrs.mtime ?? 0,
  mode: (attrs.mode ?? 0) & 0o7777,
});

type SftpProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export class SshTransport implements ServerFs {
  caps: ServerCapabilities = { exec: false, hash: false, atomicRename: false, chmod: true, mtimeSet: true };
  root = "";
  scratch: string | undefined;
  probe: ProbeResult | undefined;
  private connecting: Promise<void> | undefined;
  private client: SftpClient | undefined;
  private process: SftpProcess | undefined;
  private opening: Promise<SftpClient> | undefined;
  private controlDir: string | undefined;
  private closed = false;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;

  constructor(readonly target: SshTarget, private readonly options: SshTransportOptions) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
  }

  get label(): string {
    return this.target.name ?? (this.target.alias ?? `${this.target.username ? `${this.target.username}@` : ""}${this.target.host}`);
  }

  private baseArgs(): { args: string[]; destination: string } {
    const configPath = this.env[SSH_CONFIG_ENV];
    return sshBaseArgs(this.target, {
      ...(configPath ? { configPath } : {}),
      ...(this.controlDir ? { controlDir: this.controlDir } : {}),
      ...(this.options.baseDir ? { baseDir: this.options.baseDir } : {}),
      env: this.env,
    });
  }

  private childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.env, ...extra };
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
  }

  /** Once per transport: guard, master connection with the capability probe, SFTP, the two roots. */
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new SshConnectError("The connection was closed."));
    this.connecting ??= this.establish().catch((error: unknown) => {
      this.connecting = undefined;
      throw error;
    });
    return this.connecting;
  }

  private async establish(): Promise<void> {
    if (loopbackOnly(this.env)) await this.checkLoopback();
    if (this.platform !== "win32") this.controlDir = await ensureControlDir(this.options.controlRoot);
    const probe = await this.run([], PROBE, { timeoutMs: CONNECT_TIMEOUT, maxOutputBytes: 64 * 1024 });
    // 255 is ssh's own failure, but also a server that refuses `exec` (SFTP only) after a good login.
    if (probe.code === 255 && !(await this.loggedIn(probe.stderr))) {
      throw new SshConnectError(`Could not connect to ${this.label}: ${sshFailure(probe.stderr)}`, probe.stderr);
    }
    this.probe = parseProbe(probe.stdout);
    const client = await this.sftp();
    try {
      this.root = await client.realpath(this.target.remotePath || "/");
      const info = await client.stat(this.root);
      if (fileType(info.mode) !== "directory") throw new Error("not a folder");
    } catch (error) {
      throw new SshConnectError(`${this.target.remotePath} is not a folder on ${this.label}: ${(error as Error).message}`);
    }
    this.scratch = await this.findScratch(client);
    const shell = this.probe.shell;
    this.caps = {
      exec: shell,
      hash: shell && (this.probe.commands.includes("sha256sum") || this.probe.commands.includes("shasum")),
      atomicRename: client.hasPosixRename,
      chmod: true,
      mtimeSet: true,
    };
  }

  private async loggedIn(stderr: string): Promise<boolean> {
    if (/exec request failed|channel \d+: open failed/iu.test(stderr)) return true;
    if (!this.controlDir) return false;
    const { args, destination } = this.baseArgs();
    const check = await this.spawnCollect([...args, "-O", "check", "--", destination], { timeoutMs: 10_000, maxOutputBytes: 16 * 1024 });
    return check.code === 0;
  }

  private async checkLoopback(): Promise<void> {
    const { args, destination } = this.baseArgs();
    if (!args.includes("-F")) throw new SshConnectError(`${SSH_CONFIG_ENV} is not set; with the loopback guard on, Tau never reads the real ssh config.`);
    const resolved = await this.spawnCollect(["-G", ...args, "--", destination], { timeoutMs: 10_000, maxOutputBytes: 256 * 1024 });
    if (resolved.code !== 0) throw new SshConnectError(`ssh -G ${destination} failed: ${sshFailure(resolved.stderr)}`, resolved.stderr);
    const refusal = loopbackRefusal(parseSshG(resolved.stdout));
    if (refusal) throw new SshConnectError(`Connection refused: loopback only (${refusal}).`);
  }

  /** `$HOME/tmp` as the shell sees it, else what `~/tmp` expands to over SFTP. */
  private async findScratch(client: SftpClient): Promise<string | undefined> {
    const candidate = this.probe?.home ? posix.join(this.probe.home, "tmp") : await client.expandPath("~/tmp").catch(() => undefined);
    if (!candidate) return undefined;
    try {
      const real = await client.realpath(candidate);
      const info = await client.stat(real);
      return fileType(info.mode) === "directory" ? real : undefined;
    } catch {
      return undefined;
    }
  }

  private async sftp(): Promise<SftpClient> {
    if (this.client && !this.client.closed) return this.client;
    this.opening ??= this.openSftp().finally(() => { this.opening = undefined; });
    return this.opening;
  }

  private async openSftp(): Promise<SftpClient> {
    const { args, destination } = this.baseArgs();
    const session = await this.options.askpass.session({ id: this.target.id, label: this.label });
    this.options.onSpawn?.();
    const child = spawn(this.options.ssh, [...args, "-T", "-s", "--", destination, "sftp"], {
      env: this.childEnv(session.env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { if (stderr.length < 16_384) stderr += chunk; });
    child.stdin.on("error", () => undefined);
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.once("error", () => undefined);
    void exited.then(() => {
      session.dispose();
      if (this.process === child) { this.process = undefined; this.client?.end(); }
    });
    const client = new SftpClient(child.stdout, child.stdin, { concurrency: this.target.concurrency ?? 16 });
    try {
      await client.init();
    } catch {
      child.kill();
      throw new SshConnectError(`SFTP did not start on ${this.label}: ${sshFailure(stderr)}`, stderr);
    }
    this.process = child;
    this.client = client;
    return client;
  }

  private spawnCollect(args: string[], options: { input?: string; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal; env?: Record<string, string> }): Promise<ServerExecResult> {
    this.options.onSpawn?.();
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.ssh, args, { env: this.childEnv(options.env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let truncated = false;
      let timedOut = false;
      const collect = (into: Buffer[], size: number, chunk: Buffer): number => {
        const room = options.maxOutputBytes - size;
        if (room <= 0) { truncated = true; return size; }
        if (chunk.length > room) truncated = true;
        into.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        return size + Math.min(chunk.length, room);
      };
      child.stdout.on("data", (chunk: Buffer) => { outBytes = collect(out, outBytes, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { errBytes = collect(err, errBytes, chunk); });
      child.stdin.on("error", () => undefined);
      const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
      const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
      options.signal?.addEventListener("abort", stop, { once: true });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", stop);
        resolve({ code, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), truncated, timedOut });
      });
      child.stdin.end(options.input ?? "");
    });
  }

  /** One ssh call through the master, with its own askpass token. */
  private async run(extra: string[], command: string, options: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal }): Promise<ServerExecResult> {
    const { args, destination } = this.baseArgs();
    const session = await this.options.askpass.session({ id: this.target.id, label: this.label });
    try {
      return await this.spawnCollect([...args, "-T", ...extra, "--", destination, command], { ...options, env: session.env });
    } finally {
      session.dispose();
    }
  }

  private areaRoots(area: ServerArea = "any"): string[] {
    const roots = area === "tmp" ? [this.scratch] : area === "project" ? [this.root] : [this.root, this.scratch];
    return roots.filter((root): root is string => Boolean(root));
  }

  private absolute(path: string): string {
    if (path === "~/tmp" || path.startsWith("~/tmp/")) {
      if (!this.scratch) throw new ServerPathError(path, "this server has no ~/tmp");
      return posix.normalize(posix.join(this.scratch, path.slice(5)));
    }
    return posix.normalize(posix.isAbsolute(path) ? path : posix.join(this.root, path));
  }

  private check(path: string, real: string, area: ServerArea | undefined, notRoot: boolean): string {
    const root = this.areaRoots(area).find((candidate) => isWithin(real, candidate));
    if (!root) throw new ServerPathError(path, `outside ${area === "tmp" ? "~/tmp" : area === "project" ? this.target.remotePath : `${this.target.remotePath} and ~/tmp`}`);
    if (notRoot && real === root) throw new ServerPathError(path, "is the target's own folder");
    if (touchesGit(real, root)) throw new ServerPathError(path, "Tau never touches .git on a server");
    return real;
  }

  /** Where `path` leads, symlinks followed; a path that does not exist yet by its parent. */
  private async resolve(path: string, options: ServerFsCallOptions = {}): Promise<string> {
    await this.connect();
    const client = await this.sftp();
    const absolute = this.absolute(path);
    let real: string;
    try {
      real = await client.realpath(absolute, options.signal);
    } catch (error) {
      if (!isNoSuchFile(error)) throw error;
      // A strict server: resolve the parent; a dangling link here could point anywhere.
      const parent = await client.realpath(posix.dirname(absolute), options.signal);
      const exists = await client.lstat(absolute, options.signal).then(() => true, () => false);
      if (exists) throw new ServerPathError(path, "is a link Tau cannot follow");
      real = posix.join(parent, posix.basename(absolute));
    }
    return this.check(path, real, options.area, false);
  }

  /** The directory entry itself (lstat, remove, rename): its parent resolved, the last name kept. */
  private async resolveEntry(path: string, options: ServerFsCallOptions = {}, notRoot = true): Promise<string> {
    await this.connect();
    const client = await this.sftp();
    const absolute = this.absolute(path);
    if (absolute === "/") throw new ServerPathError(path, "is the server's root");
    const parent = await client.realpath(posix.dirname(absolute), options.signal);
    return this.check(path, posix.join(parent, posix.basename(absolute)), options.area, notRoot);
  }

  async realpath(path: string, options?: ServerFsCallOptions): Promise<string> {
    return this.resolve(path, options);
  }

  async list(dir: string, options?: ServerFsCallOptions): Promise<ServerEntry[]> {
    const real = await this.resolve(dir, options);
    const entries = await (await this.sftp()).list(real, options?.signal);
    return entries.map((entry) => ({ name: entry.filename, path: posix.join(real, entry.filename), ...statOf(entry.attrs) }));
  }

  async stat(path: string, options?: ServerFsCallOptions): Promise<ServerStat> {
    const real = await this.resolveEntry(path, options, false);
    return statOf(await (await this.sftp()).lstat(real, options?.signal));
  }

  async read(path: string, options?: ServerFsCallOptions): Promise<Buffer> {
    const real = await this.resolve(path, options);
    return (await this.sftp()).readFile(real, options?.signal);
  }

  async write(path: string, data: Buffer, options: ServerFsCallOptions & { mode?: number; exclusive?: boolean } = {}): Promise<void> {
    const real = await this.resolve(path, options);
    await (await this.sftp()).writeFile(real, data, {
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      ...(options.exclusive ? { exclusive: true } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async rename(from: string, to: string, options?: ServerFsCallOptions): Promise<void> {
    const source = await this.resolveEntry(from, options);
    const target = await this.resolveEntry(to, options);
    const client = await this.sftp();
    if (client.hasPosixRename) await client.posixRename(source, target, options?.signal);
    else await client.rename(source, target, options?.signal);
  }

  async remove(path: string, options?: ServerFsCallOptions): Promise<void> {
    const real = await this.resolveEntry(path, options);
    await (await this.sftp()).remove(real, options?.signal);
  }

  async mkdir(path: string, options: ServerFsCallOptions & { mode?: number } = {}): Promise<void> {
    const real = await this.resolveEntry(path, options);
    await (await this.sftp()).mkdir(real, options.mode === undefined ? {} : { mode: options.mode }, options.signal);
  }

  async rmdir(path: string, options?: ServerFsCallOptions): Promise<void> {
    const real = await this.resolveEntry(path, options);
    await (await this.sftp()).rmdir(real, options?.signal);
  }

  async chmod(path: string, mode: number, options?: ServerFsCallOptions): Promise<void> {
    const real = await this.resolve(path, options);
    await (await this.sftp()).setstat(real, { mode: mode & 0o7777 }, options?.signal);
  }

  async setMtime(path: string, mtime: number, options?: ServerFsCallOptions): Promise<void> {
    const real = await this.resolve(path, options);
    const client = await this.sftp();
    const current = await client.stat(real, options?.signal);
    await client.setstat(real, { atime: current.atime ?? mtime, mtime }, options?.signal);
  }

  async exec(command: string, options: ServerExecOptions = {}): Promise<ServerExecResult> {
    await this.connect();
    if (!this.caps.exec) throw new SshConnectError(`${this.label} runs no commands (SFTP only).`);
    const where = options.cwd ?? "project";
    const cwd = where === "project" ? this.root : where === "tmp" ? this.scratch : await this.resolve(where, { area: "any" });
    if (!cwd) throw new ServerPathError("~/tmp", "this server has no ~/tmp");
    const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT;
    // Ending the local ssh leaves a command without a terminal running; the server's own `timeout` stops it.
    const seconds = Math.ceil(timeoutMs / 1000);
    const bounded = this.probe?.commands.includes("timeout") ? `timeout -k 5 ${seconds} sh -c ${shellQuote(command)}` : command;
    return this.run([], `cd ${shellQuote(cwd)} && ${bounded}`, {
      timeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_OUTPUT_CAP,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async hashMany(paths: readonly string[], options?: ServerFsCallOptions): Promise<Map<string, string>> {
    await this.connect();
    if (!this.caps.hash) throw new SshConnectError(`${this.label} has no sha256sum or shasum.`);
    const tool = this.probe!.commands.includes("sha256sum") ? "sha256sum" : "shasum -a 256";
    const resolved = new Map<string, string>();
    for (const path of paths) resolved.set(await this.resolve(path, options), path);
    const hashes = new Map<string, string>();
    const batch: string[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const result = await this.run([], `${tool} -- ${batch.map(shellQuote).join(" ")} 2>/dev/null; true`, { timeoutMs: 5 * 60_000, maxOutputBytes: 16 * 1024 * 1024, ...(options?.signal ? { signal: options.signal } : {}) });
      for (const line of result.stdout.split("\n")) {
        const match = /^([0-9a-f]{64}) [ *](.+)$/u.exec(line);
        const original = match ? resolved.get(match[2]!) : undefined;
        if (match && original !== undefined) hashes.set(original, match[1]!);
      }
      batch.length = 0;
    };
    let length = 0;
    for (const real of resolved.keys()) {
      batch.push(real);
      length += real.length + 3;
      if (length > 64 * 1024) { await flush(); length = 0; }
    }
    await flush();
    return hashes;
  }

  /** Ends SFTP and the master (`ssh -O exit`); the transport is done after this. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.connecting?.catch(() => undefined);
    this.client?.end();
    const child = this.process;
    this.process = undefined;
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 2_000);
        child.once("close", () => { clearTimeout(timer); resolve(); });
      });
    }
    if (this.controlDir) {
      const { args, destination } = this.baseArgs();
      await this.spawnCollect([...args, "-O", "exit", "--", destination], { timeoutMs: 10_000, maxOutputBytes: 16 * 1024 }).catch(() => undefined);
    }
  }
}

/**
 * The open transports, one per project and target. A project that closes
 * takes its connections with it (`afterWorkspaceClose`).
 */
export class SshConnections {
  private readonly open = new Map<string, { workspace: string; transport: SshTransport }>();

  constructor(private readonly create: (target: SshTarget, workspace: string) => SshTransport) {}

  get(workspace: string, target: SshTarget): SshTransport {
    const key = `${workspace}\0${target.id}`;
    const existing = this.open.get(key);
    if (existing && sameTarget(existing.transport.target, target)) return existing.transport;
    if (existing) void existing.transport.close();
    const transport = this.create(target, workspace);
    this.open.set(key, { workspace, transport });
    return transport;
  }

  async closeWorkspace(workspace: string): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [key, entry] of this.open) {
      if (entry.workspace !== workspace) continue;
      this.open.delete(key);
      closing.push(entry.transport.close());
    }
    await Promise.all(closing);
  }

  async closeAll(): Promise<void> {
    const all = [...this.open.values()];
    this.open.clear();
    await Promise.all(all.map((entry) => entry.transport.close()));
  }
}

const sameTarget = (a: SshTarget, b: SshTarget) => JSON.stringify(a) === JSON.stringify(b);
