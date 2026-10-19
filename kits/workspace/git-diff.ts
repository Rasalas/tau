import { spawn } from "node:child_process";
import { basename, dirname } from "node:path";
import { gitEnvironment, gitExecutable } from "tau/host-extension";
import type {
  ChangeStatus,
  DiffLoadOptions,
  UiChangedFile,
  UiDiffHunk,
  UiDiffLine,
  UiFileDiff,
  UiWorkspaceChanges,
} from "tau/host-extension";
import type { GitRunner } from "./git-command.js";
import { normalizeDiffLoadOptions } from "./turn-checkpoint-diff.js";

const SNAPSHOT_GIT_BUFFER = 64 * 1024 * 1024;
const DEFAULT_DIFF_CONTEXT_LINES = 3;
const MAX_DIFF_CONTEXT_LINES = 100_000;

export function diffViewArguments(options: DiffLoadOptions): string[] {
  const requested = options.contextLines;
  const contextLines = Number.isFinite(requested)
    ? Math.min(MAX_DIFF_CONTEXT_LINES, Math.max(0, Math.floor(requested ?? DEFAULT_DIFF_CONTEXT_LINES)))
    : DEFAULT_DIFF_CONTEXT_LINES;
  return [`-U${contextLines}`, ...(options.ignoreWhitespace ? ["--ignore-all-space"] : [])];
}

// Diff ceilings keep generated files from turning one review into an unbounded IPC payload.
export const MAX_DIFF_BYTES = 1_024 * 1_024;
export const MAX_DIFF_LINES = 10_000;
export const MAX_DIFF_HUNKS = 120;

export function describe(path: string): Pick<UiChangedFile, "name" | "directory"> {
  const directory = dirname(path);
  return { name: basename(path), directory: directory === "." ? "" : directory };
}

/**
 * `git diff --numstat -z` emits `added\tremoved\tpath\0`; for renames the path
 * field is empty and the old and new paths follow as their own records.
 */
export function parseNumstat(stdout: string): Map<string, { added: number; removed: number }> {
  const counts = new Map<string, { added: number; removed: number }>();
  const tokens = stdout.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/u.exec(tokens[index] ?? "");
    if (!match) continue;
    let path = match[3];
    if (!path) {
      index += 2;
      path = tokens[index] ?? "";
      if (!path) continue;
    }
    counts.set(path, {
      added: match[1] === "-" ? 0 : Number(match[1]),
      removed: match[2] === "-" ? 0 : Number(match[2]),
    });
  }
  return counts;
}

/** A starting point for the commit box — the shape of the change, not a summary of it. */
export function proposeMessage(files: UiChangedFile[]): string | undefined {
  if (files.length === 0) return undefined;
  const areas = [...new Set(files.map((file) => file.directory.split("/")[0] || file.name))];
  const scope = areas.length === 1 ? areas[0] : `${areas.length} areas`;
  const subject = files.length === 1 ? files[0].name : `${files.length} files`;
  return `chore(${scope}): update ${subject}`;
}

function snapshotStatus(value: string): ChangeStatus {
  if (value.startsWith("A")) return "added";
  if (value.startsWith("D")) return "deleted";
  if (value.startsWith("R") || value.startsWith("C")) return "renamed";
  return "modified";
}

/** Parse `git diff --name-status -z` without interpreting file contents. */
function parseSnapshotNameStatus(stdout: string): Map<string, ChangeStatus> {
  const statuses = new Map<string, ChangeStatus>();
  const tokens = stdout.split("\0");
  for (let index = 0; index < tokens.length;) {
    const code = tokens[index++] ?? "";
    if (!code) continue;
    const oldPath = tokens[index++] ?? "";
    const isRename = code.startsWith("R") || code.startsWith("C");
    const path = isRename ? (tokens[index++] ?? oldPath) : oldPath;
    if (path) statuses.set(path, snapshotStatus(code));
  }
  return statuses;
}

