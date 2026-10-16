import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import {
  DEPLOY_EVENT, DEPLOY_OP_WORDS, deployCounts, isDeployOp,
  type DeployFilePlan, type DeployOp, type DeployPreview, type DeployRequestFile, type DeployResolveAction, type DeployResolveResult, type DeployResult,
  type DeploymentCheckout, type DeploymentFailure, type DeploymentFile, type DeploymentOrigin, type DeploymentRecord,
} from "./deploy-protocol.js";
import { unmergedDriftPaths, unmergedDriftReason, type DriftState } from "./drift-protocol.js";
import { CommitMarks } from "./commit-mark.js";
import { deployRef, nextDeploySeq, readDeployments, recordDeployment, updateDeployments } from "./journal.js";
import type { ServerFs } from "./server-fs.js";
import type { SftpJsonTarget } from "./sftp-json.js";
import type { ServersStore, TargetKey } from "./store.js";
import { comparePending } from "./sync/compare.js";
import { applyIntents, inspectIntents, readServerFile, writes, type DeployIntent, type InspectedIntent } from "./sync/deploy.js";
import { gitCall, type GitCall } from "./sync/git.js";
import { hasConflictMarkers, readLocalFile, removeLocalFile, writeLocalFile } from "./sync/local.js";
import { entryOf, loadMirrorState, recordMirrorState, saveMirrorState, sortedEntries, type MirrorEntry, type MirrorState } from "./sync/mirror.js";
import { byPath, isSyncPath } from "./sync/paths.js";
import type { SyncChange } from "./sync/protocol.js";
import { scanLocal } from "./sync/scan.js";
import { answerError, type SyncService, type SyncSession } from "./sync/service.js";
import { readTrust, recordLiveConfigs } from "./trust.js";
import { scanText } from "./secrets-scan.js";
import type { ServerFolders } from "./folders.js";
import { diffBlobs } from "./history.js";
import { LOCAL_CHANGES_FILE, completeLocalServerChange, saveLocalServerChange, undoLocalServerChange } from "./local-changes.js";
import { blobId } from "./sync/mirror.js";

/*
 * Deployments (ADR 0028, plan §1.2 and §1.5): the user's upload of chosen
 * pending files. Only a click in a client starts one; the agent proposes and
 * never uploads. Each file is read on the server again right before (the
 * backup, kept in the shadow repository under `refs/tau/deploy/<seq>`), a
 * conflict blocks only its own file, and what went through is journalled in
 * `deployments.json` and becomes the new mirror state.
 */

const OPS: Record<SyncChange, DeployOp> = { added: "add", modified: "modify", deleted: "delete" };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const OUTCOME_ORDER: Record<DeployFilePlan["outcome"], number> = { upload: 0, delete: 1, conflict: 2, blocked: 3, same: 4, gone: 5, stale: 6 };

export interface DeployServiceOptions {
  store: ServersStore;
  sync: Pick<SyncService, "exclusive">;
  /** A project's target by id, keyed by its main checkout; reads no server. */
  target(cwd: string, targetId: string): Promise<{ project: { root: string; workspaceId: string }; target: SftpJsonTarget }>;
  /** Unmerged drift branches block their paths; deployed paths leave the last drift check. */
  drift?: {
    state(cwd: string): Promise<DriftState>;
    settled(key: TargetKey, root: string, paths: readonly string[]): Promise<void>;
  };
  git?: GitCall;
  now?(): Date;
  folders?: Pick<ServerFolders, "check">;
}

/** What `execute` writes and how the deployment it records reads. */
export interface DeploymentSpec {
  kind: DeploymentRecord["kind"];
  rollbackOf?: number;
  origin: DeploymentOrigin;
  note?: string;
  checkout?: DeploymentCheckout;
  /** Chosen files decided without the server. */
  plans: DeployFilePlan[];
  inspected: InspectedIntent[];
  /** The deployment commit's subject. */
  subject(seq: number, files: readonly DeploymentFile[]): string;
}

