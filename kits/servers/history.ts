import { devNull } from "node:os";
import type { UiDiffHunk, UiDiffLine, UiFileDiff } from "tau/host-extension";
import { gitOk, type GitCall } from "./sync/git.js";
import { MIRROR_REF, type Mirror } from "./sync/mirror.js";
import type { SyncChange } from "./sync/protocol.js";
import { HISTORY_FILE_CAP, type HistoryEntry, type HistoryFile } from "./view-protocol.js";

/*
 * The mirror's log read back: each recorded server state and what it changed,
 * and diffs between blobs of the shadow repository. Only reads, except that a
 * pending diff first stores the local file as a blob there.
 */

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const HEX40 = /^[0-9a-f]{40}$/u;
const DIFF_LINE_CAP = 5000;

function mirrorGit(git: GitCall, mirror: Mirror, args: readonly string[]): Promise<Buffer> {
  return gitOk(git, args, { cwd: mirror.dir, env: { GIT_DIR: mirror.dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull } });
}

const CHANGES: Record<string, SyncChange> = { A: "added", M: "modified", D: "deleted", T: "modified" };

/** `git diff-tree -r -z --name-status` records. */
export function parseNameStatus(output: string): HistoryFile[] {
  const records = output.split("\0");
  const files: HistoryFile[] = [];
  for (let index = 0; index + 1 < records.length; index += 2) {
    const change = CHANGES[records[index]!.charAt(0)];
    const path = records[index + 1]!;
    if (change && path) files.push({ path, change });
  }
  return files;
}

/** The newest recorded states first; the first read lists no files, it holds all of them. */
export async function readHistory(git: GitCall, mirror: Mirror, limit = 30): Promise<HistoryEntry[]> {
  const head = await mirror.head();
  if (!head) return [];
  const log = (await mirrorGit(git, mirror, ["log", "-z", `-n${limit}`, "--format=%H%x1f%P%x1f%ct%x1f%s", MIRROR_REF])).toString("utf8");
  const commits = log.split("\0").filter(Boolean).map((record) => {
    const [commit = "", parents = "", at = "0", subject = ""] = record.split("\x1f");
    return { commit, parent: parents.split(" ")[0] || undefined, at: new Date(Number(at) * 1000).toISOString(), subject };
  }).filter((entry) => HEX40.test(entry.commit));
  return Promise.all(commits.map(async (entry): Promise<HistoryEntry> => {
    const changed = parseNameStatus((await mirrorGit(git, mirror, ["diff-tree", "-r", "-z", "--no-commit-id", "--name-status", "--no-renames", entry.parent ?? EMPTY_TREE, entry.commit])).toString("utf8"));
    const count = (change: SyncChange) => changed.filter((file) => file.change === change).length;
    return {
      commit: entry.commit,
      ...(entry.parent ? { parent: entry.parent } : {}),
      at: entry.at,
      subject: entry.subject,
      kind: entry.subject.startsWith("Server state") ? "read" : "change",
      added: count("added"),
      modified: count("modified"),
      deleted: count("deleted"),
      files: changed.slice(0, HISTORY_FILE_CAP),
    };
  }));
}

/** Hunks of a one-file `git diff`; a binary file gets a note instead. */
export function parseFileDiff(path: string, patch: string): UiFileDiff {
  const diff: UiFileDiff = { path, added: 0, removed: 0, hunks: [] };
  if (/^Binary files .* differ$/mu.test(patch)) return { ...diff, note: "Binary file; Tau shows no diff of it." };
  let hunk: UiDiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let lines = 0;
  for (const raw of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(raw);
    if (header) {
      hunk = { header: raw, lines: [] };
      diff.hunks.push(hunk);
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (!hunk || raw.startsWith("\\")) continue;
    if (lines >= DIFF_LINE_CAP) { diff.truncated = true; break; }
    const mark = raw.charAt(0);
    let line: UiDiffLine;
    if (mark === "+") { line = { kind: "added", newLine: newLine++, text: raw.slice(1) }; diff.added += 1; }
    else if (mark === "-") { line = { kind: "removed", oldLine: oldLine++, text: raw.slice(1) }; diff.removed += 1; }
    else if (mark === " ") line = { kind: "context", oldLine: oldLine++, newLine: newLine++, text: raw.slice(1) };
    else continue;
    hunk.lines.push(line);
    lines += 1;
  }
  return diff;
}

/** Two blobs of the mirror, `before` or `after` empty for a file that is new or gone. */
export async function diffBlobs(git: GitCall, mirror: Mirror, path: string, before: string | undefined, after: string | undefined): Promise<UiFileDiff> {
  const empty = await mirror.writeBlob(Buffer.alloc(0));
  const patch = (await mirrorGit(git, mirror, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", before ?? empty, after ?? empty])).toString("utf8");
  return parseFileDiff(path, patch);
}

/** One path between a recorded state and the one before it. */
export async function diffHistory(git: GitCall, mirror: Mirror, commit: string, path: string): Promise<UiFileDiff> {
  if (!HEX40.test(commit)) throw new Error(`Not a commit id: ${commit}`);
  const parents = (await mirrorGit(git, mirror, ["rev-list", "--parents", "-n1", commit])).toString("utf8").trim().split(" ");
  const blob = async (tree: string | undefined) => {
    if (!tree) return undefined;
    const listed = (await mirrorGit(git, mirror, ["ls-tree", "-z", tree, "--", path])).toString("utf8");
    return /^\d+ blob ([0-9a-f]{40})\t/u.exec(listed)?.[1];
  };
  return diffBlobs(git, mirror, path, await blob(parents[1]), await blob(parents[0]));
}
