import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import { deployCounts, type DeploymentRecord } from "./deploy-protocol.js";
import { mergeFileContents, type DeployService } from "./deploy.js";
import { readDeployments, setDeploymentStatus } from "./journal.js";
import type { RollbackFilePlan, RollbackPreview, RollbackResult } from "./rollback-protocol.js";
import { seqList } from "./rollback-protocol.js";
import type { ServersStore } from "./store.js";
import { inspectIntents, type DeployIntent, type InspectedIntent } from "./sync/deploy.js";
import { gitCall, type GitCall } from "./sync/git.js";
import { blobId, loadMirrorState, type MirrorState } from "./sync/mirror.js";
import { byPath, isSyncPath } from "./sync/paths.js";
import { answerError, type SyncService, type SyncSession } from "./sync/service.js";

/*
 * Rolling back a deployment (plan §1.5): each file it wrote goes back to the
 * state before it, a file it added is deleted, one it deleted comes back. The
 * server must still hold what the deployment put there; where it does not
 * (a later deployment, a colleague) the file is a conflict, unless the user
 * asks for a three-way merge, which takes only this deployment's change out
 * of the server's file. The rollback is a deployment of its own, so it can
 * be rolled back in turn.
 */

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface RollbackInput {
  cwd: string;
  targetId: string;
  seq: number;
  threeWay: boolean;
  force: Set<string>;
  threadId?: string;
}

function decodeRollbackInput(raw: unknown): RollbackInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  if (typeof input.cwd !== "string" || !input.cwd) throw new HostCommandError("Open a project first.");
  if (typeof input.targetId !== "string" || !input.targetId) throw new HostCommandError("Name the server.");
  if (typeof input.seq !== "number" || !Number.isSafeInteger(input.seq) || input.seq < 1) throw new HostCommandError("Name the deployment to roll back.");
  const force = new Set(Array.isArray(input.force) ? input.force.filter((path): path is string => typeof path === "string" && isSyncPath(path)) : []);
  const threadId = typeof input.threadId === "string" && input.threadId && input.threadId.length <= 200 ? input.threadId : undefined;
  return { cwd: input.cwd, targetId: input.targetId, seq: input.seq, threeWay: input.threeWay === true, force, ...(threadId ? { threadId } : {}) };
}

export interface RollbackServiceOptions {
  store: ServersStore;
  sync: Pick<SyncService, "exclusive">;
  deploy: Pick<DeployService, "execute">;
  git?: GitCall;
}

interface Planned {
  record: DeploymentRecord;
  state: MirrorState;
  /** Files decided without the server. */
  plans: RollbackFilePlan[];
  inspected: Array<InspectedIntent & { plan: RollbackFilePlan }>;
  newer: number[];
}

export class RollbackService {
  private readonly git: GitCall;

  constructor(private readonly context: HostExtensionContext, private readonly options: RollbackServiceOptions) {
    this.git = options.git ?? gitCall();
  }

  private async plan(session: SyncSession, input: RollbackInput, write: boolean): Promise<Planned> {
    const records = await readDeployments(this.options.store, session.key);
    const record = records.find((entry) => entry.seq === input.seq);
    if (!record) throw new HostCommandError(`Tau no longer holds deployment ${input.seq} of this server; its history was cleaned up.`);
    if (record.status === "rolled-back") {
      const undone = records.filter((entry) => entry.kind === "rollback" && entry.rollbackOf === record.seq).at(-1);
      throw new HostCommandError(`Deployment ${record.seq} is rolled back already${undone ? `; roll back ${undone.seq} to bring it back` : ""}.`);
    }
    if (record.files.length === 0) throw new HostCommandError(`Deployment ${record.seq} changed no file on the server.`);
    const state = await loadMirrorState(this.options.store, session.key, session.mirror);
    if (!state) throw new HostCommandError("Tau has not read this server yet: download it first.");
    // The newest later deployment still in force that wrote each path.
    const laterByPath = new Map<string, number>();
    for (const later of records) {
      if (later.seq <= record.seq || later.status === "rolled-back") continue;
      for (const file of later.files) laterByPath.set(file.path, later.seq);
    }
    const plans: RollbackFilePlan[] = [];
    const intents: DeployIntent[] = [];
    for (const file of record.files) {
      const force = input.force.has(file.path) ? { force: true } : {};
      const expect = file.op === "delete" ? null : file.after ?? null;
      if (!file.before) {
        intents.push({ path: file.path, op: "delete", newMode: 0o644, expect, ...force });
        continue;
      }
      const content = await session.mirror.readBlob(file.before).catch(() => undefined);
      if (!content) { plans.push({ path: file.path, op: file.op === "delete" ? "add" : "modify", outcome: "blocked", reason: "Tau no longer holds this file as it was before the deployment." }); continue; }
      intents.push({ path: file.path, op: file.op === "delete" ? "add" : "modify", content, newMode: file.beforeMode ?? 0o644, expect, ...force });
    }
    const fs = await session.connect();
    const inspected = (await inspectIntents(fs, intents, { ...(write ? { mirror: session.mirror } : {}), signal: session.signal })) as Planned["inspected"];
    const name = `${record.kind === "rollback" ? "rollback" : "deployment"} ${record.seq}`;
    for (const item of inspected) {
      const later = laterByPath.get(item.intent.path);
      if (item.plan.outcome !== "conflict") continue;
      if (later) item.plan.newer = later;
      if (item.intent.force) continue;
      if (input.threeWay) await this.mergeInto(session, record, item, write);
      else if (later) item.plan.reason = `Deployment ${later} changed this file afterwards. Roll that back first, or merge three-way.`;
      else item.plan.reason = item.now.kind === "absent"
        ? `Deleted on the server since ${name}.`
        : `Changed on the server since ${name}. Merge three-way, or overwrite it.`;
    }
    const newer = [...new Set(inspected.flatMap((item) => (item.plan.newer ? [item.plan.newer] : [])))].sort((a, b) => b - a);
    return { record, state, plans, inspected, newer };
  }

