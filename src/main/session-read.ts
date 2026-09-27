import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CURRENT_SESSION_VERSION, parseSessionEntries, SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import type { SessionLocks } from "./session-locks.js";

/**
 * Pi repairs a session file while it opens it: `SessionManager.open` rewrites
 * an older format in place (truncate and write), gives an empty file a new
 * header, and appends a newline to a last line without one. Against a session
 * another process is writing, the first two destroy lines. Tau reads through
 * here instead: Pi opens a file only when it would not repair it, or while
 * the caller holds the session's lock.
 */

const HEADER_SCAN_BYTES = 1024 * 1024;

function header(entries: readonly FileEntry[]): (FileEntry & { type: "session"; id: string; cwd?: unknown }) | undefined {
  const first = entries[0] as { type?: unknown; id?: unknown } | undefined;
  return first?.type === "session" && typeof first.id === "string" ? entries[0] as FileEntry & { type: "session"; id: string } : undefined;
}

/** The session as Pi would load it, migrated in memory; nothing is written, now or later. */
export function readSessionFile(path: string): SessionManager {
  const entries = parseSessionEntries(readFileSync(path, "utf8"));
  const first = header(entries);
  if (!first) throw new Error(`Session file is not a valid Pi session: ${path}`);
  const cwd = typeof first.cwd === "string" && first.cwd ? first.cwd : process.cwd();
  return SessionManager.inMemory(cwd, undefined, entries);
}

function readHeaderLine(fd: number): string | undefined {
  const buffer = Buffer.alloc(64 * 1024);
  let text = "";
  for (let offset = 0; offset < HEADER_SCAN_BYTES;) {
    const read = readSync(fd, buffer, 0, buffer.length, offset);
    if (read === 0) return text;
    text += buffer.toString("utf8", 0, read);
    const end = text.indexOf("\n");
    if (end >= 0) return text.slice(0, end);
    offset += read;
  }
  return undefined;
}

/** Whether `SessionManager.open` would write to this file. Undecidable counts as yes. */
export function piRewritesOnOpen(path: string): boolean {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return false; }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    if (last[0] !== 0x0a) return true;
    const line = readHeaderLine(fd);
    if (line === undefined) return true;
    let parsed: { type?: unknown; version?: unknown };
    try { parsed = JSON.parse(line) as typeof parsed; } catch { return false; }
    // Pi refuses a file that does not start with a header, without writing.
    if (parsed.type !== "session") return false;
    const version = typeof parsed.version === "number" ? parsed.version : 1;
    return version < CURRENT_SESSION_VERSION;
  } finally {
    closeSync(fd);
  }
}

/** `SessionManager.open` with this host holding the session, so a repair Pi makes on open races nobody. */
export function openSessionLocked(locks: SessionLocks, path: string, sessionDir?: string, cwd?: string): Promise<SessionManager> {
  return locks.hold(path, "open", () => SessionManager.open(path, sessionDir, cwd));
}

function headerCwd(path: string): string | undefined {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return undefined; }
  try {
    const line = readHeaderLine(fd);
    const parsed = line ? JSON.parse(line) as { type?: unknown; id?: unknown; cwd?: unknown } : undefined;
    if (parsed?.type !== "session" || typeof parsed.id !== "string") return undefined;
    return typeof parsed.cwd === "string" ? parsed.cwd : "";
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * `SessionManager.continueRecent` without its unlocked open: the newest
 * session of `cwd` (every session of the folder, unless a shared sessions
 * folder is set), opened while this host holds it, or a new one.
 */
export async function openRecentSession(locks: SessionLocks, cwd: string, sessionsDir: string | undefined): Promise<SessionManager> {
  const fresh = SessionManager.create(cwd, sessionsDir);
  const dir = fresh.getSessionDir();
  const wanted = resolve(cwd);
  let newest: { path: string; mtime: number } | undefined;
  let names: string[] = [];
  try { names = readdirSync(dir).filter((name) => name.endsWith(".jsonl")); } catch { /* no folder yet */ }
  for (const name of names) {
    const path = join(dir, name);
    const owner = headerCwd(path);
    if (owner === undefined) continue;
    if (sessionsDir !== undefined && (!owner || resolve(owner) !== wanted)) continue;
    let mtime: number;
    try { mtime = statSync(path).mtimeMs; } catch { continue; }
    if (!newest || mtime > newest.mtime) newest = { path, mtime };
  }
  return newest ? openSessionLocked(locks, newest.path, dir, cwd) : fresh;
}
