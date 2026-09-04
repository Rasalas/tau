import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** What every persisted store logs through; kept minimal so `console` satisfies it by default. */
export interface PersistedJsonLogger {
  warn(message: string, detail?: unknown): void;
}

const defaultLogger: PersistedJsonLogger = { warn: (message, detail) => console.warn(message, detail) };

export interface ReadPersistedJsonOptions<T> {
  /** The version this build knows how to write; a stored version above it is read-only. */
  expectedVersion: number;
  /** Decodes the parsed JSON (which may be a legacy shape) into `T`, or `undefined` if unrecognizable. */
  decode(value: unknown, version: number | undefined): T | undefined;
  logger?: PersistedJsonLogger;
}

export interface PersistedJsonRead<T> {
  data: T;
  version: number | undefined;
  /** A newer build wrote this file; never persist it back without a real mutation. */
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
  }
}

/**
 * Reads and decodes a persisted JSON file. A missing file is not an error
 * (returns `undefined` quietly); an unparsable one is quarantined so it is
 * never silently discarded, then also returns `undefined`.
 */
export async function readPersistedJson<T>(
  path: string,
  options: ReadPersistedJsonOptions<T>,
): Promise<PersistedJsonRead<T> | undefined> {
  const logger = options.logger ?? defaultLogger;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    await quarantine(path, logger);
    return undefined;
  }
  const version = storedVersion(value);
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
}

// One write in flight per path at a time, across every caller of this module.
const writeQueues = new Map<string, Promise<void>>();

async function writeOnce(path: string, version: number, data: Record<string, unknown>, logger: PersistedJsonLogger): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const contents = JSON.stringify({ version, ...data }, null, 2);
  const temp = join(dir, `${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    logger.warn(`failed to persist ${path}`, error);
    throw error;
  }
}

/**
 * Writes `{ version, ...data }` atomically: a temp file next to `path`, then
 * a rename. Concurrent writes to the same path are serialized so the file on
 * disk always ends up as the last call's value, never a torn mix of two.
 */
export function writePersistedJson<T extends Record<string, unknown>>(
  path: string,
  version: number,
  data: T,
  options: WritePersistedJsonOptions = {},
): Promise<void> {
  const logger = options.logger ?? defaultLogger;
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => writeOnce(path, version, data, logger));
  writeQueues.set(path, next);
  void next.catch(() => undefined).finally(() => {
    if (writeQueues.get(path) === next) writeQueues.delete(path);
  });
  return next;
}