export async function diffGitTrees(
  cwd: string,
  beforeTreeId: string,
  afterTreeId: string,
  branch: string | undefined,
  runGit: GitRunner,
): Promise<UiWorkspaceChanges> {
  const args = ["diff", "--no-ext-diff", "--find-renames", "--numstat", "-z", beforeTreeId, afterTreeId, "--"];
  const statusArgs = ["diff", "--no-ext-diff", "--find-renames", "--name-status", "-z", beforeTreeId, afterTreeId, "--"];
  const [numstat, nameStatus] = await Promise.all([
    runGit(cwd, args, SNAPSHOT_GIT_BUFFER),
    runGit(cwd, statusArgs, SNAPSHOT_GIT_BUFFER),
  ]);
  const counts = parseNumstat(numstat);
  const statuses = parseSnapshotNameStatus(nameStatus);
  const paths = new Set([...counts.keys(), ...statuses.keys()]);
  const files: UiChangedFile[] = [...paths].filter(Boolean).map((path) => {
    const counted = counts.get(path) ?? { added: 0, removed: 0 };
    return {
      path,
      ...describe(path),
      status: statuses.get(path) ?? "modified",
      added: counted.added,
      removed: counted.removed,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  return {
    ...(branch ? { branch } : {}),
    files,
    added: files.reduce((total, file) => total + file.added, 0),
    removed: files.reduce((total, file) => total + file.removed, 0),
    proposedMessage: proposeMessage(files),
  };
}

export function parseUnifiedDiff(path: string, patch: string, options: DiffLoadOptions = {}, sourceTruncated = false): UiFileDiff {
  const hunks: UiDiffHunk[] = [];
  let current: UiDiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let added = 0;
  let removed = 0;

  const patchBytes = Buffer.from(patch, "utf8");
  const byteTruncated = sourceTruncated || patchBytes.length > MAX_DIFF_BYTES;
  const bytePrefix = byteTruncated ? patchBytes.subarray(0, MAX_DIFF_BYTES).toString("utf8") : patch;
  const boundedPatch = byteTruncated ? bytePrefix.slice(0, bytePrefix.lastIndexOf("\n") + 1) : bytePrefix;
  const rawLines = boundedPatch.split("\n");
  const lineTruncated = rawLines.length > MAX_DIFF_LINES;
  const boundedLines = rawLines.slice(0, MAX_DIFF_LINES);
  for (const raw of boundedLines) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      current = { header: raw.slice(0, raw.indexOf("@@", 2) + 2) + header[3], lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    // "" is the artifact of the patch's trailing newline; a blank context line is " ".
    if (raw === "" || raw.startsWith("\\")) continue;

    let line: UiDiffLine;
    if (raw.startsWith("+")) {
      line = { kind: "added", newLine: newLine++, text: raw.slice(1) };
      added += 1;
    } else if (raw.startsWith("-")) {
      line = { kind: "removed", oldLine: oldLine++, text: raw.slice(1) };
      removed += 1;
    } else {
      line = { kind: "context", oldLine: oldLine++, newLine: newLine++, text: raw.slice(1) };
    }
    current.lines.push(line);
  }

  const { hunkOffset: offset, hunkLimit: limit } = normalizeDiffLoadOptions(options, MAX_DIFF_HUNKS);
  const visibleHunks = hunks.slice(offset, offset + limit);
  const hasMoreParsedHunks = hunks.length > offset + visibleHunks.length;
  const truncated = byteTruncated || lineTruncated || hasMoreParsedHunks;
  return {
    path,
    added,
    removed,
    hunks: visibleHunks,
    truncated,
    nextHunkOffset: hasMoreParsedHunks ? offset + visibleHunks.length : undefined,
    note: hasMoreParsedHunks
      ? `Showing ${visibleHunks.length} hunks. Load more to continue.`
      : byteTruncated || lineTruncated
        ? "Diff truncated at the byte or line limit. Open the file in an editor for the complete patch."
        : undefined,
  };
}

interface StreamedPatch {
  patch: string;
  capturedHunks: number;
  hasMoreHunks: boolean;
  terminalTruncation: boolean;
}

/**
 * Reads only the requested hunk window from git's stdout. Earlier hunks are
 * scanned but never retained, and the child is stopped as soon as the next
 * page or a terminal byte/line ceiling is known.
 */
export async function streamFilePatch(
  cwd: string,
  args: string[],
  options: DiffLoadOptions,
  allowNoIndexDifference = false,
): Promise<StreamedPatch> {
  const { hunkOffset: offset, hunkLimit: limit } = normalizeDiffLoadOptions(options, MAX_DIFF_HUNKS);
  return new Promise((settle, reject) => {
    const child = spawn(gitExecutable(), ["-c", "core.quotePath=false", "-c", "core.fsmonitor=false", ...args], {
      cwd, env: gitEnvironment({ ...process.env, GIT_OPTIONAL_LOCKS: "0" }), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let pending = "";
    let stderr = "";
    let header = "";
    let selected = "";
    let hunkIndex = -1;
    let capturedHunks = 0;
    let selectedLines = 0;
    let selectedBytes = 0;
    let hasMoreHunks = false;
    let terminalTruncation = false;
    let stopped = false;
    let discardingLine = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
    };
    const appendSelected = (line: string) => {
      const bytes = Buffer.byteLength(`${line}\n`, "utf8");
      if (selectedLines >= MAX_DIFF_LINES || selectedBytes + bytes > MAX_DIFF_BYTES) {
        terminalTruncation = true;
        stop();
        return;
      }
      selected += `${line}\n`;
      selectedLines += 1;
      selectedBytes += bytes;
    };
    const consumeLine = (line: string) => {
      if (line.startsWith("@@")) {
        hunkIndex += 1;
        if (hunkIndex >= offset + limit) {
          hasMoreHunks = true;
          stop();
          return;
        }
        if (hunkIndex >= offset) capturedHunks += 1;
      }
      if (hunkIndex < 0) {
        if (Buffer.byteLength(header, "utf8") < 64 * 1024) header += `${line}\n`;
      } else if (hunkIndex >= offset) {
        appendSelected(line);
      }
    };
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      if (discardingLine) {
        const newline = pending.indexOf("\n");
        if (newline < 0) { pending = ""; return; }
        pending = pending.slice(newline + 1);
        discardingLine = false;
      }
      let newline = pending.indexOf("\n");
      // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- stopped is set by stop(), called from consumeLine below; the linter can't trace that call chain.
      while (!stopped && newline >= 0) {
        consumeLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (stopped) return;
      const pendingBytes = Buffer.byteLength(pending, "utf8");
      if (hunkIndex >= 0 && hunkIndex < offset && pendingBytes > 64 * 1024) {
        pending = "";
        discardingLine = true;
      } else if (hunkIndex >= offset && selectedBytes + pendingBytes > MAX_DIFF_BYTES) {
        pending = "";
        terminalTruncation = true;
        stop();
      } else if (hunkIndex < 0 && pendingBytes > 64 * 1024) {
        pending = "";
        terminalTruncation = true;
        stop();
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    const timeout = setTimeout(() => {
      terminalTruncation = true;
      stop();
    }, 10_000);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (!stopped && pending) consumeLine(pending);
      if (!stopped && code !== 0 && !(allowNoIndexDifference && code === 1)) {
        reject(new Error(stderr.trim() || `git diff exited with ${code}`));
        return;
      }
      settle({ patch: header + selected, capturedHunks, hasMoreHunks, terminalTruncation });
    });
  });
}
