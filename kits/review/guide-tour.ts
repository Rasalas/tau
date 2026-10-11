import type { UiDiffHunk, UiDiffLine, UiFileDiff } from "tau";
import type { GuideAttentionKind, GuideExcerpt, GuideResult, GuideStop, PullRequestGuide } from "./guide-protocol.js";

/** The pure half of the tour, shared by the desktop's and the phone's views: no React, no DOM. */

/** One step forward or back, held to the first and last stop. */
export function stepTourPosition(current: number, delta: 1 | -1, count: number): number {
  return Math.max(Math.min(current + delta, count - 1), 0);
}

/** The stop's files in reading order: the excerpted ones first, then the rest it owns. */
export function stopFilePaths(stop: GuideStop): string[] {
  return [...new Set([...stop.excerpts.map((excerpt) => excerpt.path), ...stop.files.map((file) => file.path)])];
}

/** The rail's second line for a stop. */
export function stopSubline(stop: GuideStop): string {
  const count = stopFilePaths(stop).length;
  if (count === 0) return "Context, no code";
  return count === 1 ? "1 file" : `${count} files`;
}

export const ATTENTION_LABELS: Readonly<Record<GuideAttentionKind, string>> = {
  tradeoff: "A tradeoff to weigh",
  contract: "A contract to check",
  product: "A product call",
  risk: "A risk to judge",
  accessibility: "An accessibility call",
};

