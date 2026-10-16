import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { DeployFilePlan, DeployOp, DeploymentFailure, DeploymentFile } from "../deploy-protocol.js";
import type { ServerFs, ServerStat } from "../server-fs.js";
import { isNoSuchFile, SFTP_STATUS, SftpError } from "../sftp-client.js";
import { blobId, entryOf, type Mirror, type MirrorEntry } from "./mirror.js";

/*
 * Writing to a server (plan §1.2), for an upload and for undoing one (I11).
 * Each chosen file is read again first: that read decides the three-way
 * outcome and is the backup, kept as a blob in the shadow repository before
 * anything is written. A file goes up as `.<name>.tau-<rand>` in its folder
 * and is renamed over the old one (`posix-rename`), keeping the old mode;
 * where the folder takes no new file, it is rewritten in place.
 *
 * Race left open: between the last stat and the rename a server-side writer
 * can still change a file. The kit's queue keeps Tau's own operations apart.
 */

/** The change one file should get, against what the server is expected to hold. */
export interface DeployIntent {
  path: string;
  op: DeployOp;
  /** What goes up; absent for a deletion. */
  content?: Buffer;
  /** The mode of a file the server does not have yet. */
  newMode: number;
  /** The blob the change was made against (the mirror state's); `null`: no file was there. */
  expect: string | null | undefined;
  /** The user confirmed overwriting a server that changed meanwhile. */
  force?: boolean;
}

/** The server's file as read now. */
export type ServerFileNow =
  | { kind: "file"; stat: ServerStat; data: Buffer; entry: MirrorEntry }
  | { kind: "absent" }
  | { kind: "other"; stat: ServerStat };

export async function readServerFile(fs: ServerFs, path: string, signal?: AbortSignal): Promise<ServerFileNow> {
  const options = { area: "project" as const, ...(signal ? { signal } : {}) };
  let stat: ServerStat;
  try {
    stat = await fs.stat(path, options);
  } catch (error) {
    if (isNoSuchFile(error)) return { kind: "absent" };
    throw error;
  }
  if (stat.type !== "file") return { kind: "other", stat };
  const data = await fs.read(path, options);
  return { kind: "file", stat, data, entry: entryOf(data, stat) };
}

export type ThreeWay = "apply" | "same" | "conflict";

/** base = what the change was made against, theirs = the server now, ours = what goes up (`null`: no file). */
export function threeWay(base: string | null, theirs: string | null, ours: string | null): ThreeWay {
  if (theirs === ours) return "same";
  if (theirs === base) return "apply";
  return "conflict";
}

/** One intent after the server was read. */
export interface InspectedIntent {
  intent: DeployIntent;
  now: ServerFileNow;
  plan: DeployFilePlan;
}

const stampOf = (stat: ServerStat) => ({ size: stat.size, mtime: stat.mtime, mode: stat.mode });

/**
 * Reads each intent's file on the server and decides its outcome. With
 * `mirror`, what was read and what would go up become blobs there first.
 */
export async function inspectIntents(fs: ServerFs, intents: readonly DeployIntent[], options: { mirror?: Mirror; signal?: AbortSignal } = {}): Promise<InspectedIntent[]> {
  const inspected: InspectedIntent[] = [];
  for (const intent of intents) {
    options.signal?.throwIfAborted();
    const now = await readServerFile(fs, intent.path, options.signal);
    if (options.mirror) {
      if (now.kind === "file") await options.mirror.writeBlob(now.data);
      if (intent.content) await options.mirror.writeBlob(intent.content);
    }
    const base = { path: intent.path, op: intent.expect === undefined && now.kind === "file" && intent.op !== "delete" ? "modify" as const : intent.op, ...(now.kind !== "absent" ? { server: stampOf(now.stat) } : {}) };
    if (now.kind === "other") {
      inspected.push({ intent, now, plan: { ...base, outcome: "blocked", reason: `On the server this is a ${now.stat.type}, not a file; Tau does not replace it.` } });
      continue;
    }
    const theirs = now.kind === "file" ? now.entry.oid : null;
    const ours = intent.op === "delete" ? null : blobId(intent.content ?? Buffer.alloc(0));
    const way = threeWay(intent.expect === undefined ? theirs : intent.expect, theirs, ours);
    let plan: DeployFilePlan;
    if (way === "same") plan = { ...base, outcome: intent.op === "delete" ? "gone" : "same" };
    else if (way === "apply") plan = { ...base, outcome: intent.op === "delete" ? "delete" : "upload" };
    else plan = { ...base, outcome: "conflict", reason: conflictReason(intent, theirs), ...(intent.force ? { forced: true } : {}) };
    inspected.push({ intent, now, plan });
  }
  return inspected;
}

