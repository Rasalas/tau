import { describe, expect, it, vi } from "vitest";
import type { ClientStorage, UiFileDiff, WorkbenchActions } from "tau";
import { handOffComments } from "./comment-views.js";
import { codeInRange, commentChip, commentsAsText, commentsEndingAt, ReviewCommentStore, type ReviewComment } from "./comments.js";

const DIFF: UiFileDiff = {
  path: "src/a.ts",
  added: 2,
  removed: 1,
  hunks: [{ header: "@@ -10,3 +10,4 @@", lines: [
    { kind: "context", oldLine: 10, newLine: 10, text: "function run() {" },
    { kind: "removed", oldLine: 11, text: "  return 1;" },
    { kind: "added", newLine: 11, text: "  const value = 2;" },
    { kind: "added", newLine: 12, text: "  return value;" },
    { kind: "context", oldLine: 12, newLine: 13, text: "}" },
  ] }],
};

const COMMENT: ReviewComment = {
  id: "c1",
  path: "src/a.ts",
  side: "new",
  startLine: 11,
  endLine: 12,
  code: ["+   const value = 2;", "+   return value;"],
  body: "Inline this.",
  createdAt: 1,
};

function createMemoryStorage(): ClientStorage {
  const store = new Map<string, string>();
  return {
    get: (key) => store.get(key) ?? null,
    set: (key, value) => { store.set(key, value); },
    remove: (key) => { store.delete(key); },
    keys: () => [...store.keys()],
  };
}

function actions(overrides: Partial<WorkbenchActions> = {}): WorkbenchActions {
  return { notify: vi.fn(), focusComposer: vi.fn(), composerDraft: () => "", ...overrides } as unknown as WorkbenchActions;
}

describe("review comment serialization", () => {
  it("becomes a text excerpt naming the path and lines, with the lines it covers", () => {
    expect(commentChip(COMMENT)).toEqual({
      kind: "text-excerpt",
      label: "a.ts:11-12",
      payload: {
        source: "Review comment on src/a.ts:11-12",
        text: "Inline this.\n\n```diff\n+   const value = 2;\n+   return value;\n```",
      },
    });
    expect(commentChip({ ...COMMENT, side: "old", startLine: 11, endLine: 11, code: ["-   return 1;"] }).payload.source)
      .toBe("Review comment on src/a.ts:11 (before the change)");
    expect(commentChip({ ...COMMENT, startLine: undefined, endLine: undefined, code: [] })).toMatchObject({
      label: "a.ts",
      payload: { source: "Review comment on src/a.ts", text: "Inline this." },
    });
  });

  it("reads as the composer would quote it when no chip service is there", () => {
    expect(commentsAsText([{ ...COMMENT, code: [] }, { ...COMMENT, id: "c2", startLine: 13, endLine: 13, code: [], body: "Two\nlines" }]))
      .toBe("From Review comment on src/a.ts:11-12:\n> Inline this.\n\nFrom Review comment on src/a.ts:13:\n> Two\n> lines");
  });

  it("quotes a range in diff order, keeping removed lines between its ends", () => {
    expect(codeInRange(DIFF, "new", 10, 12)).toEqual(["  function run() {", "-   return 1;", "+   const value = 2;", "+   return value;"]);
    expect(codeInRange(DIFF, "old", 11, 11)).toEqual(["-   return 1;"]);
    expect(codeInRange(undefined, "new", 1, 1)).toEqual([]);
  });

  it("sits under the last line of its range, on its own side only", () => {
    const [context, removed, , second, closing] = DIFF.hunks[0]!.lines;
    expect(commentsEndingAt([COMMENT], "src/a.ts", second!)).toEqual([COMMENT]);
    expect(commentsEndingAt([COMMENT], "src/b.ts", second!)).toEqual([]);
    const old = { ...COMMENT, side: "old" as const, startLine: 12, endLine: 12 };
    expect(commentsEndingAt([old], "src/a.ts", closing!)).toEqual([old]);
    expect(commentsEndingAt([old], "src/a.ts", second!)).toEqual([]);
    expect(commentsEndingAt([{ ...COMMENT, side: "old", startLine: 11, endLine: 11 }], "src/a.ts", removed!)).toHaveLength(1);
    expect(commentsEndingAt([COMMENT], "src/a.ts", context!)).toEqual([]);
  });
});

