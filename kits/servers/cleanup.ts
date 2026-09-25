import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import type { DeploymentFile, DeploymentRecord } from "./deploy-protocol.js";
import { DRIFT_FILE } from "./drift.js";
import { deployRef, deployRefs, readDeployments, updateDeployments } from "./journal.js";
import { DEFAULT_RETENTION_COUNT, DEFAULT_RETENTION_DAYS, RETENTION_COUNT_KEY, RETENTION_DAYS_KEY } from "./protocol.js";
import type { HistoryCleanupResult } from "./rollback-protocol.js";
import type { SftpJsonTarget } from "./sftp-json.js";
import type { ServersStore, TargetKey } from "./store.js";
import { gitCall, gitOk, type GitCall } from "./sync/git.js";
import { MIRROR_REF, Mirror } from "./sync/mirror.js";
import { isSyncPath } from "./sync/paths.js";

/*
 * Cleaning up a target's history (plan §1.5): deployments beyond the
 * retention lose their journal entry and their ref, the log of recorded
 * server states is cut behind the oldest one kept, and `git gc --prune=now`
 * then drops what nothing reaches any more.
 *
 * The cut uses Git's `shallow` file rather than rewriting commits: the
 * commit behind the oldest kept state becomes a boundary without parents,
 * so every commit id in `index.json` and the journal stays valid. The
 * boundary itself stays, since the oldest kept state's diff needs it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const FIRST_SWEEP_MS = 5 * 60 * 1000;
/** Blobs another state file still names (drift imports), kept alive past a cut. */
export const KEEP_REF = "refs/tau/keep";

export interface Retention {
  days: number;
  count: number;
}

const positive = (value: unknown, fallback: number) => {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 1 ? number : fallback;
};

/** The retention settings, which Settings stores as strings. */
export function readRetention(values: Readonly<Record<string, unknown>> | undefined): Retention {
  return { days: positive(values?.[RETENTION_DAYS_KEY], DEFAULT_RETENTION_DAYS), count: positive(values?.[RETENTION_COUNT_KEY], DEFAULT_RETENTION_COUNT) };
}

const MODES: Record<string, number> = { "100644": 0o644, "100755": 0o755 };

/** A deployment commit's files, from its diff against the server before it. */
export function filesOfDiff(raw: string): DeploymentFile[] {
  const tokens = raw.split("\0");
  const files: DeploymentFile[] = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([AMDT])/u.exec(tokens[index]!);
    const path = tokens[index + 1]!;
    if (!match || !isSyncPath(path)) continue;
    const [, oldMode, newMode, before, after, change] = match;
    if (change === "A") files.push({ path, op: "add", after: after!, ...(MODES[newMode!] ? { mode: MODES[newMode!] } : {}) });
    else if (change === "D") files.push({ path, op: "delete", before: before!, ...(MODES[oldMode!] ? { beforeMode: MODES[oldMode!] } : {}) });
    else files.push({ path, op: "modify", before: before!, after: after!, ...(MODES[oldMode!] ? { beforeMode: MODES[oldMode!] } : {}), ...(MODES[newMode!] ? { mode: MODES[newMode!] } : {}) });
  }
  return files;
}

export interface CleanTargetOptions {
  store: ServersStore;
  key: TargetKey;
  git: GitCall;
  retention: Retention;
  now: Date;
  /** The target's folder in the project, for a deployment recorded after a crash. */
  context?: string;
  /** Run `git gc` even when nothing was dropped (the button). */
  force?: boolean;
}