  /** Takes the deployment's change out of the server's current file; a clean merge goes up instead of the old file. */
  private async mergeInto(session: SyncSession, record: DeploymentRecord, item: Planned["inspected"][number], write: boolean): Promise<void> {
    const file = record.files.find((entry) => entry.path === item.intent.path);
    if (item.now.kind !== "file" || !file?.before || !file.after || item.intent.op !== "modify") {
      item.plan.reason = item.now.kind === "file"
        ? "The server holds another file here now; a merge cannot tell what to keep. Overwrite it, or leave it."
        : "Deleted on the server since; a merge has nothing to work on. Put the old file back anyway, or leave it.";
      return;
    }
    const [after, before] = await Promise.all([session.mirror.readBlob(file.after), session.mirror.readBlob(file.before)]);
    let merged: { data: Buffer; conflicts: number };
    try {
      merged = await mergeFileContents(this.git, { ours: item.now.data, base: after, theirs: before }, ["server", `deployment ${record.seq}`, `before deployment ${record.seq}`]);
    } catch {
      item.plan.reason = "Git cannot merge this file (binary?). Overwrite it with the file from before, or leave it.";
      return;
    }
    if (merged.conflicts > 0) {
      item.plan.reason = `A three-way merge conflicts with the later change in ${merged.conflicts === 1 ? "one place" : `${merged.conflicts} places`}. Overwrite it with the file from before, or leave it.`;
      return;
    }
    if (write) await session.mirror.writeBlob(merged.data);
    const theirs = item.now.entry.oid;
    const name = `${record.kind === "rollback" ? "rollback" : "deployment"} ${record.seq}`;
    item.intent = { ...item.intent, content: merged.data, expect: theirs };
    item.plan = blobId(merged.data) === theirs
      ? { ...item.plan, outcome: "same", merged: true, reason: `The server's file no longer holds ${name}'s change.` }
      : { ...item.plan, outcome: "upload", merged: true, reason: `Merged: ${name}'s change taken out, the later change kept.` };
  }

  private files(planned: Planned): RollbackFilePlan[] {
    return [...planned.plans, ...planned.inspected.map((item) => item.plan)].sort((a, b) => byPath(a.path, b.path));
  }

  async preview(raw: unknown): Promise<RollbackPreview> {
    const input = decodeRollbackInput(raw);
    return this.options.sync.exclusive(input, async (session) => {
      const planned = await this.plan(session, input, false);
      return { targetId: session.target.id, seq: planned.record.seq, files: this.files(planned), newer: planned.newer, threeWay: input.threeWay };
    });
  }

