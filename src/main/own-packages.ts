import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultGrantsFilePath } from "./extension-grants.js";
import { writePersistedJson } from "./persisted-json.js";

/** A package `tau_new_package` wrote, as the host saw it (ADR 0036, 2026-10-19 amendment). */
export interface OwnPackageRecord {
  id: string;
  /** The real folder the scaffold went into. */
  directory: string;
  /** The folder's inode then; a folder deleted and made again by hand is not the one the agent made. */
  ino?: number;
  /** The user turned it off, so a thread at Full access does not turn it back on. */
  off?: boolean;
  createdAt: number;
}

/** Next to the grants, in the same owner-only folder; nothing in a package folder can state this. */
export function ownPackagesFilePath(grantsFilePath = defaultGrantsFilePath()): string {
  return join(dirname(grantsFilePath), "own-packages.json");
}

async function readRecords(filePath: string): Promise<OwnPackageRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as { packages?: unknown };
    return Array.isArray(parsed.packages)
      ? parsed.packages.filter((entry): entry is OwnPackageRecord => Boolean(entry) && typeof entry === "object" && typeof (entry as OwnPackageRecord).id === "string" && typeof (entry as OwnPackageRecord).directory === "string")
      : [];
  } catch {
    return [];
  }
}

const same = (record: OwnPackageRecord, id: string, directory: string) => record.id === id && record.directory === directory;

/** Notes a folder `tau_new_package` just wrote. Only the host's scaffold calls this. */
export async function recordOwnPackage(filePath: string, made: { id: string; directory: string }): Promise<void> {
  const directory = await realpath(made.directory);
  const ino = (await stat(directory)).ino;
  const kept = (await readRecords(filePath)).filter((record) => record.id !== made.id && record.directory !== directory);
  await writePersistedJson(filePath, 1, { packages: [...kept, { id: made.id, directory, ...(ino ? { ino } : {}), createdAt: Date.now() }] });
}

/** The record for this package id in this folder, if the host wrote that folder. */
export async function findOwnPackage(filePath: string, id: string, directory: string): Promise<OwnPackageRecord | undefined> {
  const records = await readRecords(filePath);
  if (!records.some((record) => record.id === id)) return undefined;
  const real = await realpath(directory).catch(() => undefined);
  const record = real ? records.find((entry) => same(entry, id, real)) : undefined;
  if (!record) return undefined;
  if (record.ino && (await stat(real!)).ino !== record.ino) return undefined;
  return record;
}

/** Remembers whether the user turned an own package off. A package without a record is left alone. */
export async function markOwnPackageOff(filePath: string, id: string, directory: string, off: boolean): Promise<void> {
  const record = await findOwnPackage(filePath, id, directory);
  if (!record || Boolean(record.off) === off) return;
  const records = await readRecords(filePath);
  await writePersistedJson(filePath, 1, { packages: records.map((entry) => same(entry, id, record.directory) ? { ...entry, off } : entry) });
}