/** One target's cleanup; the caller keeps other operations on the target out meanwhile. */
export async function cleanTarget(options: CleanTargetOptions): Promise<Omit<HistoryCleanupResult, "targetId">> {
  const { store, key, git, retention, now } = options;
  const result: Omit<HistoryCleanupResult, "targetId"> = { removed: [], adopted: [], truncated: false, gc: false };
  const mirror = new Mirror(store.mirrorDir(key), { git });
  if (!await access(join(mirror.dir, "HEAD")).then(() => true, () => false)) return result;
  const env = mirror.gitEnv();
  const run = (args: readonly string[], input?: string) => gitOk(git, args, { cwd: mirror.dir, env: { ...env, ...IDENTITY }, ...(input !== undefined ? { input } : {}) });
  const text = async (args: readonly string[], input?: string) => (await run(args, input)).toString("utf8");

  let records = await readDeployments(store, key);
  const refs = await deployRefs(git, mirror);
  const known = new Set(records.map((record) => record.seq));
  const context = options.context ?? records.at(-1)?.context ?? "";
  // A ref without a journal entry: a crash after the upload (a deployment commit) is recorded; a bare backup is kept below.
  const refTimes = new Map<number, number>();
  const adopted: DeploymentRecord[] = [];
  for (const [seq, commit] of refs) {
    if (known.has(seq)) continue;
    const [parents = "", time = "0", ...body] = (await text(["log", "-1", "--format=%P%x00%ct%x00%B", commit])).split("\0");
    refTimes.set(seq, Number(time) * 1000);
    const subject = body.join("\0").split("\n")[0] ?? "";
    const named = /^(Deployment|Rollback) (\d+):/u.exec(subject);
    const parent = parents.trim().split(" ").filter(Boolean);
    if (!named || Number(named[2]) !== seq || parent.length !== 1) continue;
    const files = filesOfDiff(await text(["diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", parent[0]!, commit]));
    if (files.length === 0) continue;
    const rollbackOf = /deployment (\d+) undone/u.exec(subject)?.[1];
    adopted.push({
      seq,
      kind: named[1] === "Rollback" ? "rollback" : "upload",
      ...(rollbackOf ? { rollbackOf: Number(rollbackOf) } : {}),
      at: new Date(Number(time) * 1000).toISOString(),
      origin: { actor: "user", via: "view" },
      checkout: { path: "" },
      context,
      files,
      failed: [],
      skipped: [],
      status: "uploaded",
      commit,
      mirrorCommit: commit,
      note: "Recovered: Tau stopped before it recorded this deployment in its journal.",
    });
  }
  if (adopted.length) {
    records = await updateDeployments(store, key, (current) => [...current.filter((record) => !adopted.some((entry) => entry.seq === record.seq)), ...adopted]);
    result.adopted = adopted.map((record) => record.seq).sort((a, b) => a - b);
  }

  // The newest deployments within the age; a bare backup only until a deployment went through after it.
  const young = (time: number | undefined) => time !== undefined && Number.isFinite(time) && now.getTime() - time <= retention.days * DAY_MS;
  const newest = [...records].sort((a, b) => b.seq - a.seq);
  const kept = new Set(newest.filter((record, rank) => rank < retention.count && young(Date.parse(record.at))).map((record) => record.seq));
  const last = newest[0]?.seq ?? 0;
  for (const seq of refs.keys()) if (!records.some((record) => record.seq === seq) && seq > last && young(refTimes.get(seq))) kept.add(seq);
  const removed = [...new Set([...records.map((record) => record.seq), ...refs.keys()])].filter((seq) => !kept.has(seq)).sort((a, b) => a - b);
  if (removed.length) {
    records = await updateDeployments(store, key, (current) => current.filter((record) => kept.has(record.seq)));
    for (const seq of removed) if (refs.has(seq)) await mirror.deleteRef(deployRef(seq));
    result.removed = removed;
  }

  // The log of recorded states, cut behind the oldest one kept.
  const head = await mirror.head();
  if (head) {
    const chain = (await text(["log", "--first-parent", "--format=%H %ct", MIRROR_REF])).split("\n").filter(Boolean).map((line) => {
      const [commit = "", time = "0"] = line.split(" ");
      return { commit, time: Number(time) * 1000 };
    });
    let oldest = 0;
    chain.forEach((entry, index) => { if (index < retention.count && young(entry.time)) oldest = Math.max(oldest, index); });
    for (const record of records) {
      const index = chain.findIndex((entry) => entry.commit === record.mirrorCommit || entry.commit === record.commit);
      if (index > oldest) oldest = index;
    }
    const boundary = chain[oldest + 1];
    if (boundary && oldest + 2 < chain.length) {
      const file = join(mirror.dir, "shallow");
      const existing = (await readFile(file, "utf8").catch(() => "")).split("\n").filter((line) => /^[0-9a-f]{40,64}$/u.test(line));
      await writeFile(file, `${[...new Set([boundary.commit, ...existing])].join("\n")}\n`);
      result.truncated = true;
    }
  }

  const keepChanged = await keepDriftBlobs(store, key, run, text);
  const loose = Number(/^count: (\d+)$/mu.exec(await text(["count-objects", "-v"]))?.[1] ?? 0);
  if (options.force || result.removed.length || result.adopted.length || result.truncated || keepChanged || loose > 0) {
    await run(["reflog", "expire", "--expire=now", "--all"]);
    // Git writes no commit-graph in a shallow repository and would keep a stale one naming pruned commits.
    await rm(join(mirror.dir, "objects", "info", "commit-graph"), { force: true });
    await rm(join(mirror.dir, "objects", "info", "commit-graphs"), { recursive: true, force: true });
    await run(["-c", "gc.writeCommitGraph=false", "gc", "--prune=now", "--quiet"]);
    result.gc = true;
  }
  return result;
}

const IDENTITY = { GIT_AUTHOR_NAME: "Tau", GIT_AUTHOR_EMAIL: "tau@localhost", GIT_COMMITTER_NAME: "Tau", GIT_COMMITTER_EMAIL: "tau@localhost" };

