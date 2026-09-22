// Type-only imports: the desktop half reads these rules and verdicts too.
import type {
  CleanupBlocker,
  CleanupPolicy,
  CleanupReason,
  CleanupVerdict,
  ProjectCleanupOverride,
  WorktreeCleanupRules,
} from "./storage-protocol.js";

export const DAY_MS = 24 * 60 * 60 * 1_000;
export const MAX_RETENTION_DAYS = 3_650;

/** Every rule off, as in T3 Code: cleanup is something a user turns on. */
export const NO_CLEANUP: WorktreeCleanupRules = { afterDays: null, onMerge: false, onThreadDelete: false, unchanged: false };
export const EMPTY_POLICY: CleanupPolicy = { host: NO_CLEANUP, projects: {} };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function days(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_RETENTION_DAYS, Math.max(1, Math.round(value)));
}

/** The rules a patch names, and nothing it does not; a wrong type is dropped. */
export function decodeRulesPatch(value: unknown): Partial<WorktreeCleanupRules> {
  const raw = record(value);
  const afterDays = days(raw.afterDays);
  return {
    ...(afterDays === undefined ? {} : { afterDays }),
    ...(typeof raw.onMerge === "boolean" ? { onMerge: raw.onMerge } : {}),
    ...(typeof raw.onThreadDelete === "boolean" ? { onThreadDelete: raw.onThreadDelete } : {}),
    ...(typeof raw.unchanged === "boolean" ? { unchanged: raw.unchanged } : {}),
  };
}

function decodeOverride(value: unknown): ProjectCleanupOverride | undefined {
  const raw = record(value);
  if (raw.mode === "off") return { mode: "off" };
  if (raw.mode === "custom") return { mode: "custom", rules: decodeRulesPatch(raw.rules) };
  return undefined;
}

/** What `cleanup-policy.json` holds; anything it cannot read is the default. */
export function decodePolicy(value: unknown): CleanupPolicy {
  const raw = record(value);
  const projects: Record<string, ProjectCleanupOverride> = {};
  for (const [project, override] of Object.entries(record(raw.projects))) {
    const decoded = decodeOverride(override);
    if (decoded) projects[project] = decoded;
  }
  return { host: { ...NO_CLEANUP, ...decodeRulesPatch(raw.host) }, projects };
}

/**
 * A change from the storage page: host rules, or one project's override.
 * `mode: "inherit"` drops the override; a custom override keeps the rules it
 * already had and takes the patch on top.
 */
export function patchPolicy(policy: CleanupPolicy, patch: unknown): CleanupPolicy {
  const raw = record(patch);
  if (typeof raw.project !== "string" || !raw.project) {
    return { ...policy, host: { ...policy.host, ...decodeRulesPatch(raw.rules) } };
  }
  const projects = { ...policy.projects };
  if (raw.mode === "inherit") delete projects[raw.project];
  else if (raw.mode === "off") projects[raw.project] = { mode: "off" };
  else {
    const previous = projects[raw.project];
    const base = previous?.mode === "custom" ? previous.rules ?? {} : {};
    projects[raw.project] = { mode: "custom", rules: { ...base, ...decodeRulesPatch(raw.rules) } };
  }
  return { ...policy, projects };
}

/** The rules a repository runs under: its own override, else the host's. */
export function rulesFor(policy: CleanupPolicy, project: string): WorktreeCleanupRules {
  const override = policy.projects[project];
  if (!override) return policy.host;
  if (override.mode === "off") return NO_CLEANUP;
  return { ...policy.host, ...override.rules };
}

export function anyRule(rules: WorktreeCleanupRules): boolean {
  return rules.afterDays !== null || rules.onMerge || rules.onThreadDelete || rules.unchanged;
}

/** Whether a sweep has anything to do for any project the policy names. */
export function policyActive(policy: CleanupPolicy): boolean {
  return anyRule(policy.host) || Object.values(policy.projects).some((override) => override.mode === "custom" && anyRule({ ...policy.host, ...override.rules }));
}

/** What a sweep learned about one worktree Tau recorded. */
export interface WorktreeFacts {
  /** Tau made it and wrote it down; nothing else is ever removed. */
  recorded: boolean;
  exists: boolean;
  /** Its real path lies inside the worktrees folder of its repository. */
  insideWorktreesDir: boolean;
  /** A linked worktree of the repository (`.git` is a file), never the main checkout. */
  linked: boolean;
  /** The host has it open as its current workspace. */
  hostWorkspace: boolean;
  /** Threads whose project it is. */
  threads: number;
  /** Of those, threads that hold a live runtime right now. */
  openThreads: number;
  /** A thread that worked here was deleted, and no other thread remains. */
  threadDeleted: boolean;
  /** Modified or untracked files. */
  dirtyFiles: number;
  /** Ignored paths other than `node_modules`: `.env` files, local data. */
  ignoredFiles: number;
  /** Commits on HEAD that no other branch and no remote holds. */
  unpushedCommits: number;
  /** Commits beyond the base the worktree started from. */
  commitsBeyondBase: number;
  /** HEAD is already part of the repository's default branch. */
  integrated: boolean;
  lastActivityAt: number;
  inspectionError?: string;
}

/**
 * The dry run: which rules would remove a worktree and what keeps it. It is
 * the same answer the storage page shows and the sweep acts on, so nothing is
 * removed that the page did not say it would remove.
 */
export function evaluateWorktree(facts: WorktreeFacts, rules: WorktreeCleanupRules, now: number): CleanupVerdict {
  const reasons: CleanupReason[] = [];
  if (rules.onThreadDelete && facts.threadDeleted && facts.threads === 0) reasons.push("thread-deleted");
  if (rules.afterDays !== null && now - facts.lastActivityAt >= rules.afterDays * DAY_MS) reasons.push("inactive");
  if (rules.onMerge && facts.commitsBeyondBase > 0 && facts.integrated) reasons.push("merged");
  if (rules.unchanged && facts.commitsBeyondBase === 0) reasons.push("unchanged");

  const blockers: CleanupBlocker[] = [];
  if (!facts.recorded) blockers.push("not-recorded");
  if (!facts.exists) blockers.push("missing");
  if (facts.inspectionError) blockers.push("inspection-failed");
  if (!facts.insideWorktreesDir) blockers.push("outside-worktrees-dir");
  if (!facts.linked) blockers.push("not-linked");
  if (facts.hostWorkspace) blockers.push("host-workspace");
  if (facts.openThreads > 0) blockers.push("thread-open");
  if (facts.dirtyFiles > 0) blockers.push("uncommitted");
  if (facts.ignoredFiles > 0) blockers.push("ignored-files");
  if (facts.unpushedCommits > 0) blockers.push("unpushed");
  return { remove: reasons.length > 0 && blockers.length === 0, reasons, blockers };
}

/** Blockers a user may override with a confirmation; the rest are never removed from here. */
export const CONFIRMABLE_BLOCKERS: ReadonlySet<CleanupBlocker> = new Set(["uncommitted", "ignored-files", "unpushed"]);

export function manualRemovalRefusal(verdict: CleanupVerdict): CleanupBlocker | undefined {
  return verdict.blockers.find((blocker) => !CONFIRMABLE_BLOCKERS.has(blocker));
}
