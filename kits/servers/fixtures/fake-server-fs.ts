import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { ServerCapabilities } from "../protocol";
import { ServerPathError, type ServerEntry, type ServerExecResult, type ServerExecStream, type ServerExecStreamOptions, type ServerFs, type ServerStat } from "../server-fs";
import { SftpError } from "../sftp-client";

const statOf = (info: Stats): ServerStat => ({
  type: info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
  size: info.size,
  mtime: Math.floor(info.mtimeMs / 1000),
  mode: info.mode & 0o7777,
});

const denied = (path: string) => new SftpError(3, "Permission denied", path);
const missing = (error: NodeJS.ErrnoException, path: string) => (error.code === "ENOENT" ? new SftpError(2, "No such file", path) : error);

/**
 * A server target backed by a local folder, for sync tests without ssh.
 * `shell` adds exec over `/bin/sh` in that folder, as a server with a shell has.
 * `writable` lets uploads write (read-only otherwise). Every call lands in
 * `calls`; `.git` and `..` are refused like the real transport.
 */
export class FolderServerFs implements ServerFs {
  readonly caps: ServerCapabilities;
  readonly scratch = undefined;
  readonly calls: string[] = [];
  /** Folders whose listing the "server" refuses (permission denied). */
  readonly refuse = new Set<string>();
  /** Folders (relative, `""` for the root) where no entry may be created, renamed or removed: no write permission there. */
  readonly denyEntries = new Set<string>();
  /** Runs after each read, to change the server behind Tau's back (a colleague). */
  afterRead: ((path: string) => void) | undefined;
  private readonly writable: boolean;

  constructor(readonly root: string, options: { shell?: boolean; writable?: boolean; atomicRename?: boolean } = {}) {
    // Without a shell the sync code never calls exec: it goes by `caps`.
    const shell = options.shell ?? false;
    this.writable = options.writable ?? false;
    this.caps = { exec: shell, hash: shell, atomicRename: options.atomicRename ?? true, chmod: true, mtimeSet: true };
  }

  private writeCheck(path: string): string {
    if (!this.writable) throw new Error("read-only fake");
    return this.path(path);
  }

  private folderOf(path: string): string {
    const dir = posix.dirname(path.split("/").filter(Boolean).join("/"));
    return dir === "." ? "" : dir;
  }

  private path(path: string): string {
    const parts = path.split("/").filter(Boolean);
    if (parts.includes("..")) throw new ServerPathError(path, "outside");
    if (parts.includes(".git")) throw new ServerPathError(path, "Tau never touches .git on a server");
    return join(this.root, ...parts);
  }

  async list(dir: string): Promise<ServerEntry[]> {
    this.calls.push(`list ${dir}`);
    if (this.refuse.has(dir)) throw new SftpError(3, "Permission denied", dir);
    const full = this.path(dir);
    const entries = await readdir(full);
    return Promise.all(entries.map(async (name) => ({ name, path: join(full, name), ...statOf(await lstat(join(full, name))) })));
  }

  async stat(path: string): Promise<ServerStat> {
    this.calls.push(`stat ${path}`);
    return statOf(await lstat(this.path(path)).catch((error: NodeJS.ErrnoException) => {
      throw error.code === "ENOENT" ? new SftpError(2, "No such file", path) : error;
    }));
  }

  async read(path: string): Promise<Buffer> {
    this.calls.push(`read ${path}`);
    const data = await readFile(this.path(path)).catch((error: NodeJS.ErrnoException) => {
      throw error.code === "ENOENT" ? new SftpError(2, "No such file", path) : error;
    });
    this.afterRead?.(path);
    return data;
  }

  async realpath(path: string): Promise<string> { return this.path(path); }

  async write(path: string, data: Buffer, options: { mode?: number; exclusive?: boolean } = {}): Promise<void> {
    this.calls.push(`write ${path}`);
    const full = this.writeCheck(path);
    const exists = await lstat(full).then(() => true, () => false);
    if (!exists && this.denyEntries.has(this.folderOf(path))) throw denied(path);
    if (exists && options.exclusive) throw new SftpError(4, "Failure", path);
    await writeFile(full, data, { ...(options.mode !== undefined ? { mode: options.mode } : {}) }).catch((error: NodeJS.ErrnoException) => { throw missing(error, path); });
  }

  async rename(from: string, to: string): Promise<void> {
    this.calls.push(`rename ${from} ${to}`);
    if (this.denyEntries.has(this.folderOf(from)) || this.denyEntries.has(this.folderOf(to))) throw denied(to);
    await rename(this.writeCheck(from), this.writeCheck(to)).catch((error: NodeJS.ErrnoException) => { throw missing(error, from); });
  }

  async remove(path: string): Promise<void> {
    this.calls.push(`remove ${path}`);
    const full = this.writeCheck(path);
    if (this.denyEntries.has(this.folderOf(path))) throw denied(path);
    if (!(await lstat(full).then(() => true, () => false))) throw new SftpError(2, "No such file", path);
    await rm(full);
  }

  async mkdir(path: string, options: { mode?: number } = {}): Promise<void> {
    this.calls.push(`mkdir ${path}`);
    const full = this.writeCheck(path);
    if (this.denyEntries.has(this.folderOf(path))) throw denied(path);
    await mkdir(full, { ...(options.mode !== undefined ? { mode: options.mode } : {}) }).catch((error: NodeJS.ErrnoException) => { throw missing(error, dirname(path)); });
  }

  async rmdir(path: string): Promise<void> {
    this.calls.push(`rmdir ${path}`);
    await rm(this.writeCheck(path), { recursive: false });
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.calls.push(`chmod ${path} ${mode.toString(8)}`);
    await chmod(this.writeCheck(path), mode).catch((error: NodeJS.ErrnoException) => { throw missing(error, path); });
  }

  async setMtime(path: string, mtime: number): Promise<void> {
    this.calls.push(`setMtime ${path}`);
    await utimes(this.writeCheck(path), mtime, mtime);
  }

  async execStream(command: string, options: ServerExecStreamOptions = {}): Promise<ServerExecStream> {
    this.calls.push(`exec ${command}`);
    const child = spawn("/bin/sh", ["-c", command], { cwd: this.root, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: this.root } });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    options.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
    const done = new Promise<Omit<ServerExecResult, "stdout" | "truncated">>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal, stderr, timedOut: false }));
    });
    return { stdout: child.stdout, done };
  }

  async exec(command: string): Promise<ServerExecResult> {
    const stream = await this.execStream(command);
    const chunks: Buffer[] = [];
    for await (const chunk of stream.stdout) chunks.push(chunk as Buffer);
    const done = await stream.done;
    return { ...done, stdout: Buffer.concat(chunks).toString("utf8"), truncated: false };
  }

  async close(): Promise<void> {}
}
