import { normalizeProjectPath, type Framework, type SecretFinding, type SecretKind, FRAMEWORKS, SECRET_KIND_LABELS } from "./live-config.js";
import type { ServersStore, TargetFileSpec, TargetKey } from "./store.js";

/** A live config the last scan found: path and kind, never the value. */
export interface LiveConfigEntry {
  path: string;
  kind: SecretKind;
  framework?: Framework;
}

/**
 * `trust.json` of a target. This ticket owns the upload block list and the
 * detected live configs; the command and network approvals (I12, I14) add
 * their fields, and fields this build does not know are kept on rewrite.
 */
export interface TrustFile extends Record<string, unknown> {
  /** Project-relative paths never uploaded and never shown as pending: override files and what the user adds. */
  uploadBlocklist: string[];
  liveConfigs: LiveConfigEntry[];
}

function isKind(value: unknown): value is SecretKind {
  return typeof value === "string" && Object.hasOwn(SECRET_KIND_LABELS, value);
}

function decodeEntry(value: unknown): LiveConfigEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { path, kind, framework } = value as Record<string, unknown>;
  const normalized = typeof path === "string" ? normalizeProjectPath(path) : undefined;
  if (normalized === undefined || !isKind(kind)) return undefined;
  return (FRAMEWORKS as readonly unknown[]).includes(framework) ? { path: normalized, kind, framework: framework as Framework } : { path: normalized, kind };
}

function sortedPaths(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

export const TRUST_FILE: TargetFileSpec<TrustFile> = {
  name: "trust.json",
  version: 1,
  decode(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const { version: _version, uploadBlocklist, liveConfigs, ...rest } = value as Record<string, unknown>;
    const paths = Array.isArray(uploadBlocklist) ? uploadBlocklist.flatMap((path) => (typeof path === "string" ? normalizeProjectPath(path) ?? [] : [])) : [];
    const entries = Array.isArray(liveConfigs) ? liveConfigs.flatMap((entry) => decodeEntry(entry) ?? []) : [];
    return { ...rest, uploadBlocklist: sortedPaths(paths), liveConfigs: entries };
  },
};

export function emptyTrust(): TrustFile {
  return { uploadBlocklist: [], liveConfigs: [] };
}

export async function readTrust(store: ServersStore, key: TargetKey): Promise<TrustFile> {
  return (await store.read(key, TRUST_FILE)) ?? emptyTrust();
}

// Read-modify-write per target in call order, so two quick changes both land.
const updates = new Map<string, Promise<unknown>>();

export function updateTrust(store: ServersStore, key: TargetKey, change: (trust: TrustFile) => TrustFile): Promise<TrustFile> {
  let dir: string;
  try { dir = store.targetDir(key); } catch (error) { return Promise.reject(error); }
  const run = async () => {
    const next = change(await readTrust(store, key));
    await store.write(key, TRUST_FILE, next);
    return next;
  };
  const result = (updates.get(dir) ?? Promise.resolve()).then(run, run);
  const settled = result.catch(() => undefined);
  updates.set(dir, settled);
  void settled.then(() => { if (updates.get(dir) === settled) updates.delete(dir); });
  return result;
}

/** Puts a project-relative path on the upload block list; rejects anything outside the project. */
export function blockUpload(store: ServersStore, key: TargetKey, path: string): Promise<TrustFile> {
  const normalized = normalizeProjectPath(path);
  if (normalized === undefined) return Promise.reject(new Error("Only a path inside the project can be kept local."));
  return updateTrust(store, key, (trust) => ({ ...trust, uploadBlocklist: sortedPaths([...trust.uploadBlocklist, normalized]) }));
}

export function unblockUpload(store: ServersStore, key: TargetKey, path: string): Promise<TrustFile> {
  const normalized = normalizeProjectPath(path);
  return updateTrust(store, key, (trust) => ({ ...trust, uploadBlocklist: trust.uploadBlocklist.filter((entry) => entry !== normalized) }));
}

/** One entry per path and kind; lines are left out since they move with every edit. */
export function liveConfigsOf(findings: ReadonlyArray<Pick<SecretFinding, "path" | "kind" | "framework">>): LiveConfigEntry[] {
  const byKey = new Map<string, LiveConfigEntry>();
  for (const finding of findings) {
    const entry = decodeEntry(finding);
    if (entry) byKey.set(`${entry.path}\0${entry.kind}`, entry);
  }
  return [...byKey.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/**
 * Stores a scan's result. With `paths`, only those paths were scanned and the
 * rest of the list stays; without, the scan covered the whole copy.
 */
export function recordLiveConfigs(store: ServersStore, key: TargetKey, findings: readonly SecretFinding[], paths?: Iterable<string>): Promise<TrustFile> {
  const scanned = paths ? new Set([...paths].flatMap((path) => normalizeProjectPath(path) ?? [])) : undefined;
  return updateTrust(store, key, (trust) => ({
    ...trust,
    liveConfigs: liveConfigsOf([
      ...(scanned ? trust.liveConfigs.filter((entry) => !scanned.has(entry.path)) : []),
      ...findings,
    ]),
  }));
}
