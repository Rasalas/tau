import { devNull } from "node:os";
import { HostCommandError, type HostExtensionContext, type UiDiffHunk, type UiFileDiff } from "tau/host-extension";
import {
  DRIFT_EVENT, driftBranchName,
  type DriftBaseline, type DriftFile, type DriftImport, type DriftImportResult, type DriftState, type DriftTarget,
} from "./drift-protocol.js";
import type { SftpJsonTarget } from "./sftp-json.js";
import type { ServersStore, TargetFileSpec, TargetKey } from "./store.js";
import { compareDrift } from "./sync/compare.js";
import { gitCall, gitOk, type GitCall } from "./sync/git.js";
import type { SyncIgnore } from "./sync/ignore.js";
import { entryOf, loadMirrorState, MIRROR_INDEX_FILE, saveMirrorState, sha256Of, type Mirror, type MirrorEntry, type MirrorState } from "./sync/mirror.js";
import { ancestors, hasGitSegment, isSyncPath } from "./sync/paths.js";
import type { DriftRow } from "./sync/protocol.js";
import { scanServer, type ServerListing } from "./sync/scan.js";
import type { SyncService, SyncSession } from "./sync/service.js";

/*
 * Server drift (ADR 0028, plan §1.4): what changed on the server since Tau last
 * read it becomes a commit on `server-drift/<date>` — parent HEAD, HEAD's tree
 * with only the drifted paths replaced or removed — written by Workspace Kit.
 * The checkout is never touched; merging is the user's click.
 */

export const WORKSPACE_KIT_ID = "tau.workspace";

/** A drift file with the blobs that let the view draw its diff without the server. */
interface StoredFile extends DriftFile {
  before?: string;
  after?: string;
}

interface StoredImport extends Omit<DriftImport, "files"> {
  files: StoredFile[];
}

interface DriftRecord extends Record<string, unknown> {
  check?: { at: string; baseline: DriftBaseline; files: StoredFile[]; later: boolean };
  error?: string;
  imports: StoredImport[];
}

const HEX = /^[0-9a-f]{40,64}$/u;
const oid = (value: unknown) => (typeof value === "string" && HEX.test(value) ? value : undefined);

