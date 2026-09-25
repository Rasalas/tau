import { execFile } from "node:child_process";
import { readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "tau/host-extension";

/**
 * One JSON file of a target's folder: its name, the version this build writes, and how to read it.
 * The tickets that own a file bring its spec (target.json, deployments.json, trust.json).
 */
export interface TargetFileSpec<T extends Record<string, unknown>> {
  name: `${string}.json`;
  version: number;
  decode(value: unknown, version: number | undefined): T | undefined;
}

export interface TargetKey {
  /** The workspace id of the main checkout, so every worktree of a project shares its targets. */
  workspaceId: string;
  targetId: string;
}

// One path segment each: no separators, no dot-names, nothing a path join could climb out of.
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/u;

export function isStoreSegment(value: unknown): value is string {
  return typeof value === "string" && SEGMENT.test(value);
}

function checked(key: TargetKey): TargetKey {
  if (!isStoreSegment(key.workspaceId)) throw new Error(`Not a workspace id the servers store keeps: ${JSON.stringify(key.workspaceId)}`);
  if (!isStoreSegment(key.targetId)) throw new Error(`Not a target id: ${JSON.stringify(key.targetId)}`);
  return key;
}

/**
 * The Servers kit's state, all of it under the kit's `stateDir` and none in the
 * project (ADR 0028): `targets/<workspaceId>/<targetId>/` holds `target.json`,
 * `deployments.json`, `trust.json` and the shadow repository `mirror.git`.
 * Folders are 0700, files 0600 and written atomically.
 */
export class ServersStore {
  readonly targetsDir: string;

  constructor(stateDir: string, private readonly logger: PersistedJsonLogger) {
    this.targetsDir = join(stateDir, "targets");
  }

  targetDir(key: TargetKey): string {
    const { workspaceId, targetId } = checked(key);
    return join(this.targetsDir, workspaceId, targetId);
  }

  /** The bare shadow repository that holds the mirror state; created by whoever first writes it. */
  mirrorDir(key: TargetKey): string {
    return join(this.targetDir(key), "mirror.git");
  }

  async read<T extends Record<string, unknown>>(key: TargetKey, spec: TargetFileSpec<T>): Promise<T | undefined> {
    const read = await readPersistedJson(join(this.targetDir(key), spec.name), { expectedVersion: spec.version, decode: spec.decode, logger: this.logger });
    return read?.data;
  }

  /** Queued in call order per file, so the last call's data is what stays; creates the folders at 0700. */
  write<T extends Record<string, unknown>>(key: TargetKey, spec: TargetFileSpec<T>, data: T): Promise<void> {
    let path: string;
    try { path = join(this.targetDir(key), spec.name); } catch (error) { return Promise.reject(error); }
    return writePersistedJson(path, spec.version, data, { logger: this.logger });
  }

  /** The workspace ids with a folder of targets. */
  async workspaces(): Promise<string[]> {
    const entries = await readdir(this.targetsDir, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory() && isStoreSegment(entry.name)).map((entry) => entry.name).sort();
  }

  /** The target ids a workspace has a folder for. */
  async targets(workspaceId: string): Promise<string[]> {
    if (!isStoreSegment(workspaceId)) return [];
    const entries = await readdir(join(this.targetsDir, workspaceId), { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory() && isStoreSegment(entry.name)).map((entry) => entry.name).sort();
  }

  /** Forgets a target with its history and its mirror. */
  async remove(key: TargetKey): Promise<void> {
    await rm(this.targetDir(key), { recursive: true, force: true });
  }
}

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

const runGit: GitRunner = (cwd, args) => new Promise((done, fail) => {
  execFile("git", args, { cwd, encoding: "utf8", timeout: 10_000 }, (error, stdout) => (error ? fail(error) : done(stdout)));
});

/**
 * The folder whose workspace id keys a project's targets: the main checkout of
 * a Git repository (a linked worktree resolves to it, a bare repository to
 * itself), else the folder itself. Git lists the main worktree first. A folder
 * below a checkout's top keeps its place in the main checkout, and is its own
 * key where the main checkout has no such folder (a folder inside another
 * repository's ignored files, such as a project about to get its own Git).
 */
export async function mainCheckoutOf(cwd: string, git: GitRunner = runGit): Promise<string> {
  const own = await realpath(cwd).catch(() => resolve(cwd));
  const listing = await git(cwd, ["worktree", "list", "--porcelain"]).catch(() => "");
  const first = /^worktree (.+)$/mu.exec(listing)?.[1];
  if (!first) return own;
  const main = await realpath(resolve(cwd, first)).catch(() => resolve(cwd, first));
  const top = (await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
  const below = top ? relative(await realpath(top).catch(() => top), own) : "";
  if (!below || below.startsWith("..") || isAbsolute(below)) return main;
  return realpath(join(main, below)).catch(() => own);
}

/** The key's workspace id for `cwd`, minted by the host for the main checkout. */
export async function ownerWorkspaceId(cwd: string, workspaceRef: (path: string) => { workspaceId: string }, git: GitRunner = runGit): Promise<string> {
  return workspaceRef(await mainCheckoutOf(cwd, git)).workspaceId;
}