/** Points `refs/tau/keep` at a tree of the blobs `drift.json` names, so their diffs outlive a cut; answers whether it moved. */
async function keepDriftBlobs(store: ServersStore, key: TargetKey, run: (args: readonly string[], input?: string) => Promise<Buffer>, text: (args: readonly string[], input?: string) => Promise<string>): Promise<boolean> {
  const drift = await store.read(key, DRIFT_FILE).catch(() => undefined);
  const named = new Set<string>();
  for (const file of [...drift?.check?.files ?? [], ...(drift?.imports ?? []).flatMap((item) => item.files)]) {
    if (file.before) named.add(file.before);
    if (file.after) named.add(file.after);
  }
  const previous = (await text(["for-each-ref", "--format=%(objectname)", KEEP_REF])).trim();
  const present = named.size
    ? (await text(["cat-file", "--batch-check=%(objectname) %(objecttype)"], `${[...named].join("\n")}\n`)).split("\n").flatMap((line) => {
      const [oid, type] = line.split(" ");
      return type === "blob" && oid ? [oid] : [];
    }).sort()
    : [];
  if (present.length === 0) {
    if (!previous) return false;
    await run(["update-ref", "-d", KEEP_REF]);
    return true;
  }
  const tree = (await text(["mktree", "-z"], present.map((oid) => `100644 blob ${oid}\t${oid}\0`).join(""))).trim();
  if (previous && (await text(["rev-parse", `${previous}^{tree}`])).trim() === tree) return false;
  const commit = (await text(["commit-tree", "--no-gpg-sign", tree, "-m", "Blobs Tau still shows"])).trim();
  await run(["update-ref", KEEP_REF, commit]);
  return true;
}

export interface HistoryCleanupOptions {
  store: ServersStore;
  sync: { queue<T>(key: TargetKey, run: () => Promise<T>): Promise<T> };
  /** A project's targets, keyed by its main checkout. */
  list(cwd: string): Promise<{ project: { workspaceId: string }; targets: SftpJsonTarget[] }>;
  git?: GitCall;
  now?(): Date;
}

/** Cleans every target's history hourly, and a project's on the user's click. */
export class HistoryCleanup {
  private readonly git: GitCall;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sweeping: Promise<unknown> | undefined;
  private stopped = false;

  constructor(private readonly context: HostExtensionContext, private readonly options: HistoryCleanupOptions) {
    this.git = options.git ?? gitCall();
  }

  private async retention(): Promise<Retention> {
    return readRetention((await this.context.services.settings?.().catch(() => undefined))?.values);
  }

  private clean(key: TargetKey, retention: Retention, extra: { context?: string; force?: boolean } = {}): Promise<HistoryCleanupResult> {
    return this.options.sync.queue(key, async () => ({
      targetId: key.targetId,
      ...await cleanTarget({ store: this.options.store, key, git: this.git, retention, now: this.options.now?.() ?? new Date(), ...extra }),
    }));
  }

  /** Every target this machine keeps state for. */
  async sweep(): Promise<HistoryCleanupResult[]> {
    const retention = await this.retention();
    const results: HistoryCleanupResult[] = [];
    for (const workspaceId of await this.options.store.workspaces()) {
      for (const targetId of await this.options.store.targets(workspaceId)) {
        if (this.stopped) return results;
        try {
          results.push(await this.clean({ workspaceId, targetId }, retention));
        } catch (error) {
          this.context.services.log("servers.cleanup", `${targetId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return results;
  }

  /** `cleanup-history`: the project's targets now, `git gc` included. */
  async cleanProject(raw: unknown): Promise<{ targets: HistoryCleanupResult[] }> {
    const cwd = (raw as { cwd?: unknown } | undefined)?.cwd;
    if (typeof cwd !== "string" || !cwd) throw new HostCommandError("Open a project first.");
    const { project, targets } = await this.options.list(await this.context.services.knownWorkspacePath(cwd));
    const retention = await this.retention();
    const results: HistoryCleanupResult[] = [];
    for (const target of targets) results.push(await this.clean({ workspaceId: project.workspaceId, targetId: target.id }, retention, { context: target.context, force: true }));
    return { targets: results };
  }

  /** Hourly, the first run a few minutes after the host starts. */
  start(): void {
    const tick = (delay: number) => {
      this.timer = setTimeout(() => {
        this.sweeping = this.sweep().catch(() => undefined).finally(() => { if (!this.stopped) tick(HOUR_MS); });
      }, delay);
      this.timer.unref?.();
    };
    tick(FIRST_SWEEP_MS);
  }

  register(): void {
    this.context.registerCommand("cleanup-history", (input) => this.cleanProject(input), { long: true, audit: { label: "cleaned up a server's deployment history" } });
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.sweeping;
  }
}