function conflictReason(intent: DeployIntent, theirs: string | null): string {
  if (theirs === null) return "Deleted on the server since Tau last read it.";
  if (intent.expect === null) return "A file of this name appeared on the server since Tau last read it.";
  return "Changed on the server since Tau last read it.";
}

/** Whether an outcome writes to the server. */
export const writes = (plan: DeployFilePlan) => plan.outcome === "upload" || plan.outcome === "delete" || (plan.outcome === "conflict" && plan.forced === true);

const lostConnection = (error: unknown): boolean => (error instanceof AggregateError && error.errors.some(lostConnection))
  || (error instanceof SftpError && (error.code === SFTP_STATUS.CONNECTION_LOST || error.code === SFTP_STATUS.NO_CONNECTION))
  || (error instanceof Error && (error.name === "SshConnectError" || error.name === "AbortError"));

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface ApplyOptions {
  /** Mode of folders Tau creates (sftp.json `dirPerm`). */
  dirMode: number;
  signal?: AbortSignal;
}

/** What `applyIntents` did: the files that went through, with their new state, and the ones that failed. */
export interface AppliedIntents {
  applied: Array<{ file: DeploymentFile; entry: MirrorEntry | null }>;
  failed: DeploymentFailure[];
  /** Changed on the server between the read and the write; left alone. */
  raced: DeployFilePlan[];
}

/**
 * Writes the inspected intents that should go, one by one. A file whose
 * stat moved since it was read is left alone as a conflict; a failure is
 * reported and the rest goes on, unless the connection itself is gone.
 */
export async function applyIntents(fs: ServerFs, inspected: readonly InspectedIntent[], options: ApplyOptions): Promise<AppliedIntents> {
  const result: AppliedIntents = { applied: [], failed: [], raced: [] };
  const folders = new Set<string>();
  for (const { intent, now, plan } of inspected) {
    if (!writes(plan)) continue;
    if (options.signal?.aborted) {
      result.failed.push({ path: intent.path, op: intent.op, message: "The upload was stopped." });
      continue;
    }
    try {
      const moved = await movedSince(fs, intent.path, now, options.signal);
      if (moved) {
        result.raced.push({ ...plan, outcome: "conflict", reason: "Changed on the server during the upload.", forced: false });
        continue;
      }
      const before = now.kind === "file" ? { before: now.entry.oid, beforeMode: now.stat.mode } : {};
      if (intent.op === "delete") {
        if (now.kind === "file") await fs.remove(intent.path, { area: "project", ...(options.signal ? { signal: options.signal } : {}) });
        result.applied.push({ file: { path: intent.path, op: "delete", ...before }, entry: null });
        continue;
      }
      const data = intent.content ?? Buffer.alloc(0);
      const mode = now.kind === "file" ? now.stat.mode : intent.newMode;
      const written = await writeServerFile(fs, intent.path, data, { mode, existing: now.kind === "file", dirMode: options.dirMode, folders, ...(options.signal ? { signal: options.signal } : {}) });
      const entry = entryOf(data, written.stat);
      result.applied.push({ file: { path: intent.path, op: now.kind === "file" ? "modify" : "add", ...before, after: entry.oid, mode: written.stat.mode, written: written.via }, entry });
    } catch (error) {
      result.failed.push({ path: intent.path, op: intent.op, message: message(error) });
      if (lostConnection(error)) {
        for (const rest of inspected.slice(inspected.findIndex((item) => item.intent === intent) + 1)) {
          if (writes(rest.plan)) result.failed.push({ path: rest.intent.path, op: rest.intent.op, message: "Not tried: the connection to the server was lost." });
        }
        break;
      }
    }
  }
  return result;
}

async function movedSince(fs: ServerFs, path: string, then: ServerFileNow, signal?: AbortSignal): Promise<boolean> {
  let stat: ServerStat | undefined;
  try {
    stat = await fs.stat(path, { area: "project", ...(signal ? { signal } : {}) });
  } catch (error) {
    if (!isNoSuchFile(error)) throw error;
  }
  if (then.kind === "absent") return stat !== undefined;
  if (!stat) return true;
  return stat.type !== then.stat.type || stat.size !== then.stat.size || stat.mtime !== then.stat.mtime;
}

