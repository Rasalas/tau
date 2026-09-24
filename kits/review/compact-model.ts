import type { UiDiffLine, UiWorkspaceChanges, WorkspaceInfo } from "tau";
import { lineNumber, lineRange, type CommentDraft, type ReviewCommentStore } from "./comments.js";
import type { ReviewTurn } from "./protocol.js";

/** What the compact review shows: the uncommitted changes, the branch against its base, or one recorded turn. */
export type ReviewSource = { kind: "worktree" } | { kind: "branch" } | { kind: "turn"; id: string };

export const WORKTREE: ReviewSource = { kind: "worktree" };
export const BRANCH: ReviewSource = { kind: "branch" };

export function sourceKey(source: ReviewSource): string {
  return source.kind === "turn" ? `turn:${source.id}` : source.kind;
}

/** A recorded turn as the picker lists it: its number in the thread and what it changed. */
export interface TurnEntry {
  turn: ReviewTurn;
  number: number;
  fileCount: number;
}

/**
 * The turns worth a diff, newest first. Numbers count every recorded turn,
 * so "Turn 3" stays the third turn although a turn that changed nothing is not listed.
 */
export function turnEntries(turns: readonly ReviewTurn[]): TurnEntry[] {
  return [...turns]
    .sort((left, right) => left.endedAt - right.endedAt)
    .map((turn, index) => ({ turn, number: index + 1, fileCount: turn.fileCount ?? turn.files.length }))
    .filter((entry) => entry.fileCount > 0 || entry.turn.completeness === "partial")
    .reverse();
}

/** The latest turn that changed something, else the working tree: what a phone most likely came to read. */
export function defaultSource(turns: readonly TurnEntry[]): ReviewSource {
  const latest = turns[0];
  return latest ? { kind: "turn", id: latest.turn.id } : WORKTREE;
}

export function sourceLabel(source: ReviewSource, turns: readonly TurnEntry[]): string {
  if (source.kind === "worktree") return "Uncommitted changes";
  if (source.kind === "branch") return "Branch changes";
  const entry = turns.find((candidate) => candidate.turn.id === source.id);
  if (!entry) return "Turn changes";
  return entry === turns[0] ? `Latest turn (turn ${entry.number})` : `Turn ${entry.number}`;
}

export function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * A tap on a diff line. The first starts a comment on it, a tap on another
 * line of the same file stretches the comment to it, and a tap on the only
 * selected line lets it go while nothing is written yet.
 */
export function tapLine(store: ReviewCommentStore, path: string, line: UiDiffLine): void {
  const draft = store.getSnapshot().draft;
  if (draft && draft.path === path) {
    const number = lineNumber(line, draft.side);
    if (number !== undefined) {
      if (draft.startLine === draft.endLine && number === draft.startLine && !draft.body.trim()) store.cancelDraft();
      else store.lineAction(path, line, true);
      return;
    }
  }
  store.lineAction(path, line, false);
}

/** "Comment on line 12", "Comment on lines 12–15", with removed lines named as such. */
export function selectionLabel(draft: Pick<CommentDraft, "side" | "startLine" | "endLine">): string {
  const range = lineRange(draft)?.replace("-", "–") ?? "";
  const plural = draft.startLine !== draft.endLine;
  const lines = draft.side === "old" ? `removed ${plural ? "lines" : "line"}` : plural ? "lines" : "line";
  return `Comment on ${lines} ${range}`;
}

/** Why a write is not offered, said where it would have been. */
export const READ_ONLY_REASON = "This device is paired Read only. It can read diffs; commenting, committing, pushing and opening a pull request need Full access.";

/** What a commit from the phone would do, in the words its question uses. */
export function commitQuestion(changes: UiWorkspaceChanges, info: WorkspaceInfo | undefined, message: string, push: boolean): { title: string; message: string; confirm: string } {
  const count = changes.fileCount ?? changes.files.length;
  const staged = changes.files.filter((file) => file.staged).length;
  const branch = info?.branch ?? changes.branch;
  const what = staged > 0
    ? staged === 1 ? "Commits the staged file" : `Commits the ${countLabel(staged, "staged file")}`
    : count === 1 ? "Stages and commits the changed file" : `Stages and commits all ${countLabel(count, "changed file")}`;
  const where = branch ? ` on ${branch}` : "";
  const subject = message.trim().split(/\r?\n/u)[0] ?? "";
  const pushing = push ? `, then pushes to ${info?.upstream ?? "the remote"}` : "";
  return {
    title: push ? "Commit and push?" : "Commit?",
    message: `${what}${where}${pushing}: “${subject}”.`,
    confirm: push ? "Commit and push" : "Commit",
  };
}

export function pushQuestion(info: WorkspaceInfo | undefined): { title: string; message: string; confirm: string } {
  const ahead = info?.ahead ?? 0;
  const commits = ahead > 0 ? countLabel(ahead, "commit") : "the branch";
  const target = info?.upstream ?? "the remote";
  return {
    title: "Push?",
    message: `Pushes ${commits}${info?.branch ? ` of ${info.branch}` : ""} to ${target}. Others with access to the remote can see them.`,
    confirm: "Push",
  };
}

export function requestQuestion(input: { title: string; base: string; branch?: string; draft: boolean; noun: string; host: string }): { title: string; message: string; confirm: string } {
  const kind = input.draft ? `draft ${input.noun}` : input.noun;
  return {
    title: `Open a ${kind}?`,
    message: `Pushes ${input.branch ?? "the branch"} and opens “${input.title.trim()}” into ${input.base} on ${input.host}.`,
    confirm: `Open ${input.noun}`,
  };
}
