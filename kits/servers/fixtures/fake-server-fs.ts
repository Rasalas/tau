import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerCapabilities } from "../protocol";
import { ServerPathError, type ServerEntry, type ServerExecResult, type ServerExecStream, type ServerExecStreamOptions, type ServerFs, type ServerStat } from "../server-fs";
import { SftpError } from "../sftp-client";

const statOf = (info: Stats): ServerStat => ({
  type: info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
  size: info.size,
  mtime: Math.floor(info.mtimeMs / 1000),
  mode: info.mode & 0o7777,
});

/**
 * A server target backed by a local folder, for sync tests without ssh.
 * `shell` adds exec over `/bin/sh` in that folder, as a server with a shell has.
 * Every call lands in `calls`; `.git` and `..` are refused like the real transport.
 */
export class FolderServerFs implements ServerFs {
  readonly caps: ServerCapabilities;
  readonly scratch = undefined;
  readonly calls: string[] = [];
  /** Folders whose listing the "server" refuses (permission denied). */
  readonly refuse = new Set<string>();

  constructor(readonly root: string, options: { shell?: boolean } = {}) {
    // Without a shell the sync code never calls exec: it goes by `caps`.
    const shell = options.shell ?? false;
    this.caps = { exec: shell, hash: shell, atomicRename: true, chmod: true, mtimeSet: true };
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
    return readFile(this.path(path)).catch((error: NodeJS.ErrnoException) => {
      throw error.code === "ENOENT" ? new SftpError(2, "No such file", path) : error;
    });
  }

  async realpath(path: string): Promise<string> { return this.path(path); }
  async write(): Promise<void> { throw new Error("read-only fake"); }
  async rename(): Promise<void> { throw new Error("read-only fake"); }
  async remove(): Promise<void> { throw new Error("read-only fake"); }
  async mkdir(): Promise<void> { throw new Error("read-only fake"); }
  async rmdir(): Promise<void> { throw new Error("read-only fake"); }
  async chmod(): Promise<void> { throw new Error("read-only fake"); }
  async setMtime(): Promise<void> { throw new Error("read-only fake"); }

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
