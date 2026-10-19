import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { renameReplacing } from "./atomic-rename.js";
import { basename, dirname, join } from "node:path";

/** What every persisted store logs through; kept minimal so `console` satisfies it by default. */
export interface PersistedJsonLogger {
  warn(message: string, detail?: unknown): void;
}

const defaultLogger: PersistedJsonLogger = { warn: (message, detail) => console.warn(message, detail) };

// Writers must respect a failed read or a newer schema even if a caller ignores it.
const writeGuards = new Map<string, { error: unknown } | { version: number }>();
const writeFailures = new Set<string>();

export interface ReadPersistedJsonOptions<T> {
  /** The version this build knows how to write; a stored version above it is read-only. */
  expectedVersion: number;
  /** Decodes the parsed JSON (which may be a legacy shape) into `T`, or `undefined` if unrecognizable. */
  decode(value: unknown, version: number | undefined): T | undefined;
  logger?: PersistedJsonLogger;
  /** Credential stores must keep refusing corruption across restarts. Default: quarantine. */
  invalidJson?: "quarantine" | "reject";
}

export interface PersistedJsonRead<T> {
  data: T;
  version: number | undefined;
  /** A newer build wrote this file; writes with an older version are refused. */
  readOnly: boolean;
}

function storedVersion(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const version = (value as { version?: unknown }).version;
  return typeof version === "number" ? version : undefined;
}

/** Renames an unparsable file aside instead of silently discarding it. */
async function quarantine(path: string, logger: PersistedJsonLogger): Promise<void> {
  const target = `${path}.corrupt-${new Date().toISOString()}`;
  try {
    await rename(path, target);
    logger.warn(`${path} was not valid JSON; moved it to ${target} and starting empty.`);
  } catch (error) {
    logger.warn(`${path} was not valid JSON and could not be moved aside`, error);
    writeGuards.set(path, { error });
    throw error;
  }
}

/**
 * Reads and decodes a persisted JSON file. A missing file is not an error
 * (returns `undefined` quietly); an unparsable one is quarantined by default,
 * then also returns `undefined`. With `invalidJson: "reject"` it stays in
 * place and blocks writes until repaired and successfully read. Other read errors
 * reject and prevent writes until a successful read of that path.
 */
export async function readPersistedJson<T>(
  path: string,
  options: ReadPersistedJsonOptions<T>,
): Promise<PersistedJsonRead<T> | undefined> {
  const logger = options.logger ?? defaultLogger;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      writeGuards.delete(path);
      return undefined;
    }
    writeGuards.set(path, { error });
    throw error;
  }
  writeGuards.delete(path);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    if (options.invalidJson === "reject") {
      const error = new Error(`${path} is not valid JSON; refusing to reset it.`);
      writeGuards.set(path, { error });
      throw error;
    }
    await quarantine(path, logger);
    return undefined;
  }
  const version = storedVersion(value);
  if (version !== undefined && version > options.expectedVersion) writeGuards.set(path, { version });
  const decoded = options.decode(value, version);
  if (decoded === undefined) return undefined;
  const readOnly = version !== undefined && version > options.expectedVersion;
  if (readOnly) {
    logger.warn(`${path} is version ${version}, newer than this build's ${options.expectedVersion}; reading it best-effort.`);
  }
  return { data: decoded, version, readOnly };
}

export interface WritePersistedJsonOptions {
  logger?: PersistedJsonLogger;
  /** One line instead of indented, for a cache nobody reads by hand. */
  compact?: boolean;
}

// One write in flight per path at a time, across every caller of this module.
const writeQueues = new Map<string, Promise<void>>();

async function syncDirectory(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, "r");
  } catch (error) {
    // Node cannot open directories for syncing on Windows.
    if (process.platform === "win32" && ["EISDIR", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    await handle.close();
  }
}

async function writeOnce(path: string, version: number, data: Record<string, unknown>, compact = false): Promise<void> {
  const guard = writeGuards.get(path);
  if (guard && "error" in guard) throw guard.error;
  if (guard && "version" in guard && guard.version > version) {
    throw new Error(`${path} is version ${guard.version}; refusing to overwrite it with version ${version}`);
  }
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const contents = JSON.stringify({ version, ...data }, null, compact ? undefined : 2);
  const temp = join(dir, `${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameReplacing(temp, path);
    await chmod(path, 0o600).catch(() => undefined);
    await syncDirectory(dir);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Writes `{ version, ...data }` atomically: a temp file next to `path`, then
 * a rename, syncing the file and then its directory where supported. Concurrent
 * writes to the same path are serialized. Failures reject and warn once per path
 * until a write succeeds. Failed reads and newer schemas block writes.
 */
export function writePersistedJson<T extends Record<string, unknown>>(
  path: string,
  version: number,
  data: T,
  options: WritePersistedJsonOptions = {},
): Promise<void> {
  const logger = options.logger ?? defaultLogger;
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    try {
      await writeOnce(path, version, data, options.compact);
      writeFailures.delete(path);
    } catch (error) {
      if (!writeFailures.has(path)) {
        writeFailures.add(path);
        logger.warn(`failed to persist ${path}`, error);
      }
      throw error;
    }
  });
  writeQueues.set(path, next);
  void next.catch(() => undefined).finally(() => {
    if (writeQueues.get(path) === next) writeQueues.delete(path);
  });
  return next;
}