/** Creates the folders above `path` that the server lacks, each with `mode`. */
export async function ensureServerFolders(fs: ServerFs, path: string, mode: number, known: Set<string>, signal?: AbortSignal): Promise<void> {
  const options = { area: "project" as const, ...(signal ? { signal } : {}) };
  const parts = path.split("/").slice(0, -1);
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const folder = parts.slice(0, depth).join("/");
    if (known.has(folder)) continue;
    let stat: ServerStat | undefined;
    try {
      stat = await fs.stat(folder, options);
    } catch (error) {
      if (!isNoSuchFile(error)) throw error;
    }
    if (stat && stat.type !== "directory") throw new Error(`${folder} is a ${stat.type} on the server, not a folder.`);
    if (!stat) {
      await fs.mkdir(folder, { ...options, mode });
      if (fs.caps.chmod) await fs.chmod(folder, mode, options).catch(() => undefined);
    }
    known.add(folder);
  }
}

export interface WriteServerFileOptions {
  /** The mode the file ends with: the old file's, or the one for a new file. */
  mode: number;
  /** The server has a file there now. */
  existing: boolean;
  dirMode: number;
  /** Folders known to exist, shared across one deployment. */
  folders?: Set<string>;
  signal?: AbortSignal;
}

/**
 * A temp file next to `path`, then a rename over it. Without an atomic rename
 * an existing file is rewritten in place; where the folder takes no new file
 * (no write permission there), too. Answers how it went and the new stat.
 */
export async function writeServerFile(fs: ServerFs, path: string, data: Buffer, options: WriteServerFileOptions): Promise<{ via: "rename" | "in-place"; stat: ServerStat }> {
  const call = { area: "project" as const, ...(options.signal ? { signal: options.signal } : {}) };
  await ensureServerFolders(fs, path, options.dirMode, options.folders ?? new Set(), options.signal);
  if (options.existing && !fs.caps.atomicRename) {
    return writeInPlace(fs, path, data, options);
  }
  const dir = posix.dirname(path);
  const temp = `${dir === "." ? "" : `${dir}/`}.${posix.basename(path)}.tau-${randomBytes(4).toString("hex")}`;
  let absent = false;
  try {
    try {
      await fs.write(temp, data, { ...call, mode: options.mode, exclusive: true });
    } catch (error) {
      if (error instanceof SftpError && error.code === SFTP_STATUS.PERMISSION_DENIED) {
        await fs.stat(temp, { area: "project" }).catch((statError: unknown) => { absent = isNoSuchFile(statError); });
        if (absent) return await writeInPlace(fs, path, data, options);
      }
      throw error;
    }
    // The server's umask may have narrowed the mode.
    if (fs.caps.chmod) await fs.chmod(temp, options.mode, call);
    const stat = await checkedStat(fs, temp, data.length, options.signal);
    await fs.rename(temp, path, call);
    return { via: "rename", stat };
  } catch (error) {
    if (!absent) {
      // Cleanup must still run after the upload's signal was cancelled.
      await fs.remove(temp, { area: "project" }).catch((cleanupError: unknown) => {
        if (!isNoSuchFile(cleanupError)) throw new AggregateError([error, cleanupError], `${message(error)} Could not remove temporary file ${temp}: ${message(cleanupError)}`, { cause: error });
      });
    }
    throw error;
  }
}

async function writeInPlace(fs: ServerFs, path: string, data: Buffer, options: WriteServerFileOptions): Promise<{ via: "in-place"; stat: ServerStat }> {
  const call = { area: "project" as const, ...(options.signal ? { signal: options.signal } : {}) };
  const before = options.existing ? await fs.read(path, call) : undefined;
  try {
    await fs.write(path, data, { ...call, mode: options.mode });
    if (!options.existing && fs.caps.chmod) await fs.chmod(path, options.mode, call).catch(() => undefined);
    return { via: "in-place", stat: await checkedStat(fs, path, data.length, options.signal) };
  } catch (error) {
    try {
      if (before) {
        await fs.write(path, before, { area: "project", mode: options.mode });
        await checkedStat(fs, path, before.length);
      } else {
        const exists = await fs.stat(path, { area: "project" }).then(() => true, (statError: unknown) => {
          if (!isNoSuchFile(statError)) throw statError;
          return false;
        });
        if (exists) await fs.remove(path, { area: "project" });
      }
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError], `${message(error)} Could not restore ${path}: ${message(recoveryError)}`, { cause: recoveryError });
    }
    throw error;
  }
}

async function checkedStat(fs: ServerFs, path: string, size: number, signal?: AbortSignal): Promise<ServerStat> {
  const stat = await fs.stat(path, { area: "project", ...(signal ? { signal } : {}) });
  if (stat.type !== "file" || stat.size !== size) throw new Error(`After the upload the server holds ${stat.size} bytes, not ${size}.`);
  return stat;
}
