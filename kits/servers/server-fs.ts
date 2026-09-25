import { posix } from "node:path";
import type { ServerCapabilities } from "./protocol.js";

/*
 * What the Servers kit asks of a server, whichever transport reaches it (SSH
 * now, FTP later). An optional member is a capability the transport may lack;
 * `caps` says the same to the desktop, which hides what is missing.
 *
 * Paths are server paths. A relative one starts at the target's `remotePath`,
 * `~/tmp/…` at the scratch folder. Every path is resolved on the server and
 * refused unless it lies below `remotePath` or `~/tmp` (`area` narrows that),
 * and nothing below a `.git` folder is ever read or written.
 */

export type ServerFileType = "file" | "directory" | "symlink" | "other";

export interface ServerStat {
  type: ServerFileType;
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
  /** Permission bits only. */
  mode: number;
}

export interface ServerEntry extends ServerStat {
  name: string;
  /** Resolved absolute path on the server. */
  path: string;
}

/** `project`: below `remotePath`; `tmp`: below `~/tmp`; `any`: either. */
export type ServerArea = "any" | "project" | "tmp";

export interface ServerFsCallOptions {
  area?: ServerArea;
  signal?: AbortSignal;
}

export interface ServerExecOptions {
  /** `project` (the default) or `tmp`, or a path inside either. */
  cwd?: "project" | "tmp" | (string & {});
  timeoutMs?: number;
  /** Per stream; the rest is dropped and `truncated` set. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface ServerExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface ServerExecStreamOptions {
  cwd?: ServerExecOptions["cwd"];
  /** Fed to the command's stdin, then closed. */
  input?: Buffer | string;
  /** None by default: a download may take long. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A command whose stdout is read as it comes (a listing, a tar stream). */
export interface ServerExecStream {
  stdout: NodeJS.ReadableStream & AsyncIterable<Buffer>;
  /** Settles once the command ended; stderr capped. */
  done: Promise<Omit<ServerExecResult, "stdout" | "truncated">>;
}

export interface ServerFs {
  readonly caps: ServerCapabilities;
  /** `remotePath`, resolved. */
  readonly root: string;
  /** `~/tmp`, resolved; undefined when the server has none. */
  readonly scratch: string | undefined;
  list(dir: string, options?: ServerFsCallOptions): Promise<ServerEntry[]>;
  /** Does not follow a symlink at `path`. */
  stat(path: string, options?: ServerFsCallOptions): Promise<ServerStat>;
  read(path: string, options?: ServerFsCallOptions): Promise<Buffer>;
  /** Creates or replaces `path` in place; `mode` applies to a new file. */
  write(path: string, data: Buffer, options?: ServerFsCallOptions & { mode?: number; exclusive?: boolean }): Promise<void>;
  /** Replaces `to` when `caps.atomicRename`; else fails when `to` exists. */
  rename(from: string, to: string, options?: ServerFsCallOptions): Promise<void>;
  remove(path: string, options?: ServerFsCallOptions): Promise<void>;
  mkdir(path: string, options?: ServerFsCallOptions & { mode?: number }): Promise<void>;
  rmdir(path: string, options?: ServerFsCallOptions): Promise<void>;
  /** The resolved path, checked against the areas. */
  realpath(path: string, options?: ServerFsCallOptions): Promise<string>;
  chmod(path: string, mode: number, options?: ServerFsCallOptions): Promise<void>;
  setMtime(path: string, mtime: number, options?: ServerFsCallOptions): Promise<void>;
  exec?(command: string, options?: ServerExecOptions): Promise<ServerExecResult>;
  /** As `exec`, with stdin and a stdout that streams; present when `exec` is. */
  execStream?(command: string, options?: ServerExecStreamOptions): Promise<ServerExecStream>;
  /** SHA-256 per path that exists; missing ones are left out. */
  hashMany?(paths: readonly string[], options?: ServerFsCallOptions): Promise<Map<string, string>>;
  close(): Promise<void>;
}

export class ServerPathError extends Error {
  constructor(readonly path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = "ServerPathError";
  }
}

export function isWithin(path: string, root: string): boolean {
  const rel = posix.relative(root, path);
  return rel === "" || (!rel.startsWith("../") && rel !== ".." && !posix.isAbsolute(rel));
}

/** Below the root, a `.git` segment anywhere. */
export function touchesGit(path: string, root: string): boolean {
  return posix.relative(root, path).split("/").includes(".git");
}
