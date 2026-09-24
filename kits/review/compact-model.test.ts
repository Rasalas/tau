import { describe, expect, it } from "vitest";
import type { UiDiffLine, UiWorkspaceChanges, WorkspaceInfo } from "tau";
import { ReviewCommentStore } from "./comments.js";
import { commitQuestion, defaultSource, pushQuestion, requestQuestion, selectionLabel, sourceLabel, tapLine, turnEntries, WORKTREE } from "./compact-model.js";
import type { ReviewTurn } from "./protocol.js";

const turn = (id: string, endedAt: number, files: number, partial = false): ReviewTurn => ({
  id,
  sessionId: "s",
  startedAt: endedAt - 10,
  endedAt,
  files: Array.from({ length: files }, (_, index) => ({ path: `f${index}`, name: `f${index}`, directory: "", status: "modified" as const, added: 1, removed: 0 })),
  fileCount: files,
  added: files,
  removed: 0,
  ...(partial ? { completeness: "partial" as const } : {}),
});

const line = (newLine: number | undefined, oldLine?: number): UiDiffLine => ({
  kind: newLine === undefined ? "removed" : oldLine === undefined ? "added" : "context",
  ...(newLine === undefined ? {} : { newLine }),
  ...(oldLine === undefined ? {} : { oldLine }),
  text: `line ${newLine ?? oldLine}`,
});

describe("the compact review's model", () => {
  it("lists the turns that changed something, newest first, numbered among all turns", () => {
    const entries = turnEntries([turn("b", 20, 0), turn("a", 10, 2), turn("c", 30, 1), turn("d", 40, 0, true)]);
    expect(entries.map((entry) => [entry.turn.id, entry.number, entry.fileCount])).toEqual([["d", 4, 0], ["c", 3, 1], ["a", 1, 2]]);
    expect(defaultSource(entries)).toEqual({ kind: "turn", id: "d" });
    expect(sourceLabel({ kind: "turn", id: "d" }, entries)).toBe("Latest turn (turn 4)");
    expect(sourceLabel({ kind: "turn", id: "a" }, entries)).toBe("Turn 1");
  });

  it("opens on the working tree when no turn changed a file", () => {
    expect(defaultSource(turnEntries([turn("a", 10, 0)]))).toEqual(WORKTREE);
    expect(sourceLabel(WORKTREE, [])).toBe("Uncommitted changes");
  });

  it("starts a comment with a tap, stretches it with a second and lets a lone line go with a third", () => {
    const store = new ReviewCommentStore(() => undefined, () => "id");
    tapLine(store, "a.ts", line(4, 4));
    expect(store.getSnapshot().draft).toMatchObject({ path: "a.ts", startLine: 4, endLine: 4 });
    tapLine(store, "a.ts", line(7, 7));
    expect(store.getSnapshot().draft).toMatchObject({ startLine: 4, endLine: 7 });
    tapLine(store, "b.ts", line(2, 2));
    expect(store.getSnapshot().draft).toMatchObject({ path: "b.ts", startLine: 2, endLine: 2 });
    tapLine(store, "b.ts", line(2, 2));
    expect(store.getSnapshot().draft).toBeUndefined();
  });

  it("keeps a lone line selected once the comment has words", () => {
    const store = new ReviewCommentStore(() => undefined, () => "id");
    tapLine(store, "a.ts", line(4, 4));
    store.setDraftBody("rename this");
    tapLine(store, "a.ts", line(4, 4));
    expect(store.getSnapshot().draft).toMatchObject({ startLine: 4, endLine: 4, body: "rename this" });
    expect(store.takeDraft()).toMatchObject({ id: "id", path: "a.ts", body: "rename this" });
    expect(store.getSnapshot().draft).toBeUndefined();
    expect(store.getSnapshot().comments).toEqual([]);
  });

  it("names the selection on the side its numbers come from", () => {
    expect(selectionLabel({ side: "new", startLine: 3, endLine: 3 })).toBe("Comment on line 3");
    expect(selectionLabel({ side: "new", startLine: 3, endLine: 9 })).toBe("Comment on lines 3–9");
    expect(selectionLabel({ side: "old", startLine: 5, endLine: 5 })).toBe("Comment on removed line 5");
  });

  it("says in the question what a commit, a push and a new request do", () => {
    const changes: UiWorkspaceChanges = { files: [{ path: "a", name: "a", directory: "", status: "modified", added: 1, removed: 0 }, { path: "b", name: "b", directory: "", status: "added", added: 2, removed: 0 }], added: 3, removed: 0 };
    const info = { branch: "feat/x", upstream: "origin/feat/x", ahead: 2 } as WorkspaceInfo;
    expect(commitQuestion(changes, info, "Fix it\n\nbody", false)).toEqual({ title: "Commit?", message: "Stages and commits all 2 changed files on feat/x: “Fix it”.", confirm: "Commit" });
    const staged = { ...changes, files: [{ ...changes.files[0]!, staged: true }, changes.files[1]!] };
    expect(commitQuestion(staged, info, "Fix it", true).message).toBe("Commits the staged file on feat/x, then pushes to origin/feat/x: “Fix it”.");
    expect(commitQuestion({ ...changes, files: [changes.files[0]!] }, info, "Fix it", false).message).toBe("Stages and commits the changed file on feat/x: “Fix it”.");
    expect(pushQuestion(info).message).toBe("Pushes 2 commits of feat/x to origin/feat/x. Others with access to the remote can see them.");
    expect(requestQuestion({ title: " Add x ", base: "main", branch: "feat/x", draft: true, noun: "pull request", host: "GitHub" }))
      .toEqual({ title: "Open a draft pull request?", message: "Pushes feat/x and opens “Add x” into main on GitHub.", confirm: "Open pull request" });
  });
});