function decodeStored(value: unknown): StoredFile | undefined {
  const raw = (value ?? {}) as Record<string, unknown>;
  if (typeof raw.path !== "string" || !isSyncPath(raw.path) || !["added", "modified", "deleted"].includes(raw.change as string)) return undefined;
  const before = oid(raw.before);
  const after = oid(raw.after);
  return { path: raw.path, change: raw.change as DriftFile["change"], certain: raw.certain !== false, ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

const storedFiles = (value: unknown) => (Array.isArray(value) ? value.map(decodeStored).filter((file): file is StoredFile => Boolean(file)) : []);

export const DRIFT_FILE: TargetFileSpec<DriftRecord> = {
  name: "drift.json",
  version: 1,
  decode(value) {
    const raw = (value ?? {}) as Record<string, unknown>;
    const check = raw.check as Record<string, unknown> | undefined;
    const imports: StoredImport[] = [];
    for (const item of Array.isArray(raw.imports) ? raw.imports : []) {
      const entry = (item ?? {}) as Record<string, unknown>;
      if (typeof entry.branch !== "string" || !oid(entry.commit) || !oid(entry.parent) || typeof entry.at !== "string") continue;
      const status = ["open", "later", "merged", "gone"].includes(entry.status as string) ? entry.status as DriftImport["status"] : "open";
      imports.push({ branch: entry.branch, commit: entry.commit as string, parent: entry.parent as string, at: entry.at, files: storedFiles(entry.files), status });
    }
    return {
      ...(check && typeof check.at === "string" ? { check: { at: check.at, baseline: check.baseline === "head" ? "head" : "mirror", files: storedFiles(check.files), later: check.later === true } } : {}),
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
      imports,
    };
  },
};

const publicFile = ({ path, change, certain }: StoredFile): DriftFile => ({ path, change, certain });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * HEAD's files under the target's folder as a stand-in mirror state, for a
 * target Tau has never read: sizes and hashes from Git, no mtime (so every file
 * of equal size gets hashed on the server). Blobs go into the mirror, which
 * keeps every object itself.
 */
export async function headBaseline(root: string, context: string, ignore: SyncIgnore, mirror: Mirror, git: GitCall): Promise<MirrorState | undefined> {
  const env = { GIT_OPTIONAL_LOCKS: "0" };
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd: root, env });
  if (head.code !== 0) return undefined;
  const commit = head.stdout.toString("utf8").trim();
  const listing = (await gitOk(git, ["ls-tree", "-r", "-l", "-z", "--full-tree", commit], { cwd: root, env })).toString("utf8");
  const prefix = context ? `${context}/` : "";
  const candidates: Array<{ path: string; oid: string; size: number; mode: number }> = [];
  for (const record of listing.split("\0")) {
    const match = /^(100644|100755) blob ([0-9a-f]{40,64}) +(\d+)\t(.+)$/su.exec(record);
    if (!match || !match[4]!.startsWith(prefix)) continue;
    const path = match[4]!.slice(prefix.length);
    if (isSyncPath(path) && !hasGitSegment(path)) candidates.push({ path, oid: match[2]!, size: Number(match[3]), mode: match[1] === "100755" ? 0o755 : 0o644 });
  }
  const ignored = await ignore.files(candidates.map((file) => file.path), { ancestors: true });
  const kept = candidates.filter((file) => !ignored.has(file.path));
  await mirror.ensure();
  const entries = new Map<string, MirrorEntry>();
  // `cat-file --batch` in slices, so a large tree is never held at once.
  for (let start = 0; start < kept.length;) {
    let end = start;
    for (let bytes = 0; end < kept.length && (end === start || bytes + kept[end]!.size < 32 * 1024 * 1024); end += 1) bytes += kept[end]!.size;
    const slice = kept.slice(start, end);
    const out = await gitOk(git, ["cat-file", "--batch"], { cwd: root, env, input: slice.map((file) => `${file.oid}\n`).join("") });
    let offset = 0;
    for (const file of slice) {
      const newline = out.indexOf(0x0a, offset);
      const header = out.subarray(offset, newline).toString("utf8").split(" ");
      const size = Number(header[2]);
      if (header[1] !== "blob" || !Number.isFinite(size)) throw new Error(`git cat-file could not read ${file.path}`);
      const data = out.subarray(newline + 1, newline + 1 + size);
      offset = newline + 1 + size + 1;
      const blob = await mirror.writeBlob(data);
      entries.set(file.path, { size: data.length, mtime: -1, mode: file.mode, oid: blob, sha256: sha256Of(data) });
    }
    start = end;
  }
  return { commit, at: new Date().toISOString(), entries };
}

interface DriftNow {
  baseline: DriftBaseline;
  base: MirrorState;
  server: ServerListing;
  rows: DriftRow[];
  fs: Awaited<ReturnType<SyncSession["connect"]>>;
}

export interface DriftServiceOptions {
  store: ServersStore;
  /** A project's targets, keyed by its main checkout. */
  list(cwd: string): Promise<{ project: { root: string; workspaceId: string }; targets: SftpJsonTarget[] }>;
  sync: Pick<SyncService, "exclusive">;
  /** A Workspace Kit command (granted to `tau.servers`). */
  workspace(command: string, input: unknown): Promise<unknown>;
  git?: GitCall;
  now?(): Date;
}

/** Drift of a project's targets: check, import as a branch, merge on a click. */
export class DriftService {
  private readonly git: GitCall;
  private readonly checking = new Set<string>();
  private readonly updates = new Map<string, Promise<unknown>>();
  private unhook: (() => void) | undefined;

