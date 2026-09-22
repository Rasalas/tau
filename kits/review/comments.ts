import type { ClientStorage, UiDiffLine, UiFileDiff } from "tau";
import type { ReviewCommentChip } from "./protocol.js";

/**
 * A line comment on the review's diff. `side` says which numbers the lines
 * are: the file after the change, or before it for lines the change removed.
 * A comment without lines is about the whole file (only older notes have none).
 */
export interface ReviewComment {
  id: string;
  path: string;
  side: "new" | "old";
  startLine?: number;
  endLine?: number;
  /** The diff lines it covers, each with its `+`, `-` or space mark, as the review showed them. */
  code: string[];
  body: string;
  createdAt: number;
}

export type CommentDraft = Omit<ReviewComment, "id" | "createdAt" | "startLine" | "endLine"> & { startLine: number; endLine: number };

/** A comment quotes at most this many diff lines; the rest is elided. */
const MAX_CODE_LINES = 40;
const STORAGE_PREFIX = "tau.review.comments.v1:";
/** Where core kept its own review notes before the kit took comments over. */
const LEGACY_PREFIX = "tau.review.v1:";

export function lineNumber(line: UiDiffLine, side: "new" | "old"): number | undefined {
  return side === "new" ? line.newLine : line.oldLine;
}

export function lineRange(comment: Pick<ReviewComment, "startLine" | "endLine">): string | undefined {
  if (comment.startLine === undefined) return undefined;
  const end = comment.endLine ?? comment.startLine;
  return end === comment.startLine ? `${comment.startLine}` : `${comment.startLine}-${end}`;
}

/** `src/a.ts:12-14`, with the side spelled out for lines the change removed. */
export function commentLocation(comment: Pick<ReviewComment, "path" | "side" | "startLine" | "endLine">): string {
  const range = lineRange(comment);
  if (!range) return comment.path;
  return comment.side === "old" ? `${comment.path}:${range} (before the change)` : `${comment.path}:${range}`;
}

function mark(line: UiDiffLine): string {
  return `${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "} ${line.text}`;
}

/**
 * The diff lines between two line numbers of one side, in diff order, so a
 * range over a change keeps the removed lines between its added ones.
 */
export function codeInRange(diff: UiFileDiff | undefined, side: "new" | "old", start: number, end: number): string[] {
  const lines = diff?.hunks.flatMap((hunk) => hunk.lines) ?? [];
  const first = lines.findIndex((line) => lineNumber(line, side) === start);
  let last = -1;
  lines.forEach((line, index) => { if (lineNumber(line, side) === end) last = index; });
  if (first < 0 || last < first) return [];
  const slice = lines.slice(first, last + 1).map(mark);
  return slice.length > MAX_CODE_LINES ? [...slice.slice(0, MAX_CODE_LINES), `… ${slice.length - MAX_CODE_LINES} more lines`] : slice;
}

/** The chip a comment becomes in the composer: an excerpt naming the path and lines. */
export function commentChip(comment: ReviewComment): ReviewCommentChip {
  const code = comment.code.length > 0 ? `\n\n\`\`\`diff\n${comment.code.join("\n")}\n\`\`\`` : "";
  return {
    kind: "text-excerpt",
    label: `${comment.path.split("/").at(-1)}${lineRange(comment) ? `:${lineRange(comment)}` : ""}`,
    payload: { source: `Review comment on ${commentLocation(comment)}`, text: `${comment.body.trim()}${code}` },
  };
}

/** What the composer receives when no chip service is there: the same words, as plain text. */
export function commentsAsText(comments: readonly ReviewComment[]): string {
  return comments.map((comment) => {
    const { payload } = commentChip(comment);
    const quoted = payload.text.split("\n").map((line) => line ? `> ${line}` : ">").join("\n");
    return `From ${payload.source}:\n${quoted}`;
  }).join("\n\n");
}

function parseComments(raw: string | null): ReviewComment[] | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as { comments?: unknown };
    return Array.isArray(parsed.comments) ? parsed.comments.filter(isComment) : [];
  } catch {
    return [];
  }
}

function isComment(value: unknown): value is ReviewComment {
  const entry = value as Partial<ReviewComment> | null;
  return Boolean(entry) && typeof entry!.id === "string" && typeof entry!.path === "string"
    && typeof entry!.body === "string" && (entry!.side === "new" || entry!.side === "old") && Array.isArray(entry!.code);
}

