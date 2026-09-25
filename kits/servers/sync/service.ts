import { join } from "node:path";
import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import { ServerPathError, type ServerFs } from "../server-fs.js";
import { SftpError } from "../sftp-client.js";
import type { SftpJsonTarget } from "../sftp-json.js";
import type { ServersStore, TargetKey } from "../store.js";
import { readTrust, recordLiveConfigs } from "../trust.js";
import { compareDrift, comparePending, deletedFrom } from "./compare.js";
import { download } from "./download.js";
import { GitError, type GitCall } from "./git.js";
import { SyncIgnore } from "./ignore.js";
import { loadMirrorState, Mirror, saveMirrorState } from "./mirror.js";
import { isSyncPath } from "./paths.js";
import {
  SYNC_PROGRESS_EVENT, SYNC_PROGRESS_TOPIC,
  type CompareResult, type DownloadResult, type ScanSummary, type SyncOperation, type SyncPhase, type SyncProgress,
} from "./protocol.js";
import { scanLocal, scanServer, summarize } from "./scan.js";
import { TarError } from "./tar.js";

export interface SyncServiceOptions {
  store: ServersStore;
  /** A project's target by id, with the key of its main checkout. */
  target(cwd: string, targetId: string): Promise<{ project: { root: string; workspaceId: string }; target: SftpJsonTarget }>;
  /** The connected transport of a project's target. */
  transport(input: { cwd: string; targetId: string }): Promise<ServerFs>;
  git?: GitCall;
}

interface SyncInput {
  cwd: string;
  targetId: string;
  exclude: string[];
  /** Forces SFTP for listing and fetching (a server whose shell misbehaves; tests). */
  sftpOnly: boolean;
}

function decodeInput(value: unknown): SyncInput {
  const input = (value ?? {}) as Record<string, unknown>;
  if (typeof input.cwd !== "string" || !input.cwd) throw new HostCommandError("Open a project first.");
  if (typeof input.targetId !== "string" || !input.targetId) throw new HostCommandError("Name the server.");
  const exclude = Array.isArray(input.exclude) ? input.exclude.filter((path): path is string => typeof path === "string" && isSyncPath(path)) : [];
  return { cwd: input.cwd, targetId: input.targetId, exclude, sftpOnly: input.method === "sftp" };
}

/**
 * What only the kit itself asks for, never a client: making a project from a
 * server, where the folder gets its own repository after the download.
 */
export interface SyncInternal {
  /** False: the folder's (or an enclosing) repository's ignore rules do not count yet. */
  gitRules?: false;
  /** Fill the mirror and leave the local folder as it is. */
  mirrorOnly?: true;
}

/** What a sync operation works with; `connect` opens (or reuses) the target's transport. */
export interface SyncSession {
  workspace: string;
  target: SftpJsonTarget;
  localDir: string;
  key: TargetKey;
  ignore: SyncIgnore;
  mirror: Mirror;
  signal: AbortSignal;
  connect(): Promise<ServerFs>;
}

const flag = (value: unknown, key: string, fallback: boolean) => {
  const raw = (value as Record<string, unknown> | undefined)?.[key];
  return typeof raw === "boolean" ? raw : fallback;
};

/** What the server or the local Git said is an answer, not a broken command. */
export function answerError(error: unknown): unknown {
  if (error instanceof ServerPathError || error instanceof SftpError || error instanceof GitError || error instanceof TarError) return new HostCommandError(error.message);
  return error;
}

// Progress every this many files, and at the end of each phase.
const PROGRESS_STEP = 50;

/**
 * `scan`, `compare` and `download` of a project's target. One operation per
 * target at a time; the rest wait their turn.
 */