interface DeployInput {
  cwd: string;
  targetId: string;
  files: DeployRequestFile[];
  force: Set<string>;
  threadId?: string;
  via: "view" | "card";
  note?: string;
  operationId?: string;
  preview?: Pick<DeployPreview, "source" | "observed" | "local">;
}

function decodeRef(raw: unknown): { cwd: string; targetId: string; operationId?: string } {
  const input = (raw ?? {}) as Record<string, unknown>;
  if (typeof input.cwd !== "string" || !input.cwd) throw new HostCommandError("Open a project first.");
  if (typeof input.targetId !== "string" || !input.targetId) throw new HostCommandError("Name the server.");
  return { cwd: input.cwd, targetId: input.targetId, ...(typeof input.operationId === "string" ? { operationId: input.operationId } : {}) };
}

export function decodeDeployInput(raw: unknown): DeployInput {
  const ref = decodeRef(raw);
  const input = raw as Record<string, unknown>;
  const files = new Map<string, DeployRequestFile>();
  for (const item of Array.isArray(input.files) ? input.files : []) {
    const { path, op } = (item ?? {}) as Record<string, unknown>;
    if (typeof path === "string" && isSyncPath(path) && isDeployOp(op)) files.set(path, { path, op });
  }
  if (!files.size) throw new HostCommandError("Choose at least one file to upload.");
  const force = new Set(Array.isArray(input.force) ? input.force.filter((path): path is string => typeof path === "string" && isSyncPath(path)) : []);
  const threadId = typeof input.threadId === "string" && input.threadId && input.threadId.length <= 200 ? input.threadId : undefined;
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 2000) : undefined;
  return { ...ref, files: [...files.values()], force, via: input.via === "card" ? "card" : "view", ...(threadId ? { threadId } : {}), ...(note ? { note } : {}), ...(typeof input.operationId === "string" ? { operationId: input.operationId } : {}), ...(input.preview && typeof input.preview === "object" ? { preview: input.preview as DeployInput["preview"] } : {}) };
}

interface Prepared {
  state: MirrorState;
  /** Chosen files decided without the server: stale or blocked. */
  plans: DeployFilePlan[];
  intents: DeployIntent[];
  kept: string[];
}

const execBit = (mode: number) => (mode & 0o111) !== 0;
const sameEntry = (a: MirrorEntry | undefined, b: MirrorEntry | undefined) => a?.oid === b?.oid && (a === undefined || execBit(a.mode) === execBit(b!.mode));

/** Same tree in the shadow repository: the same paths with the same blobs and executable bits. */
function sameTree(a: ReadonlyMap<string, MirrorEntry>, b: ReadonlyMap<string, MirrorEntry>): boolean {
  if (a.size !== b.size) return false;
  for (const [path, entry] of a) if (!sameEntry(entry, b.get(path))) return false;
  return true;
}

const byOutcome = (a: DeployFilePlan, b: DeployFilePlan) => OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome] || byPath(a.path, b.path);

/** Upload preview, upload, conflict resolution and the journal of a project's targets. */
export class DeployService {
  private readonly git: GitCall;
  readonly marks: CommitMarks;

