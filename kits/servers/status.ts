import { access, lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { HostCommandError, type HostExtensionContext, type UiFileDiff } from "tau/host-extension";
import { diffBlobs, diffHistory, readHistory } from "./history.js";
import { SECRET_KIND_LABELS, guardUploadSelection, type SecretFinding, type UploadOp } from "./live-config.js";
import type { ServerCapabilities, TargetLevel } from "./protocol.js";
import { scanFiles } from "./secrets-scan.js";
import { readServerGit } from "./server-git.js";
import type { ServerFs } from "./server-fs.js";
import { SFTP_JSON_PATH, type SftpJsonTarget } from "./sftp-json.js";
import { conflictsOf, deriveState, formatAddress } from "./status-model.js";
import type { ServersStore, TargetKey } from "./store.js";
import { gitCall, type GitCall } from "./sync/git.js";
import { loadMirrorState, Mirror } from "./sync/mirror.js";
import { hasGitSegment, isInside, isSyncPath, localPath } from "./sync/paths.js";
import type { CompareResult, DriftRow, ListMethod, MirrorInfo, SyncChange } from "./sync/protocol.js";
import { isTargetLevel, readTargetFile, updateTargetFile } from "./target-settings.js";
import { readTrust } from "./trust.js";
import {
  PENDING_ROW_CAP, SERVERS_STATUS_EVENT, SERVERS_STATUS_TOPIC,
  type LiveConfigRow, type PendingUploadRow, type ServerGitInfo, type ServerHistory, type ServersStatus, type ServersStatusEvent, type TargetStatus,
} from "./view-protocol.js";

type Project = { root: string; workspaceId: string };

export interface ServerStatusOptions {
  store: ServersStore;
  /** A project's targets as they read now. */
  list(cwd: string): Promise<{ project: Project; targets: SftpJsonTarget[] }>;
  compare(input: { cwd: string; targetId: string; pending?: boolean; drift?: boolean }): Promise<CompareResult>;
  /** The connected transport; throws when the server cannot be reached. */
  transport(input: { cwd: string; targetId: string }): Promise<ServerFs & { probe?: { commands: readonly string[] } | undefined }>;
  /** The line a terminal types to log in to the target, once connected. */
  terminalCommand?(input: { cwd: string; targetId: string }): Promise<string>;
  /** Threads with a deployment not committed yet (the deployment journal fills it). */
  uncommittedThreads?(key: TargetKey): Promise<string[]>;
  git?: GitCall;
  now?(): number;
}

/** What Tau learned of a target in this host's life; the rest is read again each time. */
interface TargetRecord {
  pending: PendingUploadRow[];
  pendingTotal: number;
  withheld: string[];
  liveConfigs: LiveConfigRow[];
  mirror?: MirrorInfo;
  pendingAt?: number;
  drift?: DriftRow[];
  driftMethod?: ListMethod;
  checkedAt?: string;
  unreachable?: string;
  error?: string;
  serverGit?: ServerGitInfo;
  caps?: ServerCapabilities;
  checking: boolean;
  autoChecked: boolean;
}

// A status asked within this many ms reuses the local comparison.
const PENDING_FRESH_MS = 2000;
// Local files scanned for credentials per refresh; the rest keep the server copy's findings only.
const SCAN_CAP = 500;

const OPS: Record<SyncChange, UploadOp> = { added: "add", modified: "modify", deleted: "delete" };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const lostConnection = (error: unknown) => error instanceof Error && error.name === "SshConnectError";

/** A regular file inside the target's folder; nothing through a link, nothing in `.git`. */
async function readLocalFile(localDir: string, path: string): Promise<Buffer | undefined> {
  if (hasGitSegment(path)) return undefined;
  const file = localPath(localDir, path);
  try {
    const [info, real, root] = await Promise.all([lstat(file), realpath(file), realpath(localDir)]);
    if (!info.isFile() || !isInside(real, root)) return undefined;
    return await readFile(real);
  } catch {
    return undefined;
  }
}

function decodeRef(value: unknown): { cwd: string; targetId: string } {
  const input = (value ?? {}) as Record<string, unknown>;
  if (typeof input.cwd !== "string" || !input.cwd) throw new HostCommandError("Open a project first.");
  if (typeof input.targetId !== "string" || !input.targetId) throw new HostCommandError("Name the server.");
  return { cwd: input.cwd, targetId: input.targetId };
}

/**
 * Each target's state for the server view: the local changes not uploaded,
 * what changed on the server, whether it answers and its own Git. The local
 * side is compared on every ask; the server only on a check, which runs once
 * by itself per target and host session and again on the user's request.
 */
export class ServerStatusService {
  private readonly records = new Map<string, TargetRecord>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly git: GitCall;
  private readonly stopped = new AbortController();

  constructor(private readonly context: HostExtensionContext, private readonly options: ServerStatusOptions) {
    this.git = options.git ?? gitCall();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private record(workspace: string, targetId: string): TargetRecord {
    const id = `${workspace}\0${targetId}`;
    let record = this.records.get(id);
    if (!record) {
      record = { pending: [], pendingTotal: 0, withheld: [], liveConfigs: [], checking: false, autoChecked: false };
      this.records.set(id, record);
    }
    return record;
  }

  /** One run per target and kind at a time; a second ask joins it. */
  private once(key: string, run: () => Promise<void>): Promise<void> {
    const current = this.running.get(key);
    if (current) return current;
    const next = run().finally(() => this.running.delete(key));
    this.running.set(key, next);
    return next;
  }

  private async open(cwd: string) {
    const workspace = await this.context.services.knownWorkspacePath(cwd);
    const listed = await this.options.list(workspace);
    return { workspace, ...listed };
  }

  private async refreshPending(workspace: string, project: Project, target: SftpJsonTarget): Promise<void> {
    const record = this.record(workspace, target.id);
    const result = await this.options.compare({ cwd: workspace, targetId: target.id, drift: false });
    if (record.mirror && result.mirror?.commit !== record.mirror.commit) {
      // Drift was measured against a mirror state that is gone.
      delete record.drift;
      delete record.driftMethod;
      record.autoChecked = false;
    }
    if (result.mirror) record.mirror = result.mirror; else delete record.mirror;
    const key: TargetKey = { workspaceId: project.workspaceId, targetId: target.id };
    const trust = await readTrust(this.options.store, key);
    const rows = result.pending?.rows ?? [];
    const localDir = target.context ? join(workspace, ...target.context.split("/")) : workspace;
    const scanned = await scanFiles(localDir, rows.filter((row) => row.change !== "deleted").slice(0, SCAN_CAP).map((row) => row.path)).catch(() => []);
    const findings: SecretFinding[] = [...scanned, ...trust.liveConfigs.map((entry) => ({ path: entry.path, kind: entry.kind, line: 0 }))];
    const guarded = guardUploadSelection(rows.map((row) => ({ ...row, op: OPS[row.change] })), { findings, blocklist: trust.uploadBlocklist });
    const pending = guarded.rows.map(({ candidate, selected, guard }): PendingUploadRow => ({
      path: candidate.path,
      change: candidate.change,
      ...(candidate.size !== undefined ? { size: candidate.size } : {}),
      selected,
      ...(guard ? { credentials: guard.kinds.length ? guard.kinds.map((kind) => SECRET_KIND_LABELS[kind]) : ["Framework config"] } : {}),
    }));
    record.pendingTotal = pending.length;
    record.pending = pending.slice(0, PENDING_ROW_CAP);
    record.withheld = [...new Set([...(result.pending?.withheld ?? []), ...guarded.withheld])].sort();
    record.liveConfigs = trust.liveConfigs.map((entry) => ({ path: entry.path, label: SECRET_KIND_LABELS[entry.kind] }));
    record.pendingAt = this.now();
  }

  private async compose(workspace: string, project: Project, targets: readonly SftpJsonTarget[]): Promise<ServersStatus> {
    const file = join(project.root, SFTP_JSON_PATH);
    const hasFile = await access(file).then(() => true, () => false);
    const rows = await Promise.all(targets.map(async (target): Promise<TargetStatus> => {
      const record = this.record(workspace, target.id);
      const key: TargetKey = { workspaceId: project.workspaceId, targetId: target.id };
      const { level } = await readTargetFile(this.options.store, key).catch(() => ({ level: "ask" as const }));
      const unusable = target.usable ? undefined : target.issues.find((issue) => issue.level === "error")?.message ?? "sftp.json names no server Tau can reach.";
      const status: TargetStatus = {
        targetId: target.id,
        label: target.name ?? (target.context || target.host || "sftp.json"),
        address: formatAddress(target),
        protocol: target.protocol,
        context: target.context,
        ...(target.profile ? { profile: target.profile } : {}),
        level,
        state: deriveState({ usable: target.usable, ...(record.unreachable ? { unreachable: record.unreachable } : {}), mirror: record.mirror, pending: record.pending, ...(record.drift ? { drift: record.drift } : {}) }),
        checking: record.checking,
        pending: record.pending,
        pendingTotal: record.pendingTotal,
        withheld: record.withheld,
        conflicts: conflictsOf(record.pending, record.drift),
        liveConfigs: record.liveConfigs,
        uncommittedThreads: await this.options.uncommittedThreads?.(key).catch(() => []) ?? [],
      };
      if (record.mirror) status.mirror = record.mirror;
      if (record.drift) status.drift = record.drift;
      if (record.driftMethod) status.driftMethod = record.driftMethod;
      if (record.checkedAt) status.checkedAt = record.checkedAt;
      if (record.unreachable) status.unreachable = record.unreachable;
      if (record.error) status.error = record.error;
      if (unusable) status.unusable = unusable;
      if (record.serverGit) status.serverGit = record.serverGit;
      if (record.caps) status.caps = record.caps;
      return status;
    }));
    return { workspace, ...(hasFile ? { file } : {}), targets: rows };
  }

  private async publish(workspace: string): Promise<void> {
    try {
      const { project, targets } = await this.options.list(workspace);
      const payload: ServersStatusEvent = { workspace, status: await this.compose(workspace, project, targets) };
      this.context.emit(SERVERS_STATUS_EVENT, payload, { topic: SERVERS_STATUS_TOPIC });
    } catch (error) {
      this.context.services.log("servers.status", `could not publish the status: ${message(error)}`);
    }
  }

  async status(raw: unknown): Promise<ServersStatus> {
    const input = (raw ?? {}) as { cwd?: unknown; fresh?: unknown };
    if (typeof input.cwd !== "string" || !input.cwd) throw new HostCommandError("Open a project first.");
    const { workspace, project, targets } = await this.open(input.cwd);
    await Promise.all(targets.filter((target) => target.usable).map(async (target) => {
      const record = this.record(workspace, target.id);
      const stale = input.fresh === true || record.pendingAt === undefined || this.now() - record.pendingAt > PENDING_FRESH_MS;
      if (stale) await this.once(`pending\0${workspace}\0${target.id}`, () => this.refreshPending(workspace, project, target)).catch((error: unknown) => { record.error = message(error); });
      if (!record.autoChecked && !this.stopped.signal.aborted) {
        record.autoChecked = true;
        void this.check({ cwd: workspace, targetId: target.id }).catch(() => undefined);
      }
    }));
    return this.compose(workspace, project, targets);
  }

  /** Reaches the server: whether it answers, what changed there, and its Git. */
  async check(raw: unknown): Promise<ServersStatus> {
    const { cwd, targetId } = decodeRef(raw);
    const { workspace, project, targets } = await this.open(cwd);
    const target = targets.find((candidate) => candidate.id === targetId);
    if (!target) throw new HostCommandError("sftp.json no longer names this server.");
    if (!target.usable) return this.compose(workspace, project, targets);
    const record = this.record(workspace, targetId);
    record.autoChecked = true;
    await this.once(`check\0${workspace}\0${targetId}`, async () => {
      record.checking = true;
      void this.publish(workspace);
      try {
        delete record.error;
        await this.refreshPending(workspace, project, target).catch((error: unknown) => { record.error = message(error); });
        let fs: Awaited<ReturnType<ServerStatusOptions["transport"]>>;
        try {
          fs = await this.options.transport({ cwd: workspace, targetId });
        } catch (error) {
          record.unreachable = message(error);
          return;
        }
        delete record.unreachable;
        record.caps = fs.caps;
        try {
          const result = await this.options.compare({ cwd: workspace, targetId, pending: false });
          if (result.drift) { record.drift = result.drift.rows; record.driftMethod = result.drift.method; }
          else { delete record.drift; delete record.driftMethod; }
        } catch (error) {
          // A connection that was up and has gone: the server stopped answering.
          if (lostConnection(error)) { record.unreachable = message(error); return; }
          record.error = message(error);
        }
        record.serverGit = await readServerGit(fs, Boolean(fs.probe?.commands.includes("git")), this.stopped.signal)
          .catch((error: unknown) => ({ repository: false as const, reason: message(error) }));
        // When the server last answered; an unreachable one keeps the time it last did.
        record.checkedAt = new Date(this.now()).toISOString();
      } finally {
        record.checking = false;
        void this.publish(workspace);
      }
    });
    return this.compose(workspace, project, targets);
  }

  private async resolve(raw: unknown) {
    const { cwd, targetId } = decodeRef(raw);
    const { workspace, project, targets } = await this.open(cwd);
    const target = targets.find((candidate) => candidate.id === targetId);
    if (!target) throw new HostCommandError("sftp.json no longer names this server.");
    const key: TargetKey = { workspaceId: project.workspaceId, targetId };
    return { workspace, target, key, mirror: new Mirror(this.options.store.mirrorDir(key), { git: this.git }) };
  }

  async history(raw: unknown): Promise<ServerHistory> {
    const { target, mirror } = await this.resolve(raw);
    return { targetId: target.id, entries: await readHistory(this.git, mirror) };
  }

  async diff(raw: unknown): Promise<UiFileDiff> {
    const { workspace, target, key, mirror } = await this.resolve(raw);
    const input = raw as { source?: unknown; path?: unknown; commit?: unknown };
    if (typeof input.path !== "string" || !isSyncPath(input.path)) throw new HostCommandError("Name a file of the target.");
    if (input.source === "history") {
      if (typeof input.commit !== "string") throw new HostCommandError("Name the recorded state.");
      return diffHistory(this.git, mirror, input.commit, input.path);
    }
    const state = await loadMirrorState(this.options.store, key, mirror);
    if (!state) throw new HostCommandError("Tau has not read this server yet.");
    const before = state.entries.get(input.path)?.oid;
    const localDir = target.context ? join(workspace, ...target.context.split("/")) : workspace;
    const data = await readLocalFile(localDir, input.path);
    // The local side becomes a blob of the mirror, which the upload stores anyway.
    const after = data ? await mirror.writeBlob(data) : undefined;
    return diffBlobs(this.git, mirror, input.path, before, after);
  }

  /** Each target's level on its own, for Settings: reads no server and compares nothing. */
  async levels(raw: unknown): Promise<{ levels: Record<string, TargetLevel> }> {
    const cwd = (raw as { cwd?: unknown } | undefined)?.cwd;
    if (typeof cwd !== "string" || !cwd) throw new HostCommandError("Open a project first.");
    const { project, targets } = await this.open(cwd);
    const entries = await Promise.all(targets.map(async (target) => [target.id, (await readTargetFile(this.options.store, { workspaceId: project.workspaceId, targetId: target.id })).level] as const));
    return { levels: Object.fromEntries(entries) };
  }

  async setLevel(raw: unknown): Promise<{ level: string }> {
    const { key } = await this.resolve(raw);
    const level = (raw as { level?: unknown }).level;
    if (!isTargetLevel(level)) throw new HostCommandError("Choose read-only, ask or full.");
    const file = await updateTargetFile(this.options.store, key, (current) => ({ ...current, level }));
    return { level: file.level };
  }

  register(): void {
    const { context } = this;
    context.registerCommand("status", (input) => this.status(input), { access: "read" });
    // `long`: a login may wait on a dialog; reading the server changes nothing there.
    context.registerCommand("check", (input) => this.check(input), { long: true, access: "read" });
    context.registerCommand("server-history", (input) => this.history(input), { access: "read" });
    context.registerCommand("server-diff", (input) => this.diff(input), { access: "read" });
    context.registerCommand("target-levels", (input) => this.levels(input), { access: "read" });
    context.registerCommand("set-target-level", (input) => this.setLevel(input), { audit: { label: "set what the agent may run on a server" } });
    context.registerCommand("ssh-terminal", async (input) => {
      if (!this.options.terminalCommand) throw new HostCommandError("This host opens no SSH terminals.");
      return { command: await this.options.terminalCommand(decodeRef(input)) };
    }, { long: true, audit: { label: "opened an SSH terminal" } });
  }

  /** Settles once nothing runs; for tests and shutdown. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()]);
  }

  dispose(): void {
    this.stopped.abort();
  }
}