/** A note's marker: A, B, C in the order the guide lists them, numbers past Z. */
export function noteMarker(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

export interface LetteredNote {
  marker: string;
  note: GuideStop["notes"][number];
}

/** The notes of one excerpt grouped by the line they sit on, each with its letter. */
export interface ExcerptMarkers {
  line: number;
  markers: Array<{ marker: string; title: string }>;
}

/**
 * Letters a stop's notes and groups them by the excerpt line they mark. A note
 * outside every excerpt keeps its letter in the list and has no line to mark.
 */
export function letterStopNotes(stop: GuideStop): { lettered: LetteredNote[]; byExcerpt: ExcerptMarkers[][] } {
  const lettered = stop.notes.map((note, index) => ({ marker: noteMarker(index), note }));
  const byExcerpt = stop.excerpts.map((excerpt) => {
    const lines = new Map<number, ExcerptMarkers["markers"]>();
    for (const { marker, note } of lettered) {
      if (note.path !== excerpt.path || note.line < excerpt.start || note.line > excerpt.end) continue;
      const list = lines.get(note.line) ?? [];
      list.push({ marker, title: note.title });
      lines.set(note.line, list);
    }
    return [...lines].map(([line, markers]) => ({ line, markers }));
  });
  return { lettered, byExcerpt };
}

/** A guide is stale when the request moved on; without a known head it is taken as current. */
export function isGuideStale(guide: Pick<PullRequestGuide, "headSha">, currentHeadSha: string | null | undefined): boolean {
  return Boolean(currentHeadSha) && currentHeadSha !== guide.headSha;
}

/** A failed run is told only while it is about the head the reader sees. */
export function guideFailure(result: Pick<GuideResult, "run" | "currentHeadSha"> | undefined, currentHeadSha: string | null | undefined): string | undefined {
  const run = result?.run;
  if (run?.state !== "failed") return undefined;
  const head = currentHeadSha ?? result?.currentHeadSha ?? null;
  return head === null || head === run.headSha ? run.detail : undefined;
}

// ---- Excerpts: a file's diff cut down to the lines a stop shows ----

/** One line of a file's diff with where each side stands when it is reached. */
export interface DiffRow {
  line: UiDiffLine;
  /** The next line number on each side when this row is reached; they name a hunk's start. */
  oldAt: number;
  newAt: number;
  /** Rows from two hunks are not adjacent in the file. */
  hunk: number;
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

/** Where a hunk starts on each side: from its lines, else from its header (git names the line before an empty side). */
function hunkStart(hunk: UiDiffHunk): { old: number; new: number } {
  const old = hunk.lines.find((line) => line.oldLine !== undefined)?.oldLine;
  const next = hunk.lines.find((line) => line.newLine !== undefined)?.newLine;
  const header = HEADER.exec(hunk.header);
  const fromHeader = (start: string | undefined, count: string | undefined) => {
    if (start === undefined) return 1;
    return count === "0" ? Number(start) + 1 : Number(start);
  };
  return { old: old ?? fromHeader(header?.[1], header?.[2]), new: next ?? fromHeader(header?.[3], header?.[4]) };
}

/** Every line of a file's diff as the unified view lists it. */
export function diffRows(file: UiFileDiff): DiffRow[] {
  const rows: DiffRow[] = [];
  file.hunks.forEach((hunk, index) => {
    const start = hunkStart(hunk);
    let oldAt = start.old;
    let newAt = start.new;
    for (const line of hunk.lines) {
      if (line.oldLine !== undefined) oldAt = line.oldLine;
      if (line.newLine !== undefined) newAt = line.newLine;
      rows.push({ line, oldAt, newAt, hunk: index });
      if (line.kind !== "added") oldAt += 1;
      if (line.kind !== "removed") newAt += 1;
    }
  });
  return rows;
}

/**
 * The rows an excerpt covers. Its range is in one side's numbers, so the other
 * side's half of a replacement at either edge comes along: an excerpt that starts
 * on an added line shows the lines it replaced, which makes it read as a change.
 */
export function excerptRows(rows: readonly DiffRow[], excerpt: Pick<GuideExcerpt, "side" | "start" | "end">): DiffRow[] {
  const lineOf = (row: DiffRow) => excerpt.side === "new" ? row.line.newLine : row.line.oldLine;
  const inRange = (row: DiffRow) => {
    const line = lineOf(row);
    return line !== undefined && line >= excerpt.start && line <= excerpt.end;
  };
  let first = rows.findIndex(inRange);
  if (first === -1) return [];
  let last = first;
  for (let index = rows.length - 1; index > first; index -= 1) if (inRange(rows[index]!)) { last = index; break; }
  if (excerpt.side === "new" && rows[first]!.line.kind === "added") {
    while (first > 0 && rows[first - 1]!.line.kind === "removed" && rows[first - 1]!.hunk === rows[first]!.hunk) first -= 1;
  }
  if (excerpt.side === "old" && rows[last]!.line.kind === "removed") {
    while (last < rows.length - 1 && rows[last + 1]!.line.kind === "added" && rows[last + 1]!.hunk === rows[last]!.hunk) last += 1;
  }
  return rows.slice(first, last + 1);
}

/** The header git would write for these lines; a side with no lines is named by the line before it. */
function hunkHeader(rows: readonly DiffRow[]): string {
  const head = rows[0]!;
  const oldCount = rows.filter((row) => row.line.oldLine !== undefined).length;
  const newCount = rows.filter((row) => row.line.newLine !== undefined).length;
  const oldStart = oldCount === 0 ? Math.max(head.oldAt - 1, 0) : head.oldAt;
  const newStart = newCount === 0 ? Math.max(head.newAt - 1, 0) : head.newAt;
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
}

export interface ExcerptView {
  /** The cut diff, with the file's real line numbers on both sides. */
  diff: UiFileDiff;
  /** Diff lines shown, and the lines of the whole file's diff. */
  shown: number;
  total: number;
  /** Old minus new line number where the cut starts, which the file's unchanged lines before it still carry. */
  startDelta: number;
  /** Whether the lines around the cut can be offered. */
  collapsible: boolean;
}

/** An excerpt's lines as a diff of their own, or undefined when none of them is in the file's diff. */
export function excerptDiff(file: UiFileDiff, excerpt: Pick<GuideExcerpt, "side" | "start" | "end">): ExcerptView | undefined {
  const all = diffRows(file);
  const shown = excerptRows(all, excerpt);
  if (shown.length === 0) return undefined;
  const hunks: UiDiffHunk[] = [];
  for (let start = 0; start < shown.length;) {
    let end = start;
    while (end + 1 < shown.length && shown[end + 1]!.hunk === shown[start]!.hunk) end += 1;
    const group = shown.slice(start, end + 1);
    hunks.push({ header: hunkHeader(group), lines: group.map((row) => row.line) });
    start = end + 1;
  }
  const lines = shown.map((row) => row.line);
  const diff: UiFileDiff = {
    path: file.path,
    added: lines.filter((line) => line.kind === "added").length,
    removed: lines.filter((line) => line.kind === "removed").length,
    hunks,
  };
  // The diff view measures a gap from a hunk's first line; a removal there is read on the old side, which is
  // off by the lines earlier hunks added or took away.
  const collapsible = hunks.every((hunk) => {
    const first = hunk.lines.find((line) => line.newLine !== undefined || line.oldLine !== undefined);
    return first?.newLine !== undefined;
  });
  return { diff, shown: shown.length, total: all.length, startDelta: shown[0]!.oldAt - shown[0]!.newAt, collapsible };
}

/** The diff with every old-side number moved by `by`; the new side stays. */
export function shiftOldLines(diff: UiFileDiff, by: number): UiFileDiff {
  if (by === 0) return diff;
  return { ...diff, hunks: diff.hunks.map((hunk) => ({ ...hunk, lines: hunk.lines.map((line) => line.oldLine === undefined ? line : { ...line, oldLine: line.oldLine + by }) })) };
}

/**
 * Lets `expand` draw the unchanged lines around a cut. Those lines are numbered as if the file
 * were unchanged before the cut, so the old side is moved to run in step there and back after.
 */
export function expandExcerpt(view: Pick<ExcerptView, "diff" | "startDelta">, expand: (diff: UiFileDiff) => UiFileDiff): UiFileDiff {
  const moved = shiftOldLines(expand(shiftOldLines(view.diff, -view.startDelta)), view.startDelta);
  // A file with no old side before the cut (a new one) has no number to give the lines drawn above it.
  return { ...moved, hunks: moved.hunks.map((hunk) => ({ ...hunk, lines: hunk.lines.map((line) => line.expanded && line.oldLine !== undefined && line.oldLine < 1 ? { kind: line.kind, newLine: line.newLine, text: line.text, expanded: true } as UiDiffLine : line) })) };
}

// ---- Progress: where the reader is, kept for as long as the window is open ----

export interface GuideProgress {
  position: number;
  /** Stops left behind going forward; jumping back does not mark one. */
  seen: ReadonlySet<number>;
}

const FRESH: GuideProgress = { position: 0, seen: new Set() };

/** The progress key of one guide: a new head starts a new tour. */
export const guideProgressKey = (url: string, headSha: string): string => `${url}\0${headSha}`;

export class GuideProgressStore {
  private readonly entries = new Map<string, GuideProgress>();
  private readonly listeners = new Set<() => void>();

  get = (key: string): GuideProgress => this.entries.get(key) ?? FRESH;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  set(key: string, change: (current: GuideProgress) => Partial<GuideProgress>): void {
    const url = key.slice(0, key.indexOf("\0") + 1);
    // An older head of the same request is a tour nobody can reach again.
    for (const other of [...this.entries.keys()]) if (other !== key && other.startsWith(url)) this.entries.delete(other);
    const current = this.get(key);
    this.entries.set(key, { ...current, ...change(current) });
    for (const listener of [...this.listeners]) listener();
  }

  /** Moves to `next`; leaving a stop for a later one counts it as read. */
  go(key: string, next: number): void {
    this.set(key, (current) => ({ position: next, seen: next > current.position ? new Set(current.seen).add(current.position) : current.seen }));
  }

  /** Forgets every tour; a test starts from a reader who has read nothing. */
  clear(): void {
    this.entries.clear();
    for (const listener of [...this.listeners]) listener();
  }

  markSeen(key: string, index: number): void {
    this.set(key, (current) => ({ seen: new Set(current.seen).add(index) }));
  }
}

/** One store for the window, so the same guide in two panels opens where the reader is. */
export const guideProgress = new GuideProgressStore();

/** The position, held to the stops the guide has. */
export const clampPosition = (position: number, count: number): number => Math.max(Math.min(position, count - 1), 0);