  constructor(private readonly context: HostExtensionContext, private readonly options: DeployServiceOptions) {
    this.git = options.git ?? gitCall();
    this.marks = new CommitMarks(options.store, this.git);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async readGit(cwd: string, args: string[]): Promise<string | undefined> {
    const result = await this.git(args, { cwd, env: { GIT_OPTIONAL_LOCKS: "0" } }).catch(() => undefined);
    return result?.code === 0 ? result.stdout.toString("utf8").trim() : undefined;
  }

  private async checkout(path: string): Promise<DeploymentCheckout> {
    const [branch, head] = await Promise.all([
      this.readGit(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      this.readGit(path, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
    ]);
    return { path, ...(branch ? { branch } : {}), ...(head ? { head } : {}) };
  }

  /**
   * The chosen files against the pending list as it is now: only what is
   * still pending as chosen goes on to the server; the upload block list,
   * unmerged drift branches and unresolved conflict markers never do.
   */
  private async prepare(session: SyncSession, input: DeployInput): Promise<Prepared> {
    const local = await scanLocal(session.localDir, session.ignore, { signal: session.signal });
    const state = await loadMirrorState(this.options.store, session.key, session.mirror)
      ?? await saveMirrorState(this.options.store, session.key, session.mirror, new Map(), "Server files have not been read yet", new Set());
    const { uploadBlocklist } = await readTrust(this.options.store, session.key);
    const pending = await comparePending(session.localDir, local, state, session.ignore, { thorough: true, blocklist: uploadBlocklist, signal: session.signal });
    const rows = new Map(pending.rows.map((row) => [row.path, row]));
    const withheld = new Set(pending.withheld);
    const drift = await this.options.drift?.state(session.workspace).catch(() => undefined);
    const unmerged = unmergedDriftPaths(drift, session.target.id);
    const plans: DeployFilePlan[] = [];
    const intents: DeployIntent[] = [];
    for (const { path, op } of input.files) {
      const row = rows.get(path);
      if (withheld.has(path) || uploadBlocklist.includes(path)) { plans.push({ path, op, outcome: "blocked", reason: "On the upload block list: Tau never uploads it." }); continue; }
      if (!row) { plans.push({ path, op, outcome: "stale", reason: "No longer differs from the server as Tau last read it." }); continue; }
      if (OPS[row.change] !== op) { plans.push({ path, op, outcome: "stale", reason: `Now ${DEPLOY_OP_WORDS[OPS[row.change]]} here, not ${DEPLOY_OP_WORDS[op]}; choose it again.` }); continue; }
      const branch = unmerged.get(path);
      if (branch) { plans.push({ path, op, outcome: "blocked", reason: unmergedDriftReason(branch) }); continue; }
      const expect = state.known && !state.known.has(path) ? undefined : state.entries.get(path)?.oid ?? null;
      const force = input.force.has(path) ? { force: true } : {};
      if (op === "delete") { intents.push({ path, op, newMode: 0o644, expect, ...force }); continue; }
      const file = await readLocalFile(session.localDir, path);
      if (!file) { plans.push({ path, op, outcome: "stale", reason: "The local file is gone or no regular file." }); continue; }
      if (hasConflictMarkers(file.data)) { plans.push({ path, op, outcome: "blocked", reason: "Holds conflict markers from a merge; resolve them before uploading." }); continue; }
      intents.push({ path, op, content: file.data, newMode: session.target.filePerm ?? (execBit(file.mode) ? 0o755 : 0o644), expect, ...force });
    }
    const chosen = new Set(input.files.map((file) => file.path));
    const kept = pending.rows.filter((row) => row.change === "deleted" && !chosen.has(row.path)).map((row) => row.path);
    return { state, plans, intents, kept };
  }

  /** A path the last deployment took from another branch than this upload's. */
  private async warnings(key: TargetKey, checkout: DeploymentCheckout, files: readonly DeployFilePlan[]): Promise<string[]> {
    if (!checkout.branch) return [];
    const records = await readDeployments(this.options.store, key);
    const others = new Map<string, string[]>();
    for (const file of files) {
      if (!writes(file)) continue;
      const last = [...records].reverse().find((record) => record.files.some((entry) => entry.path === file.path));
      const branch = last?.checkout.branch;
      if (branch && branch !== checkout.branch) others.set(branch, [...(others.get(branch) ?? []), file.path]);
    }
    return [...others].map(([branch, paths]) => {
      const named = paths.slice(0, 5).join(", ") + (paths.length > 5 ? ` and ${paths.length - 5} more` : "");
      return `${named} last went up from ${branch}; this upload is from ${checkout.branch}.`;
    });
  }

  /** What an upload of the chosen files would do; reads the server, writes nothing there. */
  async preview(raw: unknown): Promise<DeployPreview> {
    const input = decodeDeployInput(raw);
    return this.options.sync.exclusive(input, async (session) => {
      const folder = await this.options.folders?.check(session);
      if (folder?.weak) return { targetId: session.target.id, files: [], kept: [], warnings: [], folder };
      const prepared = await this.prepare(session, input);
      const fs = await session.connect();
      const inspected = await inspectIntents(fs, prepared.intents, { mirror: session.mirror, signal: session.signal });
      session.signal.throwIfAborted();
      const findings = inspected.flatMap(({ intent, now }) => now.kind === "file" && now.data.length <= 1024 * 1024 ? scanText(intent.path, now.data.toString("utf8")) : []);
      await recordLiveConfigs(this.options.store, session.key, findings, inspected.map(({ intent }) => intent.path));
      for (const item of inspected) {
        if (item.intent.expect === undefined && item.plan.outcome === "upload" && findings.some((finding) => finding.path === item.intent.path)) item.plan = { ...item.plan, outcome: "conflict", forced: false, reason: "This server file holds live credentials. Review its settings before replacing it." };
      }
      // Learn only the selected paths. Never replace a known base with a colleague's new edit.
      const entries = new Map(prepared.state.entries);
      const known = prepared.state.known ? new Set(prepared.state.known) : undefined;
      for (const { intent, now } of inspected) {
        if (intent.expect !== undefined || now.kind === "other") continue;
        known?.add(intent.path);
        if (now.kind === "file") entries.set(intent.path, now.entry); else entries.delete(intent.path);
      }
      if (inspected.some(({ intent, now }) => intent.expect === undefined && now.kind !== "other")) await saveMirrorState(this.options.store, session.key, session.mirror, entries, "Read selected files for an upload preview", known);
      const files = [...prepared.plans, ...inspected.map((item) => item.plan)].sort(byOutcome);
      const checkout = await this.checkout(session.workspace);
      return { targetId: session.target.id, files, kept: prepared.kept, warnings: await this.warnings(session.key, checkout, files), checkout, source: this.source(checkout), local: Object.fromEntries(prepared.intents.map((intent) => [intent.path, this.localVersion(intent)])), observed: Object.fromEntries(inspected.filter(({ now }) => now.kind !== "other").map(({ intent, now }) => [intent.path, now.kind === "file" ? now.entry.oid : null])) };
    });
  }

  private source(checkout: DeploymentCheckout): string {
    return createHash("sha256").update(JSON.stringify(checkout)).digest("hex");
  }

  private localVersion(intent: DeployIntent): string {
    return createHash("sha256").update(`${intent.op === "delete" ? "delete" : intent.newMode}\0`).update(intent.content ?? Buffer.alloc(0)).digest("hex");
  }

  /** The upload itself, on the user's click. */
  async deploy(raw: unknown): Promise<DeployResult> {
    const input = decodeDeployInput(raw);
    const result = await this.options.sync.exclusive(input, (session) => this.run(session, input));
    return result;
  }

  private async run(session: SyncSession, input: DeployInput): Promise<DeployResult> {
    if (this.options.folders && (await readDeployments(this.options.store, session.key)).some((record) => record.status === "in-progress" || record.status === "incomplete")) throw new HostCommandError("Review the interrupted upload in History before starting another upload.");
    const folder = await this.options.folders?.check(session);
    if (folder?.weak) throw new HostCommandError("Check the server folder before uploading. Nothing was written.");
    const prepared = await this.prepare(session, input);
    const checkout = await this.checkout(session.workspace);
    if (this.options.folders && !input.preview?.source) throw new HostCommandError("Review an upload preview before confirming it.");
    if (input.preview?.source && (input.preview.source !== this.source(checkout) || prepared.intents.some((intent) => input.preview?.local?.[intent.path] !== this.localVersion(intent)))) throw new HostCommandError("The branch or selected files changed after the preview. Review the upload again.");
    if (prepared.intents.some((intent) => intent.expect === undefined)) throw new HostCommandError("Preview these files before uploading them for the first time.");
    const fs = await session.connect();
    // Reading again is the backup: every blob read lands in the shadow repository before a write.
    const inspected = await inspectIntents(fs, prepared.intents, { mirror: session.mirror, signal: session.signal });
    for (const item of inspected) {
      const observed = input.preview?.observed?.[item.intent.path];
      const current = item.now.kind === "file" ? item.now.entry.oid : null;
      if (observed !== undefined && current !== observed && item.now.kind !== "other") {
        item.plan = { ...item.plan, outcome: "conflict", forced: false, reason: "Changed on the server after the upload preview. Review it again." };
      }
    }
    const outcome = await this.execute(session, prepared.state, fs, {
      kind: "upload",
      checkout,
      origin: { actor: "user", via: input.via, ...(input.threadId ? { threadId: input.threadId } : {}) },
      ...(input.note ? { note: input.note } : {}),
      plans: prepared.plans,
      inspected,
      subject: (seq, files) => `Deployment ${seq}: ${deployCounts(files)}`,
    });
    return { targetId: session.target.id, ...outcome };
  }

  /** Explicit file inspection reads exactly one server file; no tree traversal. */
  async fileDiff(raw: unknown) {
    const ref = decodeRef(raw);
    const path = (raw as { path?: unknown }).path;
    if (typeof path !== "string" || !isSyncPath(path)) throw new HostCommandError("Choose a file.");
    return this.options.sync.exclusive(ref, async (session) => {
      await session.mirror.ensure();
      const now = await readServerFile(await session.connect(), path, session.signal);
      if (now.kind === "other") throw new HostCommandError("The server path is not a regular file.");
      const local = await readLocalFile(session.localDir, path);
      const before = now.kind === "file" ? await session.mirror.writeBlob(now.data) : undefined;
      const after = local ? await session.mirror.writeBlob(local.data) : undefined;
      return diffBlobs(this.git, session.mirror, path, before, after);
    }, { recover: false });
  }

  /**
   * Writes what the inspected intents say should go and records it: the
   * journal and backup before the first write, then the deployment commit,
   * mirror state and completed journal entry. An upload and a rollback both end here.
   */
  async execute(session: SyncSession, state: MirrorState, fs: ServerFs, spec: DeploymentSpec): Promise<Omit<DeployResult, "targetId">> {
    const { store } = this.options;
    const { inspected } = spec;
    const at = this.now();
    // The mirror after: what went up, plus what the server turned out to hold already.
    const next = new Map(state.entries);
    for (const { plan, now } of inspected) {
      if (plan.outcome === "same" && now.kind === "file") next.set(plan.path, now.entry);
      if (plan.outcome === "gone") next.delete(plan.path);
    }
    let deployment: DeploymentRecord | undefined;
    let failed: DeploymentFailure[] = [];
    const raced = new Map<string, DeployFilePlan>();
    const settled = inspected.filter(({ plan }) => plan.outcome === "same" || plan.outcome === "gone").map(({ plan }) => plan.path);
    if (inspected.some(({ plan }) => writes(plan))) {
      const seq = await nextDeploySeq(await readDeployments(store, session.key), this.git, session.mirror);
      const before = serverBefore(state, inspected);
      const beforeCommit = sameTree(before, state.entries)
        ? state.commit
        : await session.mirror.commit(sortedEntries(before), `Server state ${fs.root} ${at.toISOString()} (before deployment ${seq})`, state.commit);
      const checkout = spec.checkout ?? await this.checkout(session.workspace);
      const planned = new Map(before);
      const plannedFiles: DeploymentFile[] = [];
      for (const { intent, now, plan } of inspected) {
        if (!writes(plan)) continue;
        const old = now.kind === "file" ? { before: now.entry.oid, beforeMode: now.stat.mode } : {};
        if (intent.op === "delete") {
          planned.delete(intent.path);
          plannedFiles.push({ path: intent.path, op: "delete", ...old });
        } else {
          const mode = now.kind === "file" ? now.stat.mode : intent.newMode;
          const entry = entryOf(intent.content ?? Buffer.alloc(0), { mode, mtime: 0 });
          planned.set(intent.path, entry);
          plannedFiles.push({ path: intent.path, op: intent.op, ...old, after: entry.oid, mode });
        }
      }
      // Keep both planned blobs and the backup reachable before the first server write.
      const plannedCommit = await session.mirror.commit(sortedEntries(planned), `Deployment ${seq} in progress`, beforeCommit);
      await session.mirror.setRef(deployRef(seq), plannedCommit);
      await recordDeployment(store, session.key, {
        seq, kind: spec.kind, ...(spec.rollbackOf !== undefined ? { rollbackOf: spec.rollbackOf } : {}),
        at: at.toISOString(), origin: spec.origin, checkout, context: session.target.context,
        files: plannedFiles, failed: [], skipped: [...spec.plans, ...inspected.filter(({ plan }) => !writes(plan)).map(({ plan }) => plan)].sort(byOutcome), status: "in-progress",
        commit: plannedCommit, mirrorCommit: state.commit, ...(spec.note ? { note: spec.note } : {}),
      });
      const outcome = await applyIntents(fs, inspected, { dirMode: session.target.dirPerm ?? 0o755, signal: session.signal });
      failed = outcome.failed;
      for (const plan of outcome.raced) raced.set(plan.path, plan);
      if (outcome.applied.length === 0) {
        // Nothing went up: no deployment. A failed write may have left the server half-written, so the backup stays.
        if (!failed.length) {
          await updateDeployments(store, session.key, (records) => records.filter((record) => record.seq !== seq));
          await session.mirror.deleteRef(deployRef(seq));
        }
      } else {
        const after = new Map(before);
        for (const { file, entry } of outcome.applied) {
          if (entry) { after.set(file.path, entry); next.set(file.path, entry); } else { after.delete(file.path); next.delete(file.path); }
          settled.push(file.path);
        }
        const files = outcome.applied.map(({ file }) => file).sort((a, b) => byPath(a.path, b.path));
        const subject = spec.subject(seq, files);
        const body = [`From ${checkout.branch ?? "a detached HEAD"}${checkout.head ? ` at ${checkout.head.slice(0, 12)}` : ""} in ${checkout.path}.`, spec.note ?? ""].filter(Boolean).join("\n\n");
        const commit = await session.mirror.commit(sortedEntries(after), `${subject}\n\n${body}`, beforeCommit);
        await session.mirror.setRef(deployRef(seq), commit);
        // The mirror state is the deployment's own commit whenever it holds the same tree.
        const mirrorCommit = sameTree(after, next)
          ? (await recordMirrorState(store, session.key, session.mirror, next, commit, state.commit)).commit
          : (await saveMirrorState(store, session.key, session.mirror, next, subject)).commit;
        const done = new Set(files.map((file) => file.path));
        const failedPaths = new Set(failed.map((failure) => failure.path));
        deployment = {
          seq,
          kind: spec.kind,
          ...(spec.rollbackOf !== undefined ? { rollbackOf: spec.rollbackOf } : {}),
          at: at.toISOString(),
          origin: spec.origin,
          checkout,
          context: session.target.context,
          files,
          failed,
          skipped: [...spec.plans, ...inspected.map(({ plan }) => raced.get(plan.path) ?? plan)].filter((plan) => !done.has(plan.path) && !failedPaths.has(plan.path)).sort(byOutcome),
          status: "uploaded",
          commit,
          mirrorCommit,
          ...(spec.note ? { note: spec.note } : {}),
        };
        await recordDeployment(store, session.key, deployment);
      }
    }
    if (!deployment && !sameTree(next, state.entries)) {
      await saveMirrorState(store, session.key, session.mirror, next, `Server state ${fs.root} ${at.toISOString()} (read for ${spec.kind === "rollback" ? "a rollback" : "an upload"})`);
    }
    await this.settle(session, settled, deployment?.seq);
    const files = [...spec.plans, ...inspected.map(({ plan }) => raced.get(plan.path) ?? plan)].sort(byOutcome);
    return { ...(deployment ? { deployment } : {}), files, failed };
  }

  private async settle(session: SyncSession, paths: readonly string[], seq?: number): Promise<void> {
    const root = (await this.options.target(session.workspace, session.target.id).catch(() => undefined))?.project.root ?? session.workspace;
    await this.options.drift?.settled(session.key, root, paths).catch((error: unknown) => this.context.services.log("servers.deploy", `drift not updated: ${message(error)}`));
    this.context.emit(DEPLOY_EVENT, { workspace: session.workspace, targetId: session.target.id, ...(seq ? { seq } : {}) });
  }

  /**
   * A conflict resolved locally: the server's file replaces the local one, or
   * `git merge-file` merges it in with conflict markers. Either way the
   * server's file becomes the mirror state of that path, so the next upload
   * goes over it knowingly.
   */
  async resolve(raw: unknown): Promise<DeployResolveResult> {
    const ref = decodeRef(raw);
    const input = raw as { path?: unknown; action?: unknown };
    if (typeof input.path !== "string" || !isSyncPath(input.path)) throw new HostCommandError("Name a file of the target.");
    if (input.action !== "take-server" && input.action !== "merge") throw new HostCommandError("Choose to take the server's file or to merge it.");
    const path = input.path;
    const action: DeployResolveAction = input.action;
    return this.options.sync.exclusive(ref, async (session) => {
      const state = await loadMirrorState(this.options.store, session.key, session.mirror)
        ?? await saveMirrorState(this.options.store, session.key, session.mirror, new Map(), "Read selected server file", new Set());
      const fs = await session.connect();
      const now = await readServerFile(fs, path, session.signal);
      if (now.kind === "other") throw new HostCommandError(`On the server ${path} is a ${now.stat.type}, not a file.`);
      const local = await readLocalFile(session.localDir, path);
      // Both sides stay in the shadow repository, whatever the local file becomes.
      if (now.kind === "file") await session.mirror.writeBlob(now.data);
      if (local) await session.mirror.writeBlob(local.data);
      let conflicts = 0;
      let data = now.kind === "file" ? now.data : undefined;
      let mode = now.kind === "file" && execBit(now.stat.mode) ? 0o755 : 0o644;
      if (action === "merge") {
        if (!local || now.kind !== "file") throw new HostCommandError(`Merging needs ${path} here and on the server.`);
        const base = state.entries.get(path);
        if (!base) throw new HostCommandError("No shared file version is known yet. Compare both versions before replacing either.");
        const merged = await mergeFileContents(this.git, { ours: local.data, base: await session.mirror.readBlob(base.oid), theirs: now.data }, ["local", "last read from the server", "server"]);
        data = merged.data; conflicts = merged.conflicts; mode = local.mode;
      }
      const backup = await saveLocalServerChange(this.options.store, session, path, local, data);
      const latest = await readLocalFile(session.localDir, path);
      if ((latest ? blobId(latest.data) : undefined) !== (local ? blobId(local.data) : undefined)) throw new HostCommandError("This file changed locally while reading the server. Review it again.");
      session.signal.throwIfAborted();
      if (data) await writeLocalFile(session.localDir, path, data, { mode });
      else await removeLocalFile(session.localDir, path);
      await completeLocalServerChange(this.options.store, session, backup.id);
      const result: DeployResolveResult = { path, action, conflicts, ...(data ? {} : { deleted: true }), undoId: backup.id };
      const next = new Map(state.entries);
      if (now.kind === "file") next.set(path, now.entry); else next.delete(path);
      if (!sameTree(next, state.entries) || next.get(path)?.mtime !== state.entries.get(path)?.mtime) {
        await saveMirrorState(this.options.store, session.key, session.mirror, next, `Server state ${fs.root} ${this.now().toISOString()} (${action === "merge" ? "merged" : "taken"}: ${path})`, state.known ? new Set([...state.known, path]) : undefined);
      }
      await this.settle(session, [path]);
      return result;
    });
  }

  /** The journal of a target, newest first. */
  async list(raw: unknown): Promise<{ targetId: string; deployments: DeploymentRecord[] }> {
    const { cwd, targetId } = decodeRef(raw);
    const workspace = await this.context.services.knownWorkspacePath(cwd);
    const { project, target } = await this.options.target(workspace, targetId);
    return { targetId: target.id, deployments: (await readDeployments(this.options.store, { workspaceId: project.workspaceId, targetId: target.id })).reverse() };
  }

  /** Threads with a deployment their checkout's HEAD does not hold yet; marks the ones it holds `committed`. */
  uncommittedThreads(key: TargetKey, root: string): Promise<string[]> {
    return this.marks.uncommittedThreads(key, root);
  }

  register(): void {
    const { context } = this;
    const wrap = <T>(run: (input: unknown) => Promise<T>) => async (input: unknown) => {
      try {
        return await run(input);
      } catch (error) {
        const answered = answerError(error);
        throw answered instanceof HostCommandError ? answered : new HostCommandError(message(error));
      }
    };
    context.registerCommand("deploy-preview", wrap((input) => this.preview(input)), { long: true, access: "read", audit: { label: "previewed an upload to a server" } });
    // A client's click only: no agent tool calls this (ADR 0028, decision 1).
    context.registerCommand("deploy", wrap((input) => this.deploy(input)), { long: true, audit: { label: "uploaded to a server" } });
    context.registerCommand("deploy-resolve", wrap((input) => this.resolve(input)), { long: true, audit: { label: "resolved an upload conflict locally" } });
    context.registerCommand("deployments", wrap((input) => this.list(input)), { access: "read" });
    context.registerCommand("server-file-diff", wrap((input) => this.fileDiff(input)), { long: true, access: "read" });
    context.registerCommand("local-server-history", wrap(async (raw) => {
      const { cwd, targetId } = decodeRef(raw);
      const workspace = await this.context.services.knownWorkspacePath(cwd);
      const { project, target } = await this.options.target(workspace, targetId);
      const file = await this.options.store.read({ workspaceId: project.workspaceId, targetId: target.id }, LOCAL_CHANGES_FILE);
      return { changes: (file?.changes ?? []).filter((change) => change.workspace === workspace).reverse() };
    }), { access: "read" });
    context.registerCommand("undo-server-take", wrap(async (raw) => {
      const ref = decodeRef(raw);
      const id = (raw as { id?: unknown }).id;
      if (typeof id !== "string") throw new HostCommandError("Choose a local change to undo.");
      return this.options.sync.exclusive(ref, async (session) => {
        await undoLocalServerChange(this.options.store, session, id);
        await this.settle(session, []);
        return { undone: true };
      }, { recover: false });
    }), { audit: { label: "undid taking a server file locally" } });
  }
}

/**
 * `git merge-file` of three versions, labelled ours, base, theirs; the answer
 * holds conflict markers where both sides changed the same lines.
 */
export async function mergeFileContents(git: GitCall, versions: { ours: Buffer; base: Buffer; theirs: Buffer }, labels: readonly [string, string, string]): Promise<{ data: Buffer; conflicts: number }> {
  const dir = await mkdtemp(join(tmpdir(), "tau-merge-"));
  try {
    await Promise.all([writeFile(join(dir, "ours"), versions.ours), writeFile(join(dir, "base"), versions.base), writeFile(join(dir, "theirs"), versions.theirs)]);
    const out = await git(["merge-file", "-p", "-L", labels[0], "-L", labels[1], "-L", labels[2], "ours", "base", "theirs"], { cwd: dir });
    if (out.code === null || out.code < 0 || out.code > 127) throw new HostCommandError(`git could not merge the file: ${out.stderr.trim() || `exit ${out.code}`}`);
    return { data: out.stdout, conflicts: out.code };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The server before the upload: the mirror state, with every chosen path as it was just read. */
function serverBefore(state: MirrorState, inspected: readonly InspectedIntent[]): Map<string, MirrorEntry> {
  const before = new Map(state.entries);
  for (const { intent, now } of inspected) {
    if (now.kind === "file") before.set(intent.path, now.entry);
    else if (now.kind === "absent") before.delete(intent.path);
  }
  return before;
}
