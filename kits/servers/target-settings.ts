import { readTargetLevel, TARGET_LEVELS, type TargetLevel } from "./protocol.js";
import type { ServersStore, TargetFileSpec, TargetKey } from "./store.js";

/**
 * `target.json` of a target: what the user set for it on this machine. This
 * ticket writes the level for the agent's commands; the fields later tickets
 * add (source, host key) are kept on rewrite.
 */
export interface TargetFile extends Record<string, unknown> {
  level: TargetLevel;
}

export const TARGET_FILE: TargetFileSpec<TargetFile> = {
  name: "target.json",
  version: 1,
  decode(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const { version: _version, level, ...rest } = value as Record<string, unknown>;
    return { ...rest, level: readTargetLevel(level) };
  },
};

export async function readTargetFile(store: ServersStore, key: TargetKey): Promise<TargetFile> {
  return (await store.read(key, TARGET_FILE)) ?? { level: readTargetLevel(undefined) };
}

const queues = new Map<string, Promise<unknown>>();

/** Read, change, write, in call order per target. */
export function updateTargetFile(store: ServersStore, key: TargetKey, change: (file: TargetFile) => TargetFile): Promise<TargetFile> {
  const id = store.targetDir(key);
  const run = async () => {
    const next = change(await readTargetFile(store, key));
    await store.write(key, TARGET_FILE, next);
    return next;
  };
  const result = (queues.get(id) ?? Promise.resolve()).then(run, run);
  const settled = result.catch(() => undefined);
  queues.set(id, settled);
  void settled.then(() => { if (queues.get(id) === settled) queues.delete(id); });
  return result;
}

export function isTargetLevel(value: unknown): value is TargetLevel {
  return typeof value === "string" && (TARGET_LEVELS as readonly string[]).includes(value);
}
