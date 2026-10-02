import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentGit, type AgentGitRunner } from "./agent-worktrees.js";

/**
 * A merge's conflicts, one hunk at a time (Reviews, design 2e): read from the
 * conflict markers in `merge-tree --write-tree`'s tree, and resolved there by
 * the user's pick per hunk, so the checkout is only touched by the merge.
 */
export interface ConflictHunk {
  /** The target's lines ("ours") and the thread branch's ("theirs"). */
  main: string[];
  thread: string[];
  /** 1-based line numbers where each side's lines start. */
  mainLine: number;
  threadLine: number;
  /** One line around the hunk, as both sides have it. */
  before?: string;
  after?: string;
}

export interface ConflictFile {
  path: string;
  hunks: ConflictHunk[];
  /** Why this file has no hunks to pick (deleted on one side, binary, renamed). */
  unpickable?: string;
}

/** "main", "thread", "both" (the thread's lines, then main's), or the lines written by hand. */
export type HunkPick = "main" | "thread" | "both" | { text: string };

type Part = string | { main: string[]; thread: string[] };

const START = /^<{7}(?: |$)/u;
const BASE = /^\|{7}(?: |$)/u;
const SPLIT = /^={7}$/u;
const END = /^>{7}(?: |$)/u;

/** The file cut into common lines and conflicts; undefined without markers or with broken ones. */
export function parseConflictText(text: string): Part[] | undefined {
  const parts: Part[] = [];
  let hunk: { main: string[]; thread: string[] } | undefined;
  let side: "main" | "base" | "thread" = "main";
  for (const line of text.split("\n")) {
    if (!hunk) {
      if (START.test(line)) { hunk = { main: [], thread: [] }; side = "main"; } else parts.push(line);
    } else if (BASE.test(line) && side === "main") side = "base";
    else if (SPLIT.test(line) && side !== "thread") side = "thread";
    else if (END.test(line) && side === "thread") { parts.push(hunk); hunk = undefined; }
    else if (side !== "base") hunk[side].push(line);
  }
  return hunk || !parts.some((part) => typeof part !== "string") ? undefined : parts;
}

export function conflictHunks(parts: readonly Part[]): ConflictHunk[] {
  const hunks: ConflictHunk[] = [];
  let main = 1;
  let thread = 1;
  parts.forEach((part, index) => {
    if (typeof part === "string") { main += 1; thread += 1; return; }
    const before = parts[index - 1];
    const after = parts[index + 1];
    hunks.push({
      main: part.main, thread: part.thread, mainLine: main, threadLine: thread,
      ...(typeof before === "string" ? { before } : {}),
      ...(typeof after === "string" ? { after } : {}),
    });
    main += part.main.length;
    thread += part.thread.length;
  });
  return hunks;
}

const MISMATCH = "The picks do not match the conflicts any more; look at them again.";

export function applyPicks(parts: readonly Part[], picks: readonly HunkPick[]): string {
  const lines: string[] = [];
  let at = 0;
  for (const part of parts) {
    if (typeof part === "string") { lines.push(part); continue; }
    const pick = picks[at++];
    if (pick === undefined) throw new Error(MISMATCH);
    if (typeof pick === "object") lines.push(...(pick.text === "" ? [] : pick.text.split("\n")));
    else lines.push(...(pick === "main" ? part.main : pick === "thread" ? part.thread : [...part.thread, ...part.main]));
  }
  if (at !== picks.length) throw new Error(MISMATCH);
  return lines.join("\n");
}

const blobOf = (tree: string, path: string, root: string, runGit: AgentGitRunner) =>
  runGit(root, ["cat-file", "blob", `${tree}:${path}`]).catch(() => undefined);

/** Each conflicting file of a merge-tree result, with its hunks, or why it has none. */
export async function readConflictFiles(root: string, tree: string, paths: readonly string[], runGit: AgentGitRunner = runAgentGit): Promise<ConflictFile[]> {
  return Promise.all(paths.map(async (path) => {
    const text = await blobOf(tree, path, root, runGit);
    const parts = text === undefined || text.includes("\0") ? undefined : parseConflictText(text);
    return parts ? { path, hunks: conflictHunks(parts) } : { path, hunks: [], unpickable: "Changed in a way that has no lines to pick (deleted, renamed or binary on one side)." };
  }));
}

/** The merge-tree result with every conflicting file resolved by its picks, as a new tree. */
export async function resolveTree(root: string, tree: string, paths: readonly string[], picks: Readonly<Record<string, readonly HunkPick[]>>, runGit: AgentGitRunner = runAgentGit): Promise<string> {
  const indexFile = join(tmpdir(), `tau-picks-${process.pid}-${Date.now()}.index`);
  try {
    await runGit(root, ["read-tree", tree], { indexFile });
    for (const path of paths) {
      const text = await blobOf(tree, path, root, runGit);
      const parts = text === undefined ? undefined : parseConflictText(text);
      if (!parts || !picks[path]) throw new Error(`${path} has no picks; ask the thread to rebase instead.`);
      const blob = (await runGit(root, ["hash-object", "-w", "--stdin"], { stdin: applyPicks(parts, picks[path]) })).trim();
      const mode = (await runGit(root, ["ls-tree", tree, "--", path])).split(/\s/u)[0] || "100644";
      await runGit(root, ["update-index", "--add", "--cacheinfo", `${mode},${blob},${path}`], { indexFile });
    }
    return (await runGit(root, ["write-tree"], { indexFile })).trim();
  } finally {
    await rm(indexFile, { force: true });
  }
}

/** The picks a caller sent, as far as they are picks. */
export function decodePicks(input: unknown): Record<string, HunkPick[]> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const picks: Record<string, HunkPick[]> = {};
  for (const [path, list] of Object.entries(input)) {
    if (!Array.isArray(list)) return undefined;
    picks[path] = list.map((pick) => pick === "main" || pick === "thread" || pick === "both" ? pick
      : typeof pick?.text === "string" ? { text: pick.text } : (() => { throw new Error(`A pick for ${path} is not one.`); })());
  }
  return picks;
}