describe("ReviewCommentStore", () => {
  it("writes a comment on a line, stretches it to a range with shift and keeps it per workspace", () => {
    const storage = createMemoryStorage();
    const store = new ReviewCommentStore(() => storage, () => "id-1");
    store.open("ws");
    store.recordDiff("src/a.ts", DIFF, false);
    const lines = DIFF.hunks[0]!.lines;

    store.lineAction("src/a.ts", lines[2]!, false);
    expect(store.getSnapshot().draft).toMatchObject({ side: "new", startLine: 11, endLine: 11, code: ["+   const value = 2;"] });
    store.lineAction("src/a.ts", lines[4]!, true);
    expect(store.getSnapshot().draft).toMatchObject({ startLine: 11, endLine: 13 });
    store.setDraftBody("  Simplify  ");
    store.saveDraft();

    expect(store.getSnapshot().draft).toBeUndefined();
    expect(store.getSnapshot().comments).toEqual([expect.objectContaining({ id: "id-1", body: "Simplify", startLine: 11, endLine: 13 })]);
    const reopened = new ReviewCommentStore(() => storage);
    reopened.open("ws");
    expect(reopened.getSnapshot().comments).toHaveLength(1);
    reopened.open("other");
    expect(reopened.getSnapshot().comments).toEqual([]);
  });

  it("starts on the old side for a removed line and never saves an empty comment", () => {
    const store = new ReviewCommentStore(() => undefined);
    store.open("ws");
    store.lineAction("src/a.ts", DIFF.hunks[0]!.lines[1]!, false);
    expect(store.getSnapshot().draft).toMatchObject({ side: "old", startLine: 11, code: ["-   return 1;"] });
    store.setDraftBody("   ");
    store.saveDraft();
    expect(store.getSnapshot().comments).toEqual([]);
    store.cancelDraft();
    expect(store.getSnapshot().draft).toBeUndefined();
  });

  it("takes over core's older unresolved review notes once", () => {
    const storage = createMemoryStorage();
    storage.set("tau.review.v1:ws:worktree", JSON.stringify({ readPaths: [], comments: [
      { id: "n1", path: "src/a.ts", line: 4, body: "Old note", createdAt: 5 },
      { id: "n2", path: "src/a.ts", body: "Done", createdAt: 6, resolved: true },
    ] }));
    storage.set("tau.review.v1:ws:branch", JSON.stringify({ comments: [{ id: "n3", path: "src/b.ts", body: "Whole file", createdAt: 7 }] }));
    const store = new ReviewCommentStore(() => storage);
    store.open("ws");
    expect(store.getSnapshot().comments).toEqual([
      { id: "n1", path: "src/a.ts", side: "new", startLine: 4, endLine: 4, code: [], body: "Old note", createdAt: 5 },
      { id: "n3", path: "src/b.ts", side: "new", code: [], body: "Whole file", createdAt: 7 },
    ]);
    store.remove(["n1", "n3"]);
    const again = new ReviewCommentStore(() => storage);
    again.open("ws");
    expect(again.getSnapshot().comments).toEqual([]);
  });
});

describe("handing comments to the composer", () => {
  it("waits for the composer to come back, adds one chip per comment and drops what it took", () => {
    const frames: Array<() => void> = [];
    let open = false;
    const addChip = vi.fn(() => { if (!open) throw new Error("No composer is open to take the chip."); return "chip"; });
    const remove = vi.fn();
    const workbench = actions();
    handOffComments([COMMENT, { ...COMMENT, id: "c2" }], { chips: { addChip, removeChip: vi.fn() }, actions: workbench, remove, nextFrame: (run) => frames.push(run) });

    expect(remove).not.toHaveBeenCalled();
    open = true;
    frames.shift()!();
    expect(addChip).toHaveBeenLastCalledWith(commentChip({ ...COMMENT, id: "c2" }));
    expect(remove).toHaveBeenCalledWith(["c1", "c2"]);
    expect(workbench.focusComposer).toHaveBeenCalledWith();
  });

  it("keeps the comments and says so when no composer ever opens", () => {
    const frames: Array<() => void> = [];
    const remove = vi.fn();
    const workbench = actions();
    handOffComments([COMMENT], {
      chips: { addChip: () => { throw new Error("No composer is open to take the chip."); }, removeChip: vi.fn() },
      actions: workbench,
      remove,
      nextFrame: (run) => frames.push(run),
    });
    while (frames.length > 0) frames.shift()!();
    expect(remove).not.toHaveBeenCalled();
    expect(workbench.notify).toHaveBeenCalledWith(expect.stringContaining("stayed in the review"));
  });

  it("falls back to text in the draft without Composer Context", () => {
    const remove = vi.fn();
    const workbench = actions({ composerDraft: () => "Fix these" });
    handOffComments([{ ...COMMENT, code: [] }], { actions: workbench, remove });
    expect(workbench.focusComposer).toHaveBeenCalledWith("Fix these\n\nFrom Review comment on src/a.ts:11-12:\n> Inline this.");
    expect(remove).toHaveBeenCalledWith(["c1"]);
  });
});
