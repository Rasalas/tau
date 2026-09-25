import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import type { UiThreadOrigin } from "../shared/contracts.js";
import { ORIGIN_ENTRY, PARENT_LINK_ENTRY, originEntry } from "./session-lineage.js";

/**
 * A Pi session written on another machine, taken over as a thread of this
 * one: a new id, this machine's project folder in the header, and where it
 * came from as the entry right after the header. Every other entry is copied
 * as it was; paths inside tool results stay text.
 */

/** One entry larger than this is refused; screenshots in a transcript stay well below it. */
export const SESSION_IMPORT_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
/** A whole file larger than this is refused; it has to fit one host frame (112 MB) with room to spare. */
export const SESSION_IMPORT_MAX_BYTES = 96 * 1024 * 1024;

export interface SessionImportRequest {
  /** The project folder on this machine the thread continues in. */
  cwd: string;
  /** The session file as it was on the other machine. */
  jsonl: string;
  title?: string;
  /** The machine and thread it came from; `details` is stored beside them. */
  origin: UiThreadOrigin & { details?: Record<string, unknown> };
}

export interface SessionImportLimits {
  maxEntryBytes?: number;
  maxBytes?: number;
}

export interface RewrittenSession {
  text: string;
  /** Entries after the header, the origin entry included. */
  entryCount: number;
}

type Entry = Record<string, unknown> & { type: string; id: string; parentId: string | null };

function refuse(message: string): never {
  throw new Error(`Cannot import this session: ${message}`);
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function validOrigin(origin: SessionImportRequest["origin"] | undefined): UiThreadOrigin {
  const ok = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 200;
  if (!origin || !ok(origin.hostId) || !ok(origin.threadId)) refuse("its origin needs a host id and a thread id.");
  return { hostId: origin.hostId, threadId: origin.threadId };
}

/** An 8-hex entry id no entry of the file uses, the shape Pi gives its own. */
function freshEntryId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = randomBytes(4).toString("hex");
    if (!taken.has(id)) return id;
  }
}

/**
 * The session text as this machine writes it. Refuses a format version other
 * than the one this Pi writes, an entry or a file over the limits, and lines
 * that are not session entries. An origin or parent link the file already
 * carried belongs to its old machine and is dropped; its children move up.
 */
export function rewriteImportedSession(
  jsonl: string,
  options: {
    cwd: string;
    sessionId: string;
    timestamp: string;
    origin: SessionImportRequest["origin"];
    title?: string;
    limits?: SessionImportLimits;
  },
): RewrittenSession {
  const maxBytes = options.limits?.maxBytes ?? SESSION_IMPORT_MAX_BYTES;
  const maxEntryBytes = options.limits?.maxEntryBytes ?? SESSION_IMPORT_MAX_ENTRY_BYTES;
  const origin = validOrigin(options.origin);
  const totalBytes = Buffer.byteLength(jsonl, "utf8");
  if (totalBytes > maxBytes) refuse(`it is ${megabytes(totalBytes)}; the limit is ${megabytes(maxBytes)}.`);

  const lines = jsonl.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  const entries: Entry[] = [];
  let header: Record<string, unknown> | undefined;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const lineNumber = index + 1;
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > maxEntryBytes) refuse(`line ${lineNumber} is ${megabytes(bytes)}; an entry may be at most ${megabytes(maxEntryBytes)}.`);
    let value: unknown;
    try { value = JSON.parse(line); } catch { refuse(`line ${lineNumber} is not JSON.`); }
    if (!value || typeof value !== "object" || Array.isArray(value)) refuse(`line ${lineNumber} is not a session entry.`);
    const record = value as Record<string, unknown>;
    if (!header) {
      if (record.type !== "session") refuse("the first line is not a session header.");
      header = record;
      continue;
    }
    if (record.type === "session") refuse(`line ${lineNumber} is a second session header.`);
    if (typeof record.type !== "string" || typeof record.id !== "string" || !record.id
      || !(record.parentId === null || typeof record.parentId === "string")) {
      refuse(`line ${lineNumber} is not a session entry.`);
    }
    entries.push(record as Entry);
  }
  if (!header) refuse("the file is empty.");
  const version = header.version ?? 1;
  if (version !== CURRENT_SESSION_VERSION) {
    refuse(`it is session format ${String(version)}; this machine reads format ${CURRENT_SESSION_VERSION}. Update Tau on both machines.`);
  }

  const dropped = new Map<string, string | null>();
  const kept: Entry[] = [];
  for (const entry of entries) {
    const stale = entry.type === "custom" && (entry.customType === ORIGIN_ENTRY || entry.customType === PARENT_LINK_ENTRY);
    if (stale) dropped.set(entry.id, entry.parentId);
    else kept.push(entry);
  }
  const taken = new Set(entries.map((entry) => entry.id));
  const originId = freshEntryId(taken);
  taken.add(originId);
  const parentOf = (parentId: string | null): string => {
    let current = parentId;
    const seen = new Set<string>();
    while (current !== null && dropped.has(current) && !seen.has(current)) {
      seen.add(current);
      current = dropped.get(current) ?? null;
    }
    return current ?? originId;
  };

  const out: string[] = [JSON.stringify({
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: options.sessionId,
    timestamp: options.timestamp,
    cwd: options.cwd,
  })];
  const { details } = options.origin;
  out.push(JSON.stringify({
    type: "custom",
    customType: ORIGIN_ENTRY,
    data: originEntry(origin, details && typeof details === "object" ? details : {}),
    id: originId,
    parentId: null,
    timestamp: options.timestamp,
  }));
  for (const entry of kept) out.push(JSON.stringify({ ...entry, parentId: parentOf(entry.parentId) }));
  let leaf = kept.at(-1)?.id ?? originId;
  const title = options.title?.replace(/[\r\n]+/g, " ").trim();
  if (title) {
    const id = freshEntryId(taken);
    out.push(JSON.stringify({ type: "session_info", id, parentId: leaf, timestamp: options.timestamp, name: title }));
    leaf = id;
  }
  return { text: `${out.join("\n")}\n`, entryCount: out.length - 1 };
}

export interface ImportedSession {
  sessionId: string;
  path: string;
  cwd: string;
}

/**
 * Writes the rewritten session where Pi keeps this project's sessions and
 * returns it. The file appears whole or not at all, so a scan never lists half of it.
 */
export async function importSessionFile(
  request: SessionImportRequest,
  options: { sessionsDir: string | undefined; limits?: SessionImportLimits; now?: () => Date },
): Promise<ImportedSession> {
  if (typeof request.cwd !== "string" || !isAbsolute(request.cwd)) refuse("the project folder must be an absolute path.");
  const cwd = resolve(request.cwd);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) refuse(`there is no folder at ${cwd}.`);
  if (typeof request.jsonl !== "string") refuse("the session text is missing.");
  const sessionId = randomUUID();
  const date = options.now?.() ?? new Date();
  const timestamp = date.toISOString();
  const { text } = rewriteImportedSession(request.jsonl, {
    cwd,
    sessionId,
    timestamp,
    origin: request.origin,
    ...(request.title ? { title: request.title } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  // Pi's own layout decides the folder: one per project, or the override.
  const directory = SessionManager.create(cwd, options.sessionsDir, { id: sessionId }).getSessionDir();
  const path = join(directory, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  const partial = `${path}.importing`;
  try {
    await writeFile(partial, text, { flag: "wx" });
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return { sessionId, path, cwd };
}
