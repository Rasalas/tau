import type { DeployFilePlan, DeploymentFailure, DeploymentFile, DeploymentOrigin, DeploymentRecord } from "./deploy-protocol.js";
import { isDeployOp } from "./deploy-protocol.js";
import type { DeploymentStatus } from "./protocol.js";
import type { ServersStore, TargetFileSpec, TargetKey } from "./store.js";
import { gitOk, type GitCall } from "./sync/git.js";
import type { Mirror } from "./sync/mirror.js";
import { isSyncPath } from "./sync/paths.js";

/*
 * The deployment journal: `deployments.json` in the target's folder, one
 * record per deployment, oldest first. Each record's blobs are kept alive by
 * `refs/tau/deploy/<seq>` in the shadow repository: a commit whose tree is the
 * server after the deployment and whose parent is the server before it.
 */

export const DEPLOY_REF_PREFIX = "refs/tau/deploy/";

export function deployRef(seq: number): `refs/tau/deploy/${number}` {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error(`Not a deployment number: ${seq}`);
  return `refs/tau/deploy/${seq}`;
}

export interface DeploymentsFile extends Record<string, unknown> {
  deployments: DeploymentRecord[];
}

const HEX = /^[0-9a-f]{40,64}$/u;
const STATUSES: readonly DeploymentStatus[] = ["uploaded", "verified", "committed", "rolled-back"];
const OUTCOMES = new Set(["upload", "delete", "same", "gone", "conflict", "blocked", "stale"]);
const str = (value: unknown): value is string => typeof value === "string";
const oid = (value: unknown) => (str(value) && HEX.test(value) ? value : undefined);
const mode = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0o7777 ? value : undefined);

function decodeFile(value: unknown): DeploymentFile | undefined {
  const raw = (value ?? {}) as Record<string, unknown>;
  if (!str(raw.path) || !isSyncPath(raw.path) || !isDeployOp(raw.op)) return undefined;
  const before = oid(raw.before);
  const after = oid(raw.after);
  const beforeMode = mode(raw.beforeMode);
  const afterMode = mode(raw.mode);
  return {
    path: raw.path,
    op: raw.op,
    ...(before ? { before } : {}),
    ...(beforeMode !== undefined ? { beforeMode } : {}),
    ...(after ? { after } : {}),
    ...(afterMode !== undefined ? { mode: afterMode } : {}),
    ...(raw.written === "rename" || raw.written === "in-place" ? { written: raw.written } : {}),
  };
}

function decodeFailure(value: unknown): DeploymentFailure | undefined {
  const raw = (value ?? {}) as Record<string, unknown>;
  return str(raw.path) && isDeployOp(raw.op) && str(raw.message) ? { path: raw.path, op: raw.op, message: raw.message } : undefined;
}

function decodePlan(value: unknown): DeployFilePlan | undefined {
  const raw = (value ?? {}) as Record<string, unknown>;
  if (!str(raw.path) || !isDeployOp(raw.op) || !str(raw.outcome) || !OUTCOMES.has(raw.outcome)) return undefined;
  return { path: raw.path, op: raw.op, outcome: raw.outcome as DeployFilePlan["outcome"], ...(str(raw.reason) ? { reason: raw.reason } : {}), ...(raw.forced === true ? { forced: true } : {}) };
}

function decodeOrigin(value: unknown): DeploymentOrigin {
  const raw = (value ?? {}) as Record<string, unknown>;
  return { actor: "user", via: raw.via === "card" ? "card" : "view", ...(str(raw.threadId) && raw.threadId ? { threadId: raw.threadId } : {}) };
}

const list = <T>(value: unknown, decode: (item: unknown) => T | undefined): T[] => (Array.isArray(value) ? value.flatMap((item) => decode(item) ?? []) : []);

