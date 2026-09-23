import { execFile } from "node:child_process";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { HostCommandError, gitExecutable, readPersistedJson, writePersistedJson } from "tau/host-extension";
import { readBranchBase, worktreeParentOf } from "./agent-worktrees.js";
import { resolveDefaultBaseRef, type GitRunner } from "./workspace-git.js";
import {
  EMPTY_POLICY,
  anyRule,
  decodePolicy,
  evaluateWorktree,
  manualRemovalRefusal,
  patchPolicy,
  policyActive,
  rulesFor,
  type WorktreeFacts,
} from "./worktree-cleanup.js";
import type {
  CleanupPolicy,
  UiCleanupResult,
  UiStorageRemoval,
  UiStorageReport,
  UiStorageWorktree,
} from "./storage-protocol.js";

const execFileAsync = promisify(execFile);
const REGISTRY_VERSION = 1;
const POLICY_VERSION = 1;
const FETCH_TTL_MS = 5 * 60_000;
/** Deleted threads the index may still list while their hook runs. */
const DELETED_MEMORY = 200;

/** One worktree Tau made. The record is what makes it Tau's to remove. */
export interface WorktreeRecord {
  path: string;
  /** The repository's main checkout; `git worktree remove` runs there. */
  repository: string;
  branch?: string;
  createdAt: number;
  /** The last thread that worked here was deleted. */
  threadDeletedAt?: number;
  /** Removed by a sweep or by hand; a recreated folder clears it. */
  removedAt?: number;
}

export interface WorktreeStorageThread {
  sessionId: string;
  path: string;
  cwd: string;
}

export interface WorktreeStorageOptions {
  stateDir: string;
  runGit: GitRunner;
  sessions(): Promise<WorktreeStorageThread[]>;
  /** Whether the host holds a live runtime for a thread. */
  threadOpen(sessionId: string): boolean;
  hostCwd(): string;
  log(label: string, detail?: string): void;
  /** A worktree went away: the kit's Git cache for its repository is stale. */
  removed(repository: string): void;
  now?: () => number;
  /** Bytes a folder takes; `du` where there is one. */
  measure?: (path: string) => Promise<number | undefined>;
  /** Timestamps of files, for the inactivity clock. */
  modifiedAt?: (path: string) => Promise<number | undefined>;
  /** The state of a checkout's pull or merge request on the host, for the "merged" rule; undefined without one. */
  requestState?: (path: string) => Promise<"open" | "closed" | "merged" | undefined>;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function decodeRecords(value: unknown): WorktreeRecord[] {
  const list = Array.isArray(record(value).worktrees) ? record(value).worktrees as unknown[] : [];
  const records: WorktreeRecord[] = [];
  for (const entry of list) {
    const raw = record(entry);
    if (typeof raw.path !== "string" || !isAbsolute(raw.path) || typeof raw.repository !== "string" || !isAbsolute(raw.repository)) continue;
    const number = (key: string) => typeof raw[key] === "number" && Number.isFinite(raw[key]) ? raw[key] as number : undefined;
    records.push({
      path: raw.path,
      repository: raw.repository,
      ...(typeof raw.branch === "string" && raw.branch ? { branch: raw.branch } : {}),
      createdAt: number("createdAt") ?? 0,
      ...(number("threadDeletedAt") === undefined ? {} : { threadDeletedAt: number("threadDeletedAt") }),
      ...(number("removedAt") === undefined ? {} : { removedAt: number("removedAt") }),
    });
  }
  return records;
}

/** Removing a worktree deletes its `node_modules` too, which takes longer than a status read. */
export const storageGit: GitRunner = async (cwd, args, maxBuffer = 8 * 1024 * 1024) => {
  const { stdout } = await execFileAsync(gitExecutable(), ["-c", "core.quotePath=false", ...args], { cwd, maxBuffer, timeout: 5 * 60_000, windowsHide: true });
  return stdout;
};

async function realOrSelf(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function fileModifiedAt(path: string): Promise<number | undefined> {
  try { return (await stat(path)).mtimeMs; } catch { return undefined; }
}

/** `du -sk` where it exists; a walk that never follows a link otherwise. */
export async function measureFolder(path: string): Promise<number | undefined> {
  if (process.platform !== "win32") {
    try {
      const { stdout } = await execFileAsync("du", ["-sk", path], { timeout: 120_000, maxBuffer: 1024 * 1024 });
      const kilobytes = Number(stdout.trim().split(/\s+/u)[0]);
      if (Number.isFinite(kilobytes)) return kilobytes * 1024;
    } catch {
      // Fall through to the walk.
    }
  }
  let total = 0;
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) total += await lstat(full).then((info) => info.size).catch(() => 0);
    }
  };
  await walk(path);
  return total;
}

