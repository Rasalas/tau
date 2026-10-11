import {
  GUIDE_MAX_EXCERPT_LINES,
  GUIDE_MAX_NOTES,
  GUIDE_MAX_QUESTIONS,
  GUIDE_MAX_STOPS,
  type GuideAttention,
  type GuideAttentionKind,
  type GuideExcerpt,
  type GuideStop,
} from "./guide-protocol.js";
import type { PullRequestFiles } from "./protocol.js";

interface LineRange {
  start: number;
  end: number;
}

/** The lines the change touched in one file, on each side. */
interface FileHunks {
  new: LineRange[];
  old: LineRange[];
}

/** What a guide is held to: the changed paths and the lines each one touched. */
export interface GuideChange {
  /** Every changed path in diff order (new names for renames). */
  files: readonly string[];
  /** Absent for a file whose diff the host did not give (binary, too large): it can only be listed. */
  hunks: ReadonlyMap<string, FileHunks>;
}

const KINDS: readonly GuideAttentionKind[] = ["tradeoff", "contract", "product", "risk", "accessibility"];

/** Consecutive line numbers become one range. */
function ranges(lines: readonly number[]): LineRange[] {
  const out: LineRange[] = [];
  for (const line of lines) {
    const last = out.at(-1);
    if (last && line === last.end + 1) last.end = line;
    else out.push({ start: line, end: line });
  }
  return out;
}

/** The change a pull request's files describe; only added and removed lines count as touched. */
export function guideChangeOf(files: Pick<PullRequestFiles, "files" | "diffs">): GuideChange {
  const hunks = new Map<string, FileHunks>();
  for (const diff of files.diffs) {
    const added: number[] = [];
    const removed: number[] = [];
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "added" && line.newLine !== undefined) added.push(line.newLine);
        else if (line.kind === "removed" && line.oldLine !== undefined) removed.push(line.oldLine);
      }
    }
    hunks.set(diff.path, { new: ranges(added), old: ranges(removed) });
  }
  return { files: files.files.map((file) => file.path), hunks };
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const lineNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;

/** Reads what an agent submitted into stops, tolerating missing or mistyped fields; the change check comes after. */
export function decodeGuideStops(raw: unknown): GuideStop[] {
  const stops = Array.isArray(record(raw).stops) ? record(raw).stops as unknown[] : [];
  return stops.map((entry): GuideStop => {
    const stop = record(entry);
    const attention = record(stop.attention);
    const kind = KINDS.find((candidate) => candidate === attention.kind);
    const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
    return {
      title: text(stop.title),
      summary: text(stop.summary),
      attention: kind && text(attention.note) ? { kind, note: text(attention.note) } : null,
      excerpts: list(stop.excerpts).flatMap((item) => {
        const excerpt = record(item);
        const start = lineNumber(excerpt.start);
        const end = lineNumber(excerpt.end);
        const path = text(excerpt.path);
        if (!path || start === undefined || end === undefined) return [];
        return [{ path, side: excerpt.side === "old" ? "old" as const : "new" as const, start, end, caption: text(excerpt.caption) }];
      }),
      files: list(stop.files).flatMap((item) => {
        const file = record(item);
        const path = text(file.path);
        return path ? [{ path, ...(text(file.note) ? { note: text(file.note) } : {}) }] : [];
      }),
      notes: list(stop.notes).flatMap((item) => {
        const note = record(item);
        const line = lineNumber(note.line);
        const path = text(note.path);
        return path && line !== undefined ? [{ path, line, title: text(note.title), body: text(note.body) }] : [];
      }),
      questions: list(stop.questions).map(text),
    };
  });
}

/**
 * Narrows an excerpt to the changed lines it covers, from the first changed line it overlaps to the last.
 * Null when it covers none: the agent pointed where the change is not.
 */
function clampExcerpt(excerpt: GuideExcerpt, change: GuideChange): GuideExcerpt | null {
  const start = Math.min(excerpt.start, excerpt.end);
  const end = Math.max(excerpt.start, excerpt.end);
  const overlapping = (change.hunks.get(excerpt.path)?.[excerpt.side] ?? []).filter((hunk) => hunk.start <= end && start <= hunk.end);
  const first = overlapping[0];
  const last = overlapping.at(-1);
  if (!first || !last) return null;
  return { ...excerpt, start: Math.max(start, first.start), end: Math.min(end, last.end) };
}

/** Joins a stop's excerpts that overlap or touch in one file, then caps each one's length. */
function mergeExcerpts(excerpts: readonly GuideExcerpt[]): GuideExcerpt[] {
  const merged: GuideExcerpt[] = [];
  for (const excerpt of excerpts) {
    const index = merged.findIndex((other) => other.path === excerpt.path && other.side === excerpt.side && other.start <= excerpt.end + 1 && excerpt.start <= other.end + 1);
    const other = merged[index];
    if (!other) { merged.push(excerpt); continue; }
    merged[index] = { ...other, start: Math.min(other.start, excerpt.start), end: Math.max(other.end, excerpt.end), caption: other.caption || excerpt.caption };
  }
  return merged.map((excerpt) => ({ ...excerpt, end: Math.min(excerpt.end, excerpt.start + GUIDE_MAX_EXCERPT_LINES - 1) }));
}

/**
 * Holds a submitted guide to the change it describes. An agent's line numbers and paths are suggestions:
 * excerpts are clamped to changed lines, notes must sit inside what is left, and any changed file the tour
 * skipped lands in a closing skim stop, so every file is accounted for.
 */
export function normalizeGuide(stops: readonly GuideStop[], change: GuideChange): GuideStop[] {
  const changed = new Set(change.files);
  const shaped = stops.filter((stop) => stop.title.trim()).slice(0, GUIDE_MAX_STOPS).map((stop): GuideStop => {
    const excerpts = mergeExcerpts(stop.excerpts.flatMap((excerpt) => {
      const clamped = changed.has(excerpt.path) ? clampExcerpt(excerpt, change) : null;
      return clamped ? [clamped] : [];
    }));
    const attention: GuideAttention | null = stop.attention && stop.attention.note.trim() ? stop.attention : null;
    return {
      ...stop,
      attention,
      excerpts,
      files: stop.files.filter((file) => changed.has(file.path)).map(({ path, note }) => note?.trim() ? { path, note } : { path }),
      notes: stop.notes
        .filter((note) => note.title.trim() && excerpts.some((excerpt) => excerpt.path === note.path && excerpt.start <= note.line && note.line <= excerpt.end))
        .slice(0, GUIDE_MAX_NOTES),
      questions: stop.questions.filter((question) => question.trim()).slice(0, GUIDE_MAX_QUESTIONS),
    };
  });
  // A file may be excerpted in several stops; a `files` entry is for one the tour never shows, listed once.
  const placed = new Set(shaped.flatMap((stop) => stop.excerpts.map((excerpt) => excerpt.path)));
  const result = shaped.map((stop) => {
    const files = stop.files.filter((file) => !placed.has(file.path));
    for (const file of files) placed.add(file.path);
    return { ...stop, files };
  });
  const unplaced = change.files.filter((path) => !placed.has(path));
  if (unplaced.length > 0) {
    result.push({ title: "Other files", summary: "Changed files the tour does not otherwise cover.", attention: null, excerpts: [], files: unplaced.map((path) => ({ path })), notes: [], questions: [] });
  }
  return result;
}