export function decodeDeployment(value: unknown): DeploymentRecord | undefined {
  const raw = (value ?? {}) as Record<string, unknown>;
  const seq = raw.seq;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1 || !str(raw.at) || !oid(raw.commit) || !oid(raw.mirrorCommit)) return undefined;
  const checkout = (raw.checkout ?? {}) as Record<string, unknown>;
  if (!str(checkout.path)) return undefined;
  const rollbackOf = typeof raw.rollbackOf === "number" && Number.isSafeInteger(raw.rollbackOf) ? raw.rollbackOf : undefined;
  return {
    seq,
    kind: raw.kind === "rollback" ? "rollback" : "upload",
    ...(rollbackOf !== undefined ? { rollbackOf } : {}),
    at: raw.at,
    origin: decodeOrigin(raw.origin),
    checkout: { path: checkout.path, ...(str(checkout.branch) ? { branch: checkout.branch } : {}), ...(oid(checkout.head) ? { head: checkout.head as string } : {}) },
    context: str(raw.context) ? raw.context : "",
    files: list(raw.files, decodeFile),
    failed: list(raw.failed, decodeFailure),
    skipped: list(raw.skipped, decodePlan),
    status: STATUSES.includes(raw.status as DeploymentStatus) ? raw.status as DeploymentStatus : "uploaded",
    commit: raw.commit as string,
    mirrorCommit: raw.mirrorCommit as string,
    ...(str(raw.note) && raw.note ? { note: raw.note } : {}),
  };
}

export const DEPLOYMENTS_FILE: TargetFileSpec<DeploymentsFile> = {
  name: "deployments.json",
  version: 1,
  decode(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const { version: _version, deployments, ...rest } = value as Record<string, unknown>;
    const records = list(deployments, decodeDeployment).sort((a, b) => a.seq - b.seq);
    return { ...rest, deployments: records };
  },
};

export async function readDeployments(store: ServersStore, key: TargetKey): Promise<DeploymentRecord[]> {
  return (await store.read(key, DEPLOYMENTS_FILE))?.deployments ?? [];
}

// Read-modify-write per target in call order, so a status change and a new record both land.
const queues = new Map<string, Promise<unknown>>();

export function updateDeployments(store: ServersStore, key: TargetKey, change: (records: DeploymentRecord[]) => DeploymentRecord[]): Promise<DeploymentRecord[]> {
  let dir: string;
  try { dir = store.targetDir(key); } catch (error) { return Promise.reject(error); }
  const run = async () => {
    const current = await store.read(key, DEPLOYMENTS_FILE);
    const next = change(current?.deployments ?? []).sort((a, b) => a.seq - b.seq);
    await store.write(key, DEPLOYMENTS_FILE, { ...current, deployments: next });
    return next;
  };
  const result = (queues.get(dir) ?? Promise.resolve()).then(run, run);
  const settled = result.catch(() => undefined);
  queues.set(dir, settled);
  void settled.then(() => { if (queues.get(dir) === settled) queues.delete(dir); });
  return result;
}

export function recordDeployment(store: ServersStore, key: TargetKey, record: DeploymentRecord): Promise<DeploymentRecord[]> {
  return updateDeployments(store, key, (records) => [...records.filter((entry) => entry.seq !== record.seq), record]);
}

/** Changes one record's status (I11: verified, committed, rolled-back); the history itself stays. */
export function setDeploymentStatus(store: ServersStore, key: TargetKey, seq: number, status: DeploymentStatus): Promise<DeploymentRecord[]> {
  return updateDeployments(store, key, (records) => records.map((record) => (record.seq === seq ? { ...record, status } : record)));
}

/** Refs of the shadow repository under `refs/tau/deploy/`, by number; a crash may leave one without a record. */
export async function deployRefs(git: GitCall, mirror: Mirror): Promise<Map<number, string>> {
  const out = await gitOk(git, ["for-each-ref", "--format=%(refname) %(objectname)", DEPLOY_REF_PREFIX], { cwd: mirror.dir, env: mirror.gitEnv() });
  const refs = new Map<number, string>();
  for (const line of out.toString("utf8").split("\n")) {
    const match = /^refs\/tau\/deploy\/(\d+) ([0-9a-f]{40,64})$/u.exec(line.trim());
    if (match) refs.set(Number(match[1]), match[2]!);
  }
  return refs;
}

/** The next deployment number: past every record and every ref. */
export async function nextDeploySeq(records: readonly DeploymentRecord[], git: GitCall, mirror: Mirror): Promise<number> {
  const refs = await deployRefs(git, mirror);
  return Math.max(0, ...records.map((record) => record.seq), ...refs.keys()) + 1;
}

/**
 * Whether the files of a deployment are what `head` (path in the project → blob id) holds:
 * every uploaded file with the blob that went up, every deleted one absent.
 */
export function heldBy(record: Pick<DeploymentRecord, "files" | "context">, head: ReadonlyMap<string, string>): boolean {
  if (record.files.length === 0) return false;
  const prefix = record.context ? `${record.context}/` : "";
  return record.files.every((file) => (file.op === "delete" ? !head.has(`${prefix}${file.path}`) : head.get(`${prefix}${file.path}`) === file.after));
}
