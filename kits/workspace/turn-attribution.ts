import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { UiWorkspaceChanges } from "tau/host-extension";
import { MAX_TURN_HEAD_STEPS } from "./turn-checkpoint-codec.js";
import type { TurnChangesSummary, TurnHead, TurnHeadMove, TurnHeadStep } from "./turn-checkpoint-types.js";
import { runGitCommand, type GitRunner } from "./workspace-git.js";

/**
 * Which of a turn's changed files the turn made, when HEAD moved under it.
 *
 * A commit leaves the files as they are, so the snapshot trees stay exact
 * across commits. A branch switch, pull, reset, merge or rebase rewrites
 * files; those steps are read from HEAD's reflog and their files left out.
 */

export interface ReflogEntry {
  from: string;
  to: string;
  /** Seconds resolution, in ms. */
  at: number;
  message: string;
}

/** The reflog's newest part is all a turn can have written. */
const REFLOG_TAIL_BYTES = 1024 * 1024;
const ZERO_ID = /^0+$/u;
const DIFF_BUFFER = 64 * 1024 * 1024;

const EMPTY_TREE_SHA1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE_SHA256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

export function parseReflog(text: string): ReflogEntry[] {
  const entries: ReflogEntry[] = [];
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    const head = (tab < 0 ? line : line.slice(0, tab)).split(" ");
    const [from, to] = head;
    const seconds = Number(head.at(-2));
    if (!from || !to || !/^[0-9a-f]{40,64}$/u.test(from) || !/^[0-9a-f]{40,64}$/u.test(to) || !Number.isFinite(seconds)) continue;
    entries.push({
      from: ZERO_ID.test(from) ? "" : from,
      to: ZERO_ID.test(to) ? "" : to,
      at: seconds * 1000,
      message: tab < 0 ? "" : line.slice(tab + 1),
    });
  }
  return entries;
}