  /** The rollback itself, on the user's click only. */
  async rollback(raw: unknown): Promise<RollbackResult> {
    const input = decodeRollbackInput(raw);
    return this.options.sync.exclusive(input, async (session) => {
      const planned = await this.plan(session, input, true);
      const { record } = planned;
      const fs = await session.connect();
      const outcome = await this.options.deploy.execute(session, planned.state, fs, {
        kind: "rollback",
        rollbackOf: record.seq,
        origin: { actor: "user", via: "view", ...(input.threadId ? { threadId: input.threadId } : {}) },
        plans: planned.plans,
        inspected: planned.inspected,
        subject: (seq, files) => `Rollback ${seq}: deployment ${record.seq} undone (${deployCounts(files)})`,
      });
      if (outcome.deployment) await this.dropCreatedFolders(session, record, outcome.deployment);
      const written = new Set(outcome.deployment?.files.map((file) => file.path));
      const failed = new Set(outcome.failed.map((failure) => failure.path));
      const settled = new Set(outcome.files.filter((file) => (file.outcome === "same" || file.outcome === "gone") && !failed.has(file.path)).map((file) => file.path));
      const rolledBack = record.files.every((file) => written.has(file.path) || settled.has(file.path));
      if (rolledBack) await setDeploymentStatus(this.options.store, session.key, record.seq, "rolled-back");
      const plans = new Map([...planned.plans, ...planned.inspected.map((item) => item.plan)].map((plan) => [plan.path, plan]));
      // The executed outcome wins (a file raced meanwhile), with what the plan knew about it.
      const files = outcome.files.map((file): RollbackFilePlan => ({ ...plans.get(file.path), ...file })).sort((a, b) => byPath(a.path, b.path));
      this.context.services.log("servers.rollback", `deployment ${record.seq}: ${outcome.deployment ? `rollback ${outcome.deployment.seq}` : "nothing written"}${rolledBack ? "" : ", partly"}${planned.newer.length ? `, later ${seqList(planned.newer)}` : ""}`);
      return {
        targetId: session.target.id, seq: record.seq, files, newer: planned.newer, threeWay: input.threeWay,
        ...(outcome.deployment ? { deployment: outcome.deployment } : {}), failed: outcome.failed, rolledBack,
      };
    });
  }

  /**
   * Folders the deployment made for files the rollback deleted: removed again
   * once empty, deepest first. A folder that held a file before stays.
   */
  private async dropCreatedFolders(session: SyncSession, record: DeploymentRecord, rollback: DeploymentRecord): Promise<void> {
    const deleted = rollback.files.filter((file) => file.op === "delete").map((file) => file.path);
    if (deleted.length === 0) return;
    const before = await session.mirror.files(`${record.commit}^`).catch(() => undefined);
    if (!before) return;
    const folders = new Set<string>();
    for (const path of deleted) {
      const parts = path.split("/").slice(0, -1);
      for (let depth = parts.length; depth > 0; depth -= 1) folders.add(parts.slice(0, depth).join("/"));
    }
    const fs = await session.connect();
    const options = { area: "project" as const, signal: session.signal };
    for (const folder of [...folders].sort((a, b) => b.split("/").length - a.split("/").length)) {
      if ([...before.keys()].some((path) => path.startsWith(`${folder}/`))) continue;
      try {
        if ((await fs.list(folder, options)).length === 0) await fs.rmdir(folder, options);
      } catch (error) {
        this.context.services.log("servers.rollback", `left ${folder}: ${message(error)}`);
      }
    }
  }

  /** "Mark as checked", or take it back; a committed or rolled back deployment keeps its status. */
  async mark(raw: unknown): Promise<{ seq: number; status: DeploymentRecord["status"] }> {
    const input = decodeRollbackInput(raw);
    const { seq } = input;
    const checked = (raw as { checked?: unknown }).checked !== false;
    return this.options.sync.exclusive(input, async (session) => {
      const record = (await readDeployments(this.options.store, session.key)).find((entry) => entry.seq === seq);
      if (!record) throw new HostCommandError(`Tau no longer holds deployment ${seq} of this server.`);
      if (record.status !== "uploaded" && record.status !== "verified") throw new HostCommandError(`Deployment ${seq} is ${record.status === "committed" ? "committed" : "rolled back"} already.`);
      const status = checked ? "verified" : "uploaded";
      await setDeploymentStatus(this.options.store, session.key, seq, status);
      return { seq, status };
    });
  }

  register(): void {
    const wrap = <T>(run: (input: unknown) => Promise<T>) => async (input: unknown) => {
      try {
        return await run(input);
      } catch (error) {
        const answered = answerError(error);
        throw answered instanceof HostCommandError ? answered : new HostCommandError(message(error));
      }
    };
    const { context } = this;
    context.registerCommand("rollback-preview", wrap((input) => this.preview(input)), { long: true, access: "read", audit: { label: "previewed a rollback on a server" } });
    // A client's click only: no agent tool rolls back (ADR 0028, decision 1).
    context.registerCommand("rollback", wrap((input) => this.rollback(input)), { long: true, audit: { label: "rolled back a deployment on a server" } });
    context.registerCommand("deployment-mark", wrap((input) => this.mark(input)), { audit: { label: "marked a deployment as checked" } });
  }
}