/**
 * The worktrees Tau made, what they cost on disk, and the sweep that removes
 * the ones the user's rules say are done. It only ever touches a worktree it
 * recorded, inside the repository's worktrees folder, through `git worktree
 * remove`; a sweep never forces one, and keeps every branch.
 */
export class WorktreeStorage {
  private records: WorktreeRecord[] = [];
  private policy: CleanupPolicy = EMPTY_POLICY;
  private loaded: Promise<void> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private sweeping: Promise<UiCleanupResult> | undefined;
  private readonly deletedThreads: string[] = [];
  private readonly fetched = new Map<string, number>();
  private lastSweep: { at: number; removed: string[] } | undefined;

  constructor(private readonly options: WorktreeStorageOptions) {}

  private get registryFile() { return join(this.options.stateDir, "worktrees.json"); }
  private get policyFile() { return join(this.options.stateDir, "cleanup-policy.json"); }
  private now() { return (this.options.now ?? Date.now)(); }

  load(): Promise<void> {
    this.loaded ??= (async () => {
      const [records, policy] = await Promise.all([
        readPersistedJson<WorktreeRecord[]>(this.registryFile, { expectedVersion: REGISTRY_VERSION, decode: decodeRecords }),
        readPersistedJson<CleanupPolicy>(this.policyFile, { expectedVersion: POLICY_VERSION, decode: decodePolicy }),
      ]);
      this.records = records?.data ?? [];
      this.policy = policy?.data ?? EMPTY_POLICY;
    })();
    return this.loaded;
  }

  private save(): Promise<void> {
    const worktrees = this.records.map((entry) => ({ ...entry }));
    this.saving = this.saving.then(() => writePersistedJson(this.registryFile, REGISTRY_VERSION, { worktrees }))
      .catch((error: unknown) => this.options.log("git.worktree.registry-failed", error instanceof Error ? error.message : String(error)));
    return this.saving;
  }

  async getPolicy(): Promise<CleanupPolicy> {
    await this.load();
    return this.policy;
  }

  async setPolicy(patch: unknown): Promise<CleanupPolicy> {
    await this.load();
    this.policy = patchPolicy(this.policy, patch);
    await writePersistedJson(this.policyFile, POLICY_VERSION, { ...this.policy });
    return this.policy;
  }

  async list(): Promise<WorktreeRecord[]> {
    await this.load();
    return this.records.map((entry) => ({ ...entry }));
  }

  /** Writes down a worktree Tau just made. */
  async remember(path: string, project: string, branch?: string): Promise<void> {
    await this.load();
    const repository = await this.repositoryOf(project);
    const next: WorktreeRecord = { path: resolve(path), repository, ...(branch ? { branch } : {}), createdAt: this.now() };
    this.records = [...this.records.filter((entry) => entry.path !== next.path), next];
    await this.save();
  }

  /** The folder is back (recreated for a thread): it counts again, and its clock starts over. */
  async restored(path: string): Promise<void> {
    await this.load();
    const target = resolve(path);
    const entry = this.records.find((candidate) => candidate.path === target);
    if (!entry?.removedAt) return;
    delete entry.removedAt;
    entry.createdAt = this.now();
    await this.save();
  }

  /** The picker removed it, with the user's consent; there is nothing left to track. */
  async forget(path: string): Promise<void> {
    await this.load();
    const target = resolve(path);
    if (!this.records.some((entry) => entry.path === target)) return;
    this.records = this.records.filter((entry) => entry.path !== target);
    await this.save();
  }

