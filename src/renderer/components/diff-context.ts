import type { UiDiffLine, UiFileDiff } from "../../shared/workspace-kit-types";

/** Lines of one file, counted on the new side and inclusive at both ends. */
export interface LineRange {
  from: number;
  to: number;
}

/**
 * A stretch of unchanged lines a diff leaves out: before its first hunk,
 * between two hunks or after the last one. `index` is the hunk it precedes
 * (the hunk count for the last).
 */
export interface DiffGap {
  path: string;
  index: number;
  where: "start" | "between" | "end";
  /** Absent for the stretch after the last hunk while the file's length is not known. */
  unchanged?: number;
  from: number;
  to: number;
}

/** Lines one click reveals. */
export const CONTEXT_STEP = 20;

/** Stands for "to the end of the file" where that end is not known yet. */
export const FILE_END = Number.MAX_SAFE_INTEGER;

export function splitFileText(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

const hasPosition = (line: UiDiffLine) => line.newLine !== undefined || line.oldLine !== undefined;

/**
 * Where a diff skips unchanged lines. Between changes old and new text run in
 * step, so the count is the same read on either side. `totalLines` is the
 * file's length at the new side; `"unknown"` still offers the stretch after
 * the last hunk, and `undefined` leaves it out.
 */
export function diffGaps(diff: UiFileDiff, totalLines?: number | "unknown"): DiffGap[] {
  const gaps: DiffGap[] = [];
  let oldEnd = 0;
  let newEnd = 0;
  diff.hunks.forEach((hunk, index) => {
    const first = hunk.lines.find(hasPosition);
    if (!first) return;
    const unchanged = first.newLine !== undefined ? first.newLine - newEnd - 1 : first.oldLine! - oldEnd - 1;
    if (unchanged > 0) {
      gaps.push({ path: diff.path, index, where: index === 0 ? "start" : "between", unchanged, from: newEnd + 1, to: newEnd + unchanged });
      newEnd += unchanged;
      oldEnd += unchanged;
    }
    for (const line of hunk.lines) {
      if (line.newLine !== undefined) newEnd = Math.max(newEnd, line.newLine);
      if (line.oldLine !== undefined) oldEnd = Math.max(oldEnd, line.oldLine);
    }
  });
  if (totalLines === undefined || diff.truncated || diff.hunks.length === 0) return gaps;
  const end = { path: diff.path, index: diff.hunks.length, where: "end" as const, from: newEnd + 1 };
  if (totalLines === "unknown") return [...gaps, { ...end, to: FILE_END }];
  return totalLines > newEnd ? [...gaps, { ...end, unchanged: totalLines - newEnd, to: totalLines }] : gaps;
}

/** The lines a click on one end of a gap reveals: below the change above it, above the change below it, or all. */
export function stepRange(gap: DiffGap, direction: "down" | "up" | "all", step = CONTEXT_STEP): LineRange {
  if (direction === "all") return { from: gap.from, to: gap.to };
  if (direction === "down") return { from: gap.from, to: Math.min(gap.to, gap.from + step - 1) };
  return { from: Math.max(gap.from, gap.to - step + 1), to: gap.to };
}

function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = ranges.filter((range) => range.to >= range.from).map((range) => ({ ...range })).sort((left, right) => left.from - right.from);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.from <= last.to + 1) last.to = Math.max(last.to, range.to);
    else merged.push(range);
  }
  return merged;
}

interface Piece {
  lines: UiDiffLine[];
  /** Kept while the piece is a hunk as the host sent it. */
  header?: string;
}

function headerOf(lines: readonly UiDiffLine[]): string {
  const old = lines.filter((line) => line.oldLine !== undefined);
  const next = lines.filter((line) => line.newLine !== undefined);
  return `@@ -${old[0]?.oldLine ?? 0},${old.length} +${next[0]?.newLine ?? 0},${next.length} @@`;
}

/**
 * The diff with the given new-side lines of the file drawn as unchanged
 * lines: a revealed stretch joins the hunk it touches, two hunks it bridges
 * become one, the rest stays folded. `fileLines` is the file at the diff's
 * head. The same ranges applied to a fresh diff give the same result, so a
 * caller keeps the ranges and not the diff.
 */
export function expandDiffContext(diff: UiFileDiff, fileLines: readonly string[], ranges: readonly LineRange[]): UiFileDiff {
  const wanted = mergeRanges(ranges);
  if (wanted.length === 0) return diff;
  const gaps = diffGaps(diff, fileLines.length);
  const pieces: Piece[] = [];
  let oldEnd = 0;
  let newEnd = 0;
  for (let index = 0; index <= diff.hunks.length; index += 1) {
    const gap = gaps.find((candidate) => candidate.index === index);
    let joinedNext = false;
    if (gap) {
      const delta = oldEnd - newEnd;
      if (gap.where !== "end") {
        oldEnd += gap.unchanged ?? 0;
        newEnd += gap.unchanged ?? 0;
      }
      for (const range of wanted) {
        const from = Math.max(range.from, gap.from);
        const to = Math.min(range.to, gap.to);
        if (to < from) continue;
        const lines = Array.from({ length: to - from + 1 }, (_unused, offset): UiDiffLine => ({ kind: "context", oldLine: from + offset + delta, newLine: from + offset, text: fileLines[from + offset - 1] ?? "", expanded: true }));
        const last = pieces.at(-1);
        if (from === gap.from && last && gap.where !== "start") {
          last.lines.push(...lines);
          delete last.header;
        } else {
          pieces.push({ lines });
        }
        joinedNext = to === gap.to && gap.where !== "end";
      }
    }
    const hunk = diff.hunks[index];
    if (!hunk) continue;
    const last = pieces.at(-1);
    if (joinedNext && last) {
      last.lines.push(...hunk.lines);
      delete last.header;
    } else {
      pieces.push({ lines: [...hunk.lines], header: hunk.header });
    }
    for (const line of hunk.lines) {
      if (line.newLine !== undefined) newEnd = Math.max(newEnd, line.newLine);
      if (line.oldLine !== undefined) oldEnd = Math.max(oldEnd, line.oldLine);
    }
  }
  return { ...diff, hunks: pieces.map((piece) => ({ header: piece.header ?? headerOf(piece.lines), lines: piece.lines })) };
}