/** HEAD's reflog of the checkout at `cwd`; undefined when it keeps none. */
export async function readHeadReflog(cwd: string, runGit: GitRunner = runGitCommand): Promise<ReflogEntry[] | undefined> {
  const path = (await runGit(cwd, ["rev-parse", "--git-path", "logs/HEAD"]).catch(() => "")).trim();
  if (!path) return undefined;
  const handle = await open(resolve(cwd, path), "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    const offset = Math.max(0, size - REFLOG_TAIL_BYTES);
    const buffer = Buffer.alloc(size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    let text = buffer.toString("utf8");
    // The first line of a tail read is cut off.
    if (offset > 0) text = text.slice(text.indexOf("\n") + 1);
    return parseReflog(text);
  } finally {
    await handle.close();
  }
}

/** "commit: …" keeps the files; everything else ("checkout: …", "pull: …", "commit (merge): …") may rewrite them. */
export function reflogStepKind(message: string): { commit: boolean; kind: string } {
  const verb = message.split(":")[0]?.trim() ?? "";
  const commit = /^commit(?: \((?:amend|initial)\))?$/u.test(verb);
  const word = /^[a-z][a-z-]*/u.exec(verb)?.[0] ?? "";
  return { commit, kind: word.length > 0 && word.length <= 32 ? word : "other" };
}

type KindedStep = TurnHeadStep & { kind: string };

/**
 * The reflog steps that took HEAD from `head.before` to `head.after`, newest
 * last; undefined when the reflog cannot say. `window` keeps a legacy walk
 * inside the turn's time.
 */
export function headSteps(entries: readonly ReflogEntry[], head: TurnHead, window?: { from: number; to: number }): KindedStep[] | undefined {
  if (head.before === head.after) return [];
  const inside = (entry: ReflogEntry) => !window || (entry.at >= window.from && entry.at <= window.to);
  let index = entries.length - 1;
  while (index >= 0 && !(entries[index]!.to === head.after && inside(entries[index]!))) index -= 1;
  if (index < 0) return undefined;
  const chain: ReflogEntry[] = [entries[index]!];
  while (chain[0]!.from !== head.before) {
    index -= 1;
    const previous = entries[index];
    if (!previous || previous.to !== chain[0]!.from || !inside(previous) || chain.length >= MAX_TURN_HEAD_STEPS) return undefined;
    chain.unshift(previous);
  }
  return chain.map((entry) => ({ from: entry.from, to: entry.to, ...reflogStepKind(entry.message) }));
}

/**
 * A record written before HEAD was stored: the reflog entries inside the
 * turn's time stand in for it. Undefined when nothing but commits moved HEAD.
 */
export function legacyHeadMove(entries: readonly ReflogEntry[], startedAt: number, endedAt: number): { head: TurnHead; steps: KindedStep[] | undefined } | undefined {
  // Reflog times are whole seconds.
  const inside = entries.filter((entry) => entry.at >= Math.floor(startedAt / 1000) * 1000 && entry.at <= endedAt);
  if (inside.length === 0) return undefined;
  const steps = inside.map((entry) => ({ from: entry.from, to: entry.to, ...reflogStepKind(entry.message) }));
  if (steps.every((step) => step.commit)) return undefined;
  const contiguous = steps.every((step, index) => index === 0 || steps[index - 1]!.to === step.from) && steps.length <= MAX_TURN_HEAD_STEPS;
  return { head: { before: steps[0]!.from, after: steps.at(-1)!.to }, steps: contiguous ? steps : undefined };
}

function emptyTreeFor(id: string): string {
  return id.length === 64 ? EMPTY_TREE_SHA256 : EMPTY_TREE_SHA1;
}

async function changedPaths(cwd: string, from: string, to: string, runGit: GitRunner): Promise<Set<string>> {
  const output = await runGit(cwd, ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", from || emptyTreeFor(to), to || emptyTreeFor(from), "--"], DIFF_BUFFER);
  return new Set(output.split("\0").filter(Boolean));
}

export interface AttributionInput {
  /** Tree-ish of the workspace at both ends: the snapshot refs. */
  beforeTree: string;
  afterTree: string;
  head: TurnHead;
  /** The reflog steps between the heads; undefined when the reflog could not say. */
  steps: readonly KindedStep[] | undefined;
}

/**
 * Keeps the files the HEAD move does not explain. A file the move rewrote
 * and that was clean at both ends is the move's; one that was also edited
 * (dirty at an end, or in a commit of the turn) cannot be split and is left
 * out as uncertain. Without a reflog every file the move touched is uncertain.
 */
export async function attributeTurnChanges(
  cwd: string,
  changes: UiWorkspaceChanges,
  input: AttributionInput,
  runGit: GitRunner = runGitCommand,
): Promise<TurnChangesSummary> {
  const { head, steps } = input;
  const moving = steps?.filter((step) => !step.commit) ?? [];
  if (head.before === head.after || (steps && moving.length === 0)) return { ...changes, head: { ...head } };
  const foreign = new Set<string>();
  const own = new Set<string>();
  if (steps) {
    for (const step of steps) for (const path of await changedPaths(cwd, step.from, step.to, runGit)) (step.commit ? own : foreign).add(path);
  } else {
    for (const path of await changedPaths(cwd, head.before, head.after, runGit)) foreign.add(path);
  }
  const [dirtyBefore, dirtyAfter] = await Promise.all([
    changedPaths(cwd, head.before, input.beforeTree, runGit),
    changedPaths(cwd, head.after, input.afterTree, runGit),
  ]);
  let excluded = 0;
  let uncertain = 0;
  const files = changes.files.filter((file) => {
    if (!foreign.has(file.path)) return true;
    if (steps && !own.has(file.path) && !dirtyBefore.has(file.path) && !dirtyAfter.has(file.path)) excluded += 1;
    else uncertain += 1;
    return false;
  });
  const headMove: TurnHeadMove = {
    kind: steps ? moving[0]!.kind : "unknown",
    steps: (steps ?? []).map(({ from, to, commit }) => ({ from, to, commit })),
    excludedFileCount: excluded,
    uncertainFileCount: uncertain,
  };
  const { proposedMessage: _stale, ...rest } = changes;
  return {
    ...rest,
    files,
    fileCount: files.length,
    added: files.reduce((total, file) => total + file.added, 0),
    removed: files.reduce((total, file) => total + file.removed, 0),
    head: { ...head },
    headMove,
  };
}

/** A recorded move applied again to a fresh tree diff, for the file pages. */
export function recordedAttribution(checkpoint: { beforeSnapshotId: string; afterSnapshotId: string; head: TurnHead; headMove: TurnHeadMove }): AttributionInput {
  const { headMove } = checkpoint;
  return {
    beforeTree: checkpoint.beforeSnapshotId,
    afterTree: checkpoint.afterSnapshotId,
    head: checkpoint.head,
    steps: headMove.kind === "unknown" ? undefined : headMove.steps.map((step) => ({ ...step, kind: step.commit ? "commit" : headMove.kind })),
  };
}

/** Whether the turn's count can be trusted: nothing the turn may have touched was left out. */
export function headMoveIsCertain(move: TurnHeadMove | undefined): boolean {
  return !move || move.uncertainFileCount === 0;
}
