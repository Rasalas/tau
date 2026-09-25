// Server drift as the host half reports it; no imports, so the desktop half may read it.
// Paths are relative to the target (its `context` folder in the project).

/** Emitted with `{ workspace }` (the main checkout) whenever a project's drift state changed. */
export const DRIFT_EVENT = "drift";

export type DriftChange = "added" | "modified" | "deleted";

/** `mirror`: against what Tau last read. `head`: no mirror state yet, against the commit checked out. */
export type DriftBaseline = "mirror" | "head";

export interface DriftFile {
  path: string;
  change: DriftChange;
  /** False when only size and mtime say so; the import reads the file and drops it if it is the same. */
  certain: boolean;
}

export interface DriftCheck {
  at: string;
  baseline: DriftBaseline;
  files: DriftFile[];
  /** The user said "not now" to exactly this drift. */
  later: boolean;
}

/** open: waiting for a merge. later: the user put it off. merged: in the checkout's branch. gone: the branch was deleted. */
export type DriftImportStatus = "open" | "later" | "merged" | "gone";

export interface DriftImport {
  branch: string;
  commit: string;
  parent: string;
  at: string;
  files: DriftFile[];
  status: DriftImportStatus;
}

export interface DriftTarget {
  targetId: string;
  label: string;
  /** The target's folder in the project; empty for its root. */
  context: string;
  /** No mirror state and no commit to compare with: download first. */
  unchecked?: boolean;
  checking?: boolean;
  check?: DriftCheck;
  /** The last check that failed (connection, login), with the reason. */
  error?: string;
  imports: DriftImport[];
}

export interface DriftState {
  /** The main checkout. */
  workspace: string;
  /** The branch of the checkout asked about; absent when detached. */
  branch?: string;
  targets: DriftTarget[];
}

export interface DriftImportResult {
  state: DriftState;
  /** Absent when the server held nothing new after all (a touch, or already in HEAD). */
  imported?: DriftImport;
}

/** `server-drift/<YYYY-MM-DD>` in local time; the Workspace Kit adds `-2` when the day already has one. */
export function driftBranchName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `server-drift/${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** What is still undecided: drift nobody said "not now" to, and imports waiting for a merge. */
export function undecidedDrift(state: DriftState | undefined): { files: number; imports: Array<{ targetId: string; item: DriftImport }> } {
  let files = 0;
  const imports: Array<{ targetId: string; item: DriftImport }> = [];
  for (const target of state?.targets ?? []) {
    if (target.check && !target.check.later) files += target.check.files.length;
    for (const item of target.imports) if (item.status === "open") imports.push({ targetId: target.targetId, item });
  }
  return { files, imports };
}

const CHANGES = new Set<DriftChange>(["added", "modified", "deleted"]);
const STATUSES = new Set<DriftImportStatus>(["open", "later", "merged", "gone"]);
const str = (value: unknown): value is string => typeof value === "string";

function decodeFile(value: unknown): DriftFile | undefined {
  const { path, change, certain } = (value ?? {}) as Record<string, unknown>;
  return str(path) && CHANGES.has(change as DriftChange) ? { path, change: change as DriftChange, certain: certain !== false } : undefined;
}

const files = (value: unknown) => (Array.isArray(value) ? value.map(decodeFile).filter((file): file is DriftFile => Boolean(file)) : []);

function decodeImport(value: unknown): DriftImport | undefined {
  const raw = (value ?? {}) as Record<string, unknown>;
  if (!str(raw.branch) || !str(raw.commit) || !str(raw.parent) || !str(raw.at) || !STATUSES.has(raw.status as DriftImportStatus)) return undefined;
  return { branch: raw.branch, commit: raw.commit, parent: raw.parent, at: raw.at, files: files(raw.files), status: raw.status as DriftImportStatus };
}

export function decodeDriftState(value: unknown): DriftState | undefined {
  const raw = (value ?? {}) as Record<string, unknown>;
  if (!str(raw.workspace) || !Array.isArray(raw.targets)) return undefined;
  const targets: DriftTarget[] = [];
  for (const entry of raw.targets) {
    const target = (entry ?? {}) as Record<string, unknown>;
    if (!str(target.targetId) || !str(target.label)) continue;
    const check = target.check as Record<string, unknown> | undefined;
    targets.push({
      targetId: target.targetId,
      label: target.label,
      context: str(target.context) ? target.context : "",
      ...(target.unchecked === true ? { unchecked: true } : {}),
      ...(target.checking === true ? { checking: true } : {}),
      ...(check && str(check.at) ? { check: { at: check.at, baseline: check.baseline === "head" ? "head" : "mirror", files: files(check.files), later: check.later === true } } : {}),
      ...(str(target.error) ? { error: target.error } : {}),
      imports: Array.isArray(target.imports) ? target.imports.map(decodeImport).filter((item): item is DriftImport => Boolean(item)) : [],
    });
  }
  return { workspace: raw.workspace, ...(str(raw.branch) ? { branch: raw.branch } : {}), targets };
}
