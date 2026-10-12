import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function decode<T>(raw: string, path: string): T {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
    return value as T;
  } catch (cause) {
    throw new Error(`Cannot read JSON from ${path}`, { cause });
  }
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    if (missing(cause)) return undefined;
    throw new Error(`Cannot read ${path}`, { cause });
  }
  return decode<T>(raw, path);
}

export function readJsonSync<T>(path: string): T | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    if (missing(cause)) return undefined;
    throw new Error(`Cannot read ${path}`, { cause });
  }
  return decode<T>(raw, path);
}

// Reserve all paths before reading so a multi-file edit cannot lose a concurrent patch.
const edits = new Map<string, Promise<void>>();

export function editJsonFiles<T>(paths: readonly string[], edit: () => Promise<T>): Promise<T> {
  const keys = [...new Set(paths.map((path) => resolve(path)))];
  const previous = keys.map((key) => edits.get(key) ?? Promise.resolve());
  const next = Promise.all(previous).then(edit);
  const settled = next.then(() => undefined, () => undefined);
  for (const key of keys) edits.set(key, settled);
  void settled.then(() => {
    for (const key of keys) if (edits.get(key) === settled) edits.delete(key);
  });
  return next;
}

/** Call inside editJsonFiles, after every file needed by the edit has been read. */
export async function writeJson(path: string, data: unknown): Promise<void> {
  const contents = `${JSON.stringify(data, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    try {
      await handle.writeFile(contents, "utf8");
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