/** Core's own unresolved notes, from before the line seam; read once per workspace. */
function legacyNotes(storage: ClientStorage, workspace: string): ReviewComment[] {
  const notes: ReviewComment[] = [];
  for (const scope of ["worktree", "branch"]) {
    try {
      const parsed = JSON.parse(storage.get(`${LEGACY_PREFIX}${workspace}:${scope}`) ?? "null") as { comments?: unknown } | null;
      for (const note of Array.isArray(parsed?.comments) ? parsed.comments : []) {
        const entry = note as { id?: unknown; path?: unknown; line?: unknown; body?: unknown; createdAt?: unknown; resolved?: unknown };
        if (typeof entry.id !== "string" || typeof entry.path !== "string" || typeof entry.body !== "string" || entry.resolved) continue;
        const line = typeof entry.line === "number" ? entry.line : undefined;
        notes.push({
          id: entry.id,
          path: entry.path,
          side: "new",
          ...(line === undefined ? {} : { startLine: line, endLine: line }),
          code: [],
          body: entry.body,
          createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
        });
      }
    } catch { /* an unreadable note is not worth a failed review */ }
  }
  return notes;
}

export interface ReviewCommentsState {
  workspace?: string;
  comments: readonly ReviewComment[];
  draft?: CommentDraft;
  panelOpen: boolean;
}

/**
 * The comments of the workspace under review, kept in client storage per
 * workspace, and the one being written. Diffs the review loaded are recorded
 * so a range comment can quote the lines between its two ends.
 */
export class ReviewCommentStore {
  private state: ReviewCommentsState = { comments: [], panelOpen: false };
  private listeners = new Set<() => void>();
  private diffs = new Map<string, UiFileDiff>();

  constructor(private readonly storage: () => ClientStorage | undefined, private readonly newId: () => string = () => crypto.randomUUID()) {}

  getSnapshot = (): ReviewCommentsState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(patch: Partial<ReviewCommentsState>, persist = false): void {
    this.state = { ...this.state, ...patch };
    if (persist && this.state.workspace) {
      this.storage()?.set(`${STORAGE_PREFIX}${this.state.workspace}`, JSON.stringify({ comments: this.state.comments }));
    }
    for (const listener of this.listeners) listener();
  }

  /** Loads a workspace's comments; the first time, core's older notes become comments. */
  open(workspace: string): void {
    if (this.state.workspace === workspace) return;
    this.diffs.clear();
    const storage = this.storage();
    const stored = parseComments(storage?.get(`${STORAGE_PREFIX}${workspace}`) ?? null);
    const comments = stored ?? (storage ? legacyNotes(storage, workspace) : []);
    this.update({ workspace, comments, draft: undefined }, stored === undefined && comments.length > 0);
  }

  /** Records what the review loaded; a later page of the same file appends. */
  recordDiff(path: string, diff: UiFileDiff, appended: boolean): void {
    const current = this.diffs.get(path);
    this.diffs.set(path, appended && current ? { ...diff, hunks: [...current.hunks, ...diff.hunks] } : diff);
  }

  /**
   * The gutter action: starts a comment on a line, or with `extend` stretches
   * the open one to it when the line has a number on the same side.
   */
  lineAction(path: string, line: UiDiffLine, extend: boolean): void {
    const draft = this.state.draft;
    if (extend && draft && draft.path === path) {
      const number = lineNumber(line, draft.side);
      if (number !== undefined) {
        const startLine = Math.min(draft.startLine, number);
        const endLine = Math.max(draft.endLine, number);
        this.update({ draft: { ...draft, startLine, endLine, code: codeInRange(this.diffs.get(path), draft.side, startLine, endLine) } });
        return;
      }
    }
    const side = line.newLine !== undefined ? "new" : "old";
    const number = lineNumber(line, side);
    if (number === undefined) return;
    const code = codeInRange(this.diffs.get(path), side, number, number);
    this.update({ draft: { path, side, startLine: number, endLine: number, code: code.length > 0 ? code : [mark(line)], body: draft?.body ?? "" } });
  }

  setDraftBody(body: string): void {
    if (this.state.draft) this.update({ draft: { ...this.state.draft, body } });
  }

  cancelDraft(): void {
    if (this.state.draft) this.update({ draft: undefined });
  }

  saveDraft(): void {
    const draft = this.state.draft;
    if (!draft || !draft.body.trim()) return;
    const comment: ReviewComment = { ...draft, body: draft.body.trim(), id: this.newId(), createdAt: Date.now() };
    this.update({ draft: undefined, comments: [...this.state.comments, comment] }, true);
  }

  remove(ids: readonly string[]): void {
    const drop = new Set(ids);
    this.update({ comments: this.state.comments.filter((comment) => !drop.has(comment.id)) }, true);
  }

  setPanelOpen(panelOpen: boolean): void {
    this.update({ panelOpen });
  }
}

/** Comments drawn under a line: those whose range ends on it, on their own side. */
export function commentsEndingAt(comments: readonly ReviewComment[], path: string, line: UiDiffLine): ReviewComment[] {
  return comments.filter((comment) => comment.path === path
    && comment.endLine !== undefined
    && lineNumber(line, comment.side) === comment.endLine);
}