export class SyncService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly stopped = new AbortController();

  constructor(private readonly context: HostExtensionContext, private readonly options: SyncServiceOptions) {}

  private serial<T>(key: TargetKey, run: () => Promise<T>): Promise<T> {
    const id = `${key.workspaceId}/${key.targetId}`;
    const result = (this.queues.get(id) ?? Promise.resolve()).then(run, run);
    const settled = result.catch(() => undefined);
    this.queues.set(id, settled);
    void settled.then(() => { if (this.queues.get(id) === settled) this.queues.delete(id); });
    return result;
  }

  private progress(operation: SyncOperation, workspace: string, targetId: string) {
    return (phase: SyncPhase, done: number, extra: Partial<Pick<SyncProgress, "total" | "bytes" | "totalBytes">> = {}, force = false) => {
      if (!force && done % PROGRESS_STEP !== 0) return;
      const payload: SyncProgress = { operation, workspace, targetId, phase, done, ...extra };
      this.context.emit(SYNC_PROGRESS_EVENT, payload, { topic: SYNC_PROGRESS_TOPIC });
    };
  }

  private async open(input: SyncInput, internal: SyncInternal = {}): Promise<SyncSession> {
    const workspace = await this.context.services.knownWorkspacePath(input.cwd);
    const { project, target } = await this.options.target(workspace, input.targetId);
    const localDir = target.context ? join(workspace, ...target.context.split("/")) : workspace;
    const key: TargetKey = { workspaceId: project.workspaceId, targetId: target.id };
    const ignore = await SyncIgnore.create({
      localDir,
      patterns: target.ignore,
      ...(target.ignoreFile ? { ignoreFile: target.ignoreFile } : {}),
      projectDir: workspace,
      exclude: input.exclude,
      ...(internal.gitRules === false ? { gitRules: false } : {}),
      ...(this.options.git ? { git: this.options.git } : {}),
    });
    const mirror = new Mirror(this.options.store.mirrorDir(key), this.options.git ? { git: this.options.git } : {});
    return { workspace, target, localDir, key, ignore, mirror, signal: this.stopped.signal, connect: () => this.options.transport({ cwd: input.cwd, targetId: input.targetId }) };
  }

  /** Runs `run` alone on the target's queue, with the session the sync commands use. */
  async exclusive<T>(input: { cwd: string; targetId: string }, run: (session: SyncSession) => Promise<T>): Promise<T> {
    const session = await this.open(decodeInput(input));
    return this.serial(session.key, () => run(session));
  }

  private async connect(input: SyncInput, report: ReturnType<SyncService["progress"]>): Promise<ServerFs> {
    report("connect", 0, {}, true);
    return this.options.transport({ cwd: input.cwd, targetId: input.targetId });
  }

  async scan(raw: unknown, internal?: SyncInternal): Promise<ScanSummary> {
    const input = decodeInput(raw);
    const session = await this.open(input, internal);
    return this.serial(session.key, async () => {
      const report = this.progress("scan", session.workspace, session.target.id);
      const fs = await this.connect(input, report);
      const listing = await scanServer(fs, session.ignore, { method: input.sftpOnly ? "sftp" : "auto", signal: session.signal, onProgress: (listed) => report("list", listed, {}, true) });
      report("done", listing.files.size, {}, true);
      return summarize(session.target.id, listing, session.ignore.gitRules);
    });
  }

  async compare(raw: unknown): Promise<CompareResult> {
    const input = decodeInput(raw);
    const wantPending = flag(raw, "pending", true);
    const wantDrift = flag(raw, "drift", true);
    const thorough = flag(raw, "thorough", false);
    const session = await this.open(input);
    return this.serial(session.key, async () => {
      const report = this.progress("compare", session.workspace, session.target.id);
      const state = await loadMirrorState(this.options.store, session.key, session.mirror);
      const result: CompareResult = { targetId: session.target.id };
      if (!state) return result;
      result.mirror = { commit: state.commit, at: state.at, files: state.entries.size };
      if (wantPending) {
        const local = await scanLocal(session.localDir, session.ignore, { signal: session.signal });
        const { uploadBlocklist } = await readTrust(this.options.store, session.key);
        result.pending = await comparePending(session.localDir, local, state, session.ignore, { thorough, blocklist: uploadBlocklist, signal: session.signal });
      }
      if (wantDrift) {
        const fs = await this.connect(input, report);
        const server = await scanServer(fs, session.ignore, { method: input.sftpOnly ? "sftp" : "auto", signal: session.signal, onProgress: (listed) => report("list", listed, {}, true) });
        const rows = await compareDrift(fs, server, state, session.ignore, {
          thorough, concurrency: session.target.concurrency, signal: session.signal,
          onHash: (done, total) => report("hash", done, { total }, done === total),
        });
        result.drift = { rows, method: server.method, thorough };
      }
      report("done", 0, {}, true);
      return result;
    });
  }

  async download(raw: unknown, internal: SyncInternal = {}): Promise<DownloadResult> {
    const input = decodeInput(raw);
    const overwrite = flag(raw, "overwrite", false);
    const session = await this.open(input, internal);
    return this.serial(session.key, async () => {
      const report = this.progress("download", session.workspace, session.target.id);
      const fs = await this.connect(input, report);
      const listing = await scanServer(fs, session.ignore, { method: input.sftpOnly ? "sftp" : "auto", signal: session.signal, onProgress: (listed) => report("list", listed, {}, true) });
      let totalBytes = 0;
      for (const info of listing.files.values()) totalBytes += info.size;
      const total = listing.files.size;
      const previous = await loadMirrorState(this.options.store, session.key, session.mirror);
      const deletedOnServer = previous ? await deletedFrom(listing, previous, session.ignore) : [];
      const outcome = await download(fs, listing, previous, session.mirror, {
        localDir: session.localDir, overwrite, method: input.sftpOnly ? "sftp" : "auto", deletedOnServer,
        ...(internal.mirrorOnly ? { mirrorOnly: true } : {}),
        concurrency: Math.max(1, session.target.concurrency), signal: session.signal,
        onProgress: (done, bytes) => report("fetch", done, { total, bytes, totalBytes }, done === total),
      });
      report("record", outcome.entries.size, {}, true);
      const state = await saveMirrorState(this.options.store, session.key, session.mirror, outcome.entries, `Server state ${fs.root} ${new Date().toISOString()}`);
      await recordLiveConfigs(this.options.store, session.key, outcome.findings, listing.files.keys());
      report("done", total, { total, bytes: outcome.bytes, totalBytes }, true);
      return {
        targetId: session.target.id,
        commit: state.commit,
        method: outcome.method,
        files: outcome.entries.size,
        bytes: outcome.bytes,
        written: outcome.written,
        unchanged: outcome.unchanged,
        kept: outcome.kept,
        keptDeleted: outcome.keptDeleted,
        removed: outcome.removed,
        failed: outcome.failed,
        liveConfigs: new Set(outcome.findings.map((finding) => finding.path)).size,
      };
    });
  }

  register(): void {
    const { context } = this;
    const wrap = <T>(run: (input: unknown) => Promise<T>) => async (input: unknown) => {
      try {
        return await run(input);
      } catch (error) {
        throw answerError(error);
      }
    };
    // `long`: a listing, a hash run or a download can take minutes, and a login may wait on a dialog.
    context.registerCommand("scan", wrap((input) => this.scan(input)), { long: true, access: "read", audit: { label: "listed a server" } });
    context.registerCommand("compare", wrap((input) => this.compare(input)), { long: true, access: "read", audit: { label: "compared with a server" } });
    context.registerCommand("download", wrap((input) => this.download(input)), { long: true, audit: { label: "downloaded from a server" } });
  }

  dispose(): void {
    this.stopped.abort();
  }
}