  /** A thread is gone; the worktree it worked in may be due. Answers whether a sweep should run. */
  async threadDeleted(sessionId: string, cwd: string): Promise<boolean> {
    await this.load();
    this.deletedThreads.push(sessionId);
    if (this.deletedThreads.length > DELETED_MEMORY) this.deletedThreads.splice(0, this.deletedThreads.length - DELETED_MEMORY);
    const real = await realOrSelf(cwd);
    let entry: WorktreeRecord | undefined;
    for (const candidate of this.records) {
      if (candidate.removedAt) continue;
      if (candidate.path === resolve(cwd) || await realOrSelf(candidate.path) === real) { entry = candidate; break; }
    }
    if (!entry) return false;
    entry.threadDeletedAt = this.now();
    await this.save();
    return rulesFor(this.policy, entry.repository).onThreadDelete;
  }

  async active(): Promise<boolean> {
    await this.load();
    return policyActive(this.policy);
  }

  private async repositoryOf(cwd: string): Promise<string> {
    const common = (await this.options.runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "")).trim();
    return common ? dirname(resolve(cwd, common)) : resolve(cwd);
  }

  private async threadsIn(path: string, threads: readonly WorktreeStorageThread[]): Promise<WorktreeStorageThread[]> {
    const real = await realOrSelf(path);
    const deleted = new Set(this.deletedThreads);
    const found: WorktreeStorageThread[] = [];
    for (const thread of threads) {
      if (deleted.has(thread.sessionId)) continue;
      if (resolve(thread.cwd) === resolve(path) || await realOrSelf(thread.cwd) === real) found.push(thread);
    }
    return found;
  }

  private async fetchOnce(repository: string): Promise<void> {
    const last = this.fetched.get(repository);
    if (last !== undefined && this.now() - last < FETCH_TTL_MS) return;
    this.fetched.set(repository, this.now());
    const remotes = (await this.options.runGit(repository, ["remote"]).catch(() => "")).split("\n").map((line) => line.trim()).filter(Boolean);
    if (!remotes.includes("origin")) return;
    await this.options.runGit(repository, ["fetch", "--prune", "origin"], 8 * 1024 * 1024).catch((error: unknown) =>
      this.options.log("git.worktree.cleanup-fetch-failed", error instanceof Error ? error.message.split("\n")[0] : String(error)));
  }

  /** Everything the rules ask about one worktree, read fresh from disk and Git. */
  async inspect(entry: WorktreeRecord, threads: readonly WorktreeStorageThread[]): Promise<WorktreeFacts & { branch?: string; threadIds: string[] }> {
    const git = this.options.runGit;
    const modifiedAt = this.options.modifiedAt ?? fileModifiedAt;
    const inside = await this.threadsIn(entry.path, threads);
    const threadIds = inside.map((thread) => thread.sessionId);
    const openThreads = inside.filter((thread) => this.options.threadOpen(thread.sessionId)).length;
    const base: WorktreeFacts & { threadIds: string[] } = {
      recorded: true,
      exists: false,
      insideWorktreesDir: false,
      linked: false,
      hostWorkspace: false,
      threads: inside.length,
      openThreads,
      threadDeleted: entry.threadDeletedAt !== undefined,
      dirtyFiles: 0,
      ignoredFiles: 0,
      unpushedCommits: 0,
      commitsBeyondBase: 0,
      integrated: false,
      lastActivityAt: entry.createdAt,
      threadIds,
    };
    const exists = await stat(entry.path).then((info) => info.isDirectory()).catch(() => false);
    if (!exists) return base;
    try {
      const real = await realOrSelf(entry.path);
      const parent = await worktreeParentOf(entry.repository, (cwd, args) => git(cwd, args));
      const insideWorktreesDir = isInside(await realOrSelf(parent), real);
      const dotGit = await lstat(join(entry.path, ".git")).then((info) => info.isFile()).catch(() => false);
      const listed = (await git(entry.repository, ["worktree", "list", "--porcelain"]))
        .split("\n\n")
        .map((block) => /^worktree (.+)$/mu.exec(block)?.[1])
        .filter((path): path is string => Boolean(path));
      const linkedPaths = await Promise.all(listed.slice(1).map(realOrSelf));
      const linked = dotGit && linkedPaths.includes(real);
      const hostWorkspace = await realOrSelf(this.options.hostCwd()) === real;
      const dirtyFiles = (await git(entry.path, ["status", "--porcelain", "-z", "--untracked-files=all"]))
        .split("\0").filter((line) => line.trim().length > 0).length;
      // Ignored files can hold secrets or local data; a dependency install is reproducible.
      const ignoredFiles = (await git(entry.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]))
        .split("\0").filter((path) => path !== "" && !/(?:^|\/)node_modules\/$/u.test(path)).length;
      const branch = (await git(entry.path, ["branch", "--show-current"]).catch(() => "")).trim() || undefined;
      const recordedBase = branch ? await readBranchBase(entry.path, branch, (cwd, args) => git(cwd, args)) : undefined;
      const defaultRef = await resolveDefaultBaseRef(entry.repository, git);
      const baseRef = recordedBase ?? defaultRef;
      // A count Git cannot answer is an inspection failure, never a zero.
      const count = async (args: string[]) => Number((await git(entry.path, ["rev-list", "--count", ...args])).trim()) || 0;
      const commitsBeyondBase = await count([`${baseRef}..HEAD`]);
      const unpushedCommits = await count(["HEAD", "--not", ...(branch ? [`--exclude=${branch}`] : []), "--branches", "--remotes"]);
      const integrated = await git(entry.path, ["merge-base", "--is-ancestor", "HEAD", defaultRef]).then(() => true, () => false);
      // Only asked when the rule could act on it: the host CLI is slower than Git.
      const askHost = !integrated && branch !== undefined && this.options.requestState !== undefined && rulesFor(this.policy, entry.repository).onMerge;
      const requestMerged = askHost ? await this.options.requestState!(entry.path).then((state) => state === "merged", () => false) : false;
      const headAt = Number((await git(entry.path, ["log", "-1", "--format=%ct"]).catch(() => "")).trim()) * 1000;
      const sessionTimes = await Promise.all(inside.map((thread) => modifiedAt(thread.path)));
      const lastActivityAt = Math.max(entry.createdAt, Number.isFinite(headAt) ? headAt : 0, ...sessionTimes.map((time) => time ?? 0));
      return {
        ...base,
        exists: true,
        insideWorktreesDir,
        linked,
        hostWorkspace,
        dirtyFiles,
        ignoredFiles,
        unpushedCommits,
        commitsBeyondBase,
        integrated,
        ...(requestMerged ? { requestMerged } : {}),
        lastActivityAt,
        ...(branch ? { branch } : {}),
      };
    } catch (error) {
      return { ...base, exists: true, inspectionError: error instanceof Error ? error.message.split("\n")[0] : String(error) };
    }
  }

  private async judge(entry: WorktreeRecord, threads: readonly WorktreeStorageThread[]) {
    const rules = rulesFor(this.policy, entry.repository);
    if (rules.onMerge) await this.fetchOnce(entry.repository);
    const facts = await this.inspect(entry, threads);
    return { facts, rules, verdict: evaluateWorktree(facts, rules, this.now()) };
  }

  /** The dry run the storage page shows: every recorded worktree, what it costs and what the rules say. */
  async report(options: { sizes?: boolean } = {}): Promise<UiStorageReport> {
    await this.load();
    const threads = await this.options.sessions();
    const measure = this.options.measure ?? measureFolder;
    const worktrees: UiStorageWorktree[] = [];
    for (const entry of this.records.filter((candidate) => !candidate.removedAt)) {
      const { facts, rules, verdict } = await this.judge(entry, threads);
      if (!facts.exists) continue;
      const sizeBytes = options.sizes === false ? undefined : await measure(entry.path);
      worktrees.push({
        path: entry.path,
        repository: entry.repository,
        repositoryName: basename(entry.repository),
        ...(facts.branch ?? entry.branch ? { branch: facts.branch ?? entry.branch } : {}),
        createdAt: entry.createdAt,
        lastActivityAt: facts.lastActivityAt,
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
        threadIds: facts.threadIds,
        dirtyFiles: facts.dirtyFiles,
        unpushedCommits: facts.unpushedCommits,
        commitsBeyondBase: facts.commitsBeyondBase,
        rules,
        verdict,
      });
    }
    const common = (await this.options.runGit(this.options.hostCwd(), ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "")).trim();
    const current = common ? dirname(resolve(this.options.hostCwd(), common)) : undefined;
    return {
      worktrees,
      totalBytes: worktrees.reduce((sum, tree) => sum + (tree.sizeBytes ?? 0), 0),
      policy: this.policy,
      ...(current ? { currentRepository: { path: current, name: basename(current) } } : {}),
      generatedAt: this.now(),
      ...(this.lastSweep ? { lastSweep: this.lastSweep } : {}),
    };
  }

  /**
   * Removes what is due. Each worktree is judged again right before it goes,
   * so a thread that opened or a file that changed since the report keeps it.
   * `paths` narrows the run to what a report showed.
   */
  sweep(paths?: readonly string[]): Promise<UiCleanupResult> {
    this.sweeping ??= this.sweepNow(paths).finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }

  private async sweepNow(paths?: readonly string[]): Promise<UiCleanupResult> {
    await this.load();
    const result: UiCleanupResult = { removed: [], kept: [] };
    const wanted = paths ? new Set(paths.map((path) => resolve(path))) : undefined;
    const candidates = this.records.filter((entry) => !entry.removedAt && (!wanted || wanted.has(entry.path)) && anyRule(rulesFor(this.policy, entry.repository)));
    if (candidates.length === 0) return result;
    const threads = await this.options.sessions();
    for (const entry of candidates) {
      const first = await this.judge(entry, threads);
      if (!first.verdict.remove) {
        if (wanted) result.kept.push({ path: entry.path, blockers: first.verdict.blockers });
        continue;
      }
      // The index may have moved while Git ran: a new thread keeps the worktree.
      const latest = await this.judge(entry, await this.options.sessions());
      if (!latest.verdict.remove) {
        result.kept.push({ path: entry.path, blockers: latest.verdict.blockers });
        continue;
      }
      try {
        // No --force: Git refuses a worktree with changes on its own, once more.
        await this.options.runGit(entry.repository, ["worktree", "remove", entry.path]);
      } catch (error) {
        this.options.log("git.worktree.cleanup-refused", `${entry.path}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        result.kept.push({ path: entry.path, blockers: ["inspection-failed"] });
        continue;
      }
      entry.removedAt = this.now();
      result.removed.push(entry.path);
      this.options.removed(entry.repository);
      this.options.log("git.worktree.cleanup", `${entry.path} (${latest.verdict.reasons.join(", ")})`);
    }
    if (result.removed.length > 0) {
      this.lastSweep = { at: this.now(), removed: result.removed };
      await this.save();
    }
    return result;
  }

  /**
   * The storage page's Remove. What the rules would never touch is refused;
   * uncommitted files, ignored files and unpushed commits are named first and
   * go only with `confirm`. The branch stays either way.
   */
  async removeByHand(path: string, confirm: boolean): Promise<UiStorageRemoval> {
    await this.load();
    const target = resolve(path);
    const entry = this.records.find((candidate) => candidate.path === target && !candidate.removedAt);
    if (!entry) throw new HostCommandError("Tau did not make this worktree, so it is not removed from here.");
    const facts = await this.inspect(entry, await this.options.sessions());
    const verdict = evaluateWorktree(facts, rulesFor(this.policy, entry.repository), this.now());
    const refusal = manualRemovalRefusal(verdict);
    if (refusal) throw new HostCommandError(REFUSALS[refusal]);
    const confirmable = verdict.blockers;
    if (confirmable.length > 0 && !confirm) {
      return { removed: false, confirm: confirmable, dirtyFiles: facts.dirtyFiles, unpushedCommits: facts.unpushedCommits };
    }
    await this.options.runGit(entry.repository, ["worktree", "remove", ...(confirmable.length > 0 ? ["--force"] : []), entry.path]);
    entry.removedAt = this.now();
    await this.save();
    this.options.removed(entry.repository);
    this.options.log("git.worktree.removed-by-hand", entry.path);
    return { removed: true };
  }
}

const REFUSALS: Record<string, string> = {
  "not-recorded": "Tau did not make this worktree, so it is not removed from here.",
  missing: "The worktree's folder is already gone.",
  "inspection-failed": "Git could not read this worktree; it is left alone.",
  "outside-worktrees-dir": "This worktree lies outside the repository's worktrees folder; it is left alone.",
  "not-linked": "This is not a linked worktree of its repository; it is left alone.",
  "host-workspace": "Tau has this worktree open; switch to another project first.",
  "thread-open": "A thread is still open in this worktree.",
};