  constructor(private readonly context: HostExtensionContext, private readonly options: DriftServiceOptions) {
    this.git = options.git ?? gitCall();
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private emit(workspace: string): void {
    this.context.emit(DRIFT_EVENT, { workspace });
  }

  /** Read-modify-write of a target's drift.json, one at a time per target. */
  private update(key: TargetKey, change: (record: DriftRecord) => DriftRecord | void): Promise<DriftRecord> {
    const id = `${key.workspaceId}/${key.targetId}`;
    const run = async () => {
      const record = (await this.options.store.read(key, DRIFT_FILE)) ?? { imports: [] };
      const next = change(record) ?? record;
      await this.options.store.write(key, DRIFT_FILE, next);
      return next;
    };
    const result = (this.updates.get(id) ?? Promise.resolve()).then(run, run);
    this.updates.set(id, result.catch(() => undefined));
    return result;
  }

  private async project(cwd: unknown) {
    if (typeof cwd !== "string" || !cwd) throw new HostCommandError("Open a project first.");
    return this.options.list(cwd);
  }

  private async readGit(cwd: string, args: string[]): Promise<string | undefined> {
    const result = await this.git(args, { cwd, env: { GIT_OPTIONAL_LOCKS: "0" } }).catch(() => undefined);
    return result?.code === 0 ? result.stdout.toString("utf8").trim() : undefined;
  }

  /** Where an import stands for the checkout `cwd`; a merge found in its history counts. */
  private async statusOf(cwd: string, item: StoredImport): Promise<DriftImport["status"]> {
    if (item.status === "merged") return "merged";
    const contained = await this.git(["merge-base", "--is-ancestor", item.commit, "HEAD"], { cwd, env: { GIT_OPTIONAL_LOCKS: "0" } }).catch(() => undefined);
    if (contained?.code === 0) return "merged";
    const branch = await this.readGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${item.branch}`]);
    return branch === item.commit ? item.status : "gone";
  }

  async state(cwd: unknown): Promise<DriftState> {
    const { project, targets } = await this.project(cwd);
    const checkout = await this.context.services.knownWorkspacePath(cwd as string);
    const branch = await this.readGit(checkout, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const rows: DriftTarget[] = [];
    for (const target of targets) {
      const key = { workspaceId: project.workspaceId, targetId: target.id };
      const record = (await this.options.store.read(key, DRIFT_FILE)) ?? { imports: [] };
      const imports = await Promise.all(record.imports.map(async (item) => ({ ...item, files: item.files.map(publicFile), status: await this.statusOf(checkout, item) })));
      const mirrored = Boolean(await this.options.store.read(key, MIRROR_INDEX_FILE));
      rows.push({
        targetId: target.id,
        label: target.name ?? (target.context || target.host || "sftp.json"),
        context: target.context,
        ...(!record.check && !mirrored ? { unchecked: true } : {}),
        ...(this.checking.has(`${key.workspaceId}/${key.targetId}`) ? { checking: true } : {}),
        ...(record.check ? { check: { ...record.check, files: record.check.files.map(publicFile) } } : {}),
        ...(record.error ? { error: record.error } : {}),
        imports: imports.reverse(),
      });
    }
    return { workspace: project.root, ...(branch ? { branch } : {}), targets: rows };
  }

  /** Server now against the mirror state, or against HEAD before the first read. */
  private async driftNow(session: SyncSession, root: string): Promise<DriftNow | undefined> {
    const state = await loadMirrorState(this.options.store, session.key, session.mirror);
    const base = state ?? await headBaseline(root, session.target.context, session.ignore, session.mirror, this.git);
    if (!base) return undefined;
    const fs = await session.connect();
    const server = await scanServer(fs, session.ignore, { signal: session.signal });
    const rows = await compareDrift(fs, server, base, session.ignore, { thorough: !state, concurrency: session.target.concurrency, signal: session.signal });
    // Against HEAD a missing file may never have been deployed at all (sources, tests): no deletions then.
    return { baseline: state ? "mirror" : "head", base, server, rows: state ? rows : rows.filter((row) => row.change !== "deleted"), fs };
  }

  private async checkTarget(root: string, workspaceId: string, target: SftpJsonTarget): Promise<void> {
    const key = { workspaceId, targetId: target.id };
    const id = `${workspaceId}/${target.id}`;
    this.checking.add(id);
    this.emit(root);
    try {
      const found = await this.options.sync.exclusive({ cwd: root, targetId: target.id }, (session) => this.driftNow(session, root));
      await this.update(key, (record) => {
        delete record.error;
        if (!found) { delete record.check; return; }
        const files: StoredFile[] = found.rows.map((row) => {
          const before = found.base.entries.get(row.path)?.oid;
          return { path: row.path, change: row.change, certain: row.certain, ...(before ? { before } : {}) };
        });
        // "Not now" holds while the drift is the same drift.
        const same = record.check?.later === true && sameFiles(record.check.files, files);
        record.check = { at: this.now().toISOString(), baseline: found.baseline, files, later: same };
      });
    } catch (error) {
      await this.update(key, (record) => { record.error = message(error); });
      throw error;
    } finally {
      this.checking.delete(id);
      this.emit(root);
    }
  }

  async check(input: unknown, options: { quiet?: boolean; onlyMirrored?: boolean } = {}): Promise<DriftState> {
    const { cwd, targetId } = (input ?? {}) as { cwd?: unknown; targetId?: unknown };
    const { project, targets } = await this.project(cwd);
    const chosen = targets.filter((target) => target.usable && (typeof targetId !== "string" || target.id === targetId));
    if (typeof targetId === "string" && !chosen.length) throw new HostCommandError("sftp.json no longer names this server, or it is not usable.");
    for (const target of chosen) {
      if (options.onlyMirrored && !(await this.options.store.read({ workspaceId: project.workspaceId, targetId: target.id }, MIRROR_INDEX_FILE))) continue;
      try {
        await this.checkTarget(project.root, project.workspaceId, target);
      } catch (error) {
        if (!options.quiet) throw error instanceof HostCommandError ? error : new HostCommandError(message(error));
        this.context.services.log("servers.drift", `${target.id}: ${message(error)}`);
      }
    }
    return this.state(cwd);
  }

  /**
   * Reads the drifted files, commits them on `server-drift/<date>` through
   * Workspace Kit and then records the server as read. A file whose content
   * turns out unchanged (a touch) is not drift.
   */
  async import(input: unknown): Promise<DriftImportResult> {
    const { cwd, targetId } = (input ?? {}) as { cwd?: unknown; targetId?: unknown };
    if (typeof targetId !== "string" || !targetId) throw new HostCommandError("Name the server.");
    const { project, targets } = await this.project(cwd);
    const target = targets.find((candidate) => candidate.id === targetId);
    if (!target) throw new HostCommandError("sftp.json no longer names this server.");
    const key = { workspaceId: project.workspaceId, targetId };
    const imported = await this.options.sync.exclusive({ cwd: project.root, targetId }, async (session) => {
      const found = await this.driftNow(session, project.root);
      if (!found) throw new HostCommandError("There is nothing to compare the server with yet: download it first, or commit the project.");
      const { base, server, rows, fs } = found;
      const read = new Map<string, { entry: MirrorEntry; data: Buffer }>();
      for (const row of rows) {
        if (row.change === "deleted") continue;
        const info = server.files.get(row.path)!;
        const data = await fs.read(row.path, { area: "project", signal: session.signal });
        read.set(row.path, { entry: entryOf(data, { mtime: info.mtime, mode: info.mode }), data });
      }
      const drifted: StoredFile[] = [];
      for (const row of rows) {
        const before = base.entries.get(row.path)?.oid;
        const got = read.get(row.path);
        if (got && got.entry.oid === before) continue;
        if (got) await session.mirror.writeBlob(got.data);
        drifted.push({ path: row.path, change: row.change, certain: true, ...(before ? { before } : {}), ...(got ? { after: got.entry.oid } : {}) });
      }
      const at = this.now();
      let item: StoredImport | undefined;
      if (drifted.length) {
        const prefix = target.context ? `${target.context}/` : "";
        const result = await this.options.workspace("commit-files-to-branch", {
          workspace: project.root,
          branch: driftBranchName(at),
          unique: true,
          message: `Server drift from ${target.name ?? target.host}\n\n${drifted.length} ${drifted.length === 1 ? "file" : "files"} changed on ${target.host}:${fs.root} since Tau last read it.`,
          files: drifted.map((file) => file.change === "deleted"
            ? { path: `${prefix}${file.path}`, delete: true }
            : { path: `${prefix}${file.path}`, content: read.get(file.path)!.data.toString("base64"), executable: (read.get(file.path)!.entry.mode & 0o111) !== 0 }),
        }) as { branch?: string; commit?: string; parent: string; changed: string[] };
        const changed = new Set(result.changed);
        if (result.commit && result.branch) {
          item = { branch: result.branch, commit: result.commit, parent: result.parent, at: at.toISOString(), status: "open", files: drifted.filter((file) => changed.has(`${prefix}${file.path}`)) };
        }
      }
      // The mirror now holds the server as read; what was under unreadable folders stays as it was.
      const entries = new Map<string, MirrorEntry>();
      for (const [path, info] of server.files) {
        const fresh = read.get(path)?.entry;
        const known = base.entries.get(path);
        entries.set(path, fresh ?? { ...known!, size: info.size, mtime: info.mtime, mode: info.mode });
      }
      if (found.baseline === "mirror") {
        const skipped = new Set(server.skipped);
        for (const [path, entry] of base.entries) {
          if (!entries.has(path) && (skipped.has(path) || ancestors(path).some((folder) => server.unreadable.includes(folder)))) entries.set(path, entry);
        }
      }
      await saveMirrorState(this.options.store, key, session.mirror, entries, `Server state ${fs.root} ${at.toISOString()}${item ? ` (drift in ${item.branch})` : ""}`);
      await this.update(key, (record) => {
        delete record.error;
        record.check = { at: at.toISOString(), baseline: "mirror", files: [], later: false };
        if (item) record.imports.push(item);
      });
      return item;
    });
    this.emit(project.root);
    const state = await this.state(cwd);
    return { state, ...(imported ? { imported: { ...imported, files: imported.files.map(publicFile) } } : {}) };
  }

  /**
   * Paths whose server state is in the mirror now (uploaded, or taken from the
   * server by hand): they leave the last check's list, which is otherwise kept.
   */
  async settled(key: TargetKey, root: string, paths: readonly string[]): Promise<void> {
    if (!paths.length) return;
    const done = new Set(paths);
    await this.update(key, (record) => {
      if (record.check) record.check.files = record.check.files.filter((file) => !done.has(file.path));
    });
    this.emit(root);
  }

  private async findImport(cwd: unknown, targetId: unknown, branch: unknown) {
    if (typeof targetId !== "string" || typeof branch !== "string") throw new HostCommandError("Name the server and the branch.");
    const { project } = await this.project(cwd);
    const key = { workspaceId: project.workspaceId, targetId };
    const record = await this.options.store.read(key, DRIFT_FILE);
    const item = record?.imports.find((candidate) => candidate.branch === branch);
    if (!item) throw new HostCommandError(`Tau made no drift branch ${branch} for this server.`);
    return { project, key, item };
  }

  /** A normal merge commit of a drift branch into the checkout's branch; only on the user's click. */
  async merge(input: unknown): Promise<DriftState> {
    const { cwd, targetId, branch } = (input ?? {}) as { cwd?: unknown; targetId?: unknown; branch?: unknown };
    const { project, key, item } = await this.findImport(cwd, targetId, branch);
    const checkout = await this.context.services.knownWorkspacePath(cwd as string);
    try {
      await this.options.workspace("merge-branch", { workspace: checkout, branch: item.branch });
    } catch (error) {
      throw new HostCommandError(message(error));
    }
    await this.update(key, (record) => {
      const found = record.imports.find((candidate) => candidate.branch === item.branch);
      if (found) found.status = "merged";
    });
    this.emit(project.root);
    return this.state(cwd);
  }

  /** "Later": a drift branch stays unmerged, or this drift stays unimported, without being asked about again. */
  async later(input: unknown): Promise<DriftState> {
    const { cwd, targetId, branch } = (input ?? {}) as { cwd?: unknown; targetId?: unknown; branch?: unknown };
    if (typeof branch === "string") {
      const { project, key, item } = await this.findImport(cwd, targetId, branch);
      await this.update(key, (record) => {
        const found = record.imports.find((candidate) => candidate.branch === item.branch);
        if (found && found.status === "open") found.status = "later";
      });
      this.emit(project.root);
    } else {
      const { project } = await this.project(cwd);
      const ids = typeof targetId === "string" ? [targetId] : await this.options.store.targets(project.workspaceId);
      for (const id of ids) {
        await this.update({ workspaceId: project.workspaceId, targetId: id }, (record) => { if (record.check) record.check.later = true; });
      }
      this.emit(project.root);
    }
    return this.state(cwd);
  }

  /** One file's diff: an import's before and after, or what the server holds now against the base of the last check. */
  async diff(input: unknown): Promise<UiFileDiff> {
    const { cwd, targetId, path, branch } = (input ?? {}) as { cwd?: unknown; targetId?: unknown; path?: unknown; branch?: unknown };
    if (typeof targetId !== "string" || typeof path !== "string" || !isSyncPath(path)) throw new HostCommandError("Name the server and the file.");
    const { project } = await this.project(cwd);
    const key = { workspaceId: project.workspaceId, targetId };
    if (typeof branch === "string") {
      const { item } = await this.findImport(cwd, targetId, branch);
      const file = item.files.find((candidate) => candidate.path === path);
      if (!file) throw new HostCommandError(`${path} is not part of ${branch}.`);
      return this.blobDiff(this.options.store.mirrorDir(key), path, file.before, file.after);
    }
    const record = await this.options.store.read(key, DRIFT_FILE);
    const file = record?.check?.files.find((candidate) => candidate.path === path);
    if (!file) throw new HostCommandError(`${path} is not among the server's changes.`);
    return this.options.sync.exclusive({ cwd: project.root, targetId }, async (session) => {
      let after: string | undefined;
      if (file.change !== "deleted") {
        const fs = await session.connect();
        after = await session.mirror.writeBlob(await fs.read(path, { area: "project", signal: session.signal }));
      }
      return this.blobDiff(session.mirror.dir, path, file.before, after);
    });
  }

  private async blobDiff(mirrorDir: string, path: string, before: string | undefined, after: string | undefined): Promise<UiFileDiff> {
    const env = { GIT_DIR: mirrorDir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull };
    const empty = (await gitOk(this.git, ["hash-object", "-w", "--stdin"], { cwd: mirrorDir, env, input: "" })).toString("utf8").trim();
    const out = await this.git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", before ?? empty, after ?? empty], { cwd: mirrorDir, env });
    if (out.code !== 0 && out.code !== 1) throw new HostCommandError(`Tau could not draw the diff of ${path}.`);
    return parseDiff(path, out.stdout.toString("utf8"));
  }

  register(): void {
    const { context } = this;
    const wrap = <T>(run: (input: unknown) => Promise<T>) => async (input: unknown) => {
      try {
        return await run(input);
      } catch (error) {
        throw error instanceof HostCommandError ? error : new HostCommandError(message(error));
      }
    };
    context.registerCommand("drift", wrap((input) => this.state((input as { cwd?: unknown } | undefined)?.cwd)), { access: "read" });
    context.registerCommand("check-drift", wrap((input) => this.check(input)), { long: true, access: "read", audit: { label: "checked a server for drift" } });
    context.registerCommand("import-drift", wrap((input) => this.import(input)), { long: true, audit: { label: "imported server drift as a branch" } });
    context.registerCommand("merge-drift", wrap((input) => this.merge(input)), { long: true, audit: { label: "merged a server drift branch" } });
    context.registerCommand("drift-later", wrap((input) => this.later(input)), { audit: { label: "put server drift off" } });
    context.registerCommand("drift-diff", wrap((input) => this.diff(input)), { long: true, access: "read" });
    // On opening a project: targets Tau has read before, in the background.
    this.unhook = context.services.registerThreadLifecycle({
      // Not awaited: a slow server or a login dialog must not hold the project's first thread.
      beforeWorkspace: async (cwd) => { void this.check({ cwd }, { quiet: true, onlyMirrored: true }).catch((error: unknown) => context.services.log("servers.drift", message(error))); },
    });
  }

  dispose(): void {
    this.unhook?.();
  }
}

function sameFiles(a: readonly StoredFile[], b: readonly StoredFile[]): boolean {
  return a.length === b.length && a.every((file, index) => file.path === b[index]!.path && file.change === b[index]!.change);
}

const MAX_DIFF_LINES = 10_000;

/** `git diff` of two blobs as the view's hunks. */
export function parseDiff(path: string, patch: string): UiFileDiff {
  const diff: UiFileDiff = { path, added: 0, removed: 0, hunks: [] };
  let hunk: UiDiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let lines = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("Binary files ")) { diff.note = "Binary file"; continue; }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (header) {
      hunk = { header: line, lines: [] };
      diff.hunks.push(hunk);
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (!hunk || line.startsWith("\\")) continue;
    if (++lines > MAX_DIFF_LINES) { diff.truncated = true; break; }
    if (line.startsWith("+")) { diff.added += 1; hunk.lines.push({ kind: "added", newLine: newLine++, text: line.slice(1) }); }
    else if (line.startsWith("-")) { diff.removed += 1; hunk.lines.push({ kind: "removed", oldLine: oldLine++, text: line.slice(1) }); }
    else if (line.startsWith(" ")) hunk.lines.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: line.slice(1) });
  }
  return diff;
}
