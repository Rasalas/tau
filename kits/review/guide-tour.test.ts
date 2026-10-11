import { describe, expect, it } from "vitest";
import type { UiDiffLine, UiFileDiff } from "tau";
import type { GuideStop, PullRequestGuide } from "./guide-protocol.js";
import {
  clampPosition, diffRows, excerptDiff, excerptRows, expandExcerpt, guideFailure, GuideProgressStore, guideProgressKey, isGuideStale, letterStopNotes,
  noteMarker, shiftOldLines, stepTourPosition, stopFilePaths, stopSubline,
} from "./guide-tour.js";

const ctx = (old: number, next: number): UiDiffLine => ({ kind: "context", oldLine: old, newLine: next, text: `c${next}` });
const add = (next: number): UiDiffLine => ({ kind: "added", newLine: next, text: `+${next}` });
const rem = (old: number): UiDiffLine => ({ kind: "removed", oldLine: old, text: `-${old}` });

/** Two hunks: a replacement that adds a line, and a removal further down. */
const FILE: UiFileDiff = {
  path: "src/a.ts",
  added: 2,
  removed: 2,
  hunks: [
    { header: "@@ -10,5 +10,6 @@", lines: [ctx(10, 10), ctx(11, 11), rem(12), add(12), add(13), ctx(13, 14), ctx(14, 15)] },
    { header: "@@ -40,3 +41,2 @@", lines: [ctx(40, 41), rem(41), ctx(42, 42)] },
  ],
};

const stop = (change: Partial<GuideStop> = {}): GuideStop => ({ title: "Stop", summary: "", attention: null, excerpts: [], files: [], notes: [], questions: [], ...change });

describe("the tour's position", () => {
  it("steps one stop and stays inside the tour", () => {
    expect(stepTourPosition(1, 1, 3)).toBe(2);
    expect(stepTourPosition(2, 1, 3)).toBe(2);
    expect(stepTourPosition(0, -1, 3)).toBe(0);
    expect(stepTourPosition(0, 1, 0)).toBe(0);
    expect(clampPosition(9, 3)).toBe(2);
    expect(clampPosition(-1, 3)).toBe(0);
  });
});

describe("a stop's files", () => {
  it("lists excerpted files first, then the rest, once each", () => {
    const entry = stop({
      excerpts: [{ path: "b.ts", side: "new", start: 1, end: 2, caption: "" }, { path: "a.ts", side: "new", start: 1, end: 2, caption: "" }, { path: "b.ts", side: "old", start: 1, end: 2, caption: "" }],
      files: [{ path: "a.ts" }, { path: "c.ts", note: "snapshot" }],
    });
    expect(stopFilePaths(entry)).toEqual(["b.ts", "a.ts", "c.ts"]);
    expect(stopSubline(entry)).toBe("3 files");
  });

  it("names a stop without files and a stop with one", () => {
    expect(stopSubline(stop())).toBe("Context, no code");
    expect(stopSubline(stop({ files: [{ path: "x" }] }))).toBe("1 file");
  });
});

describe("lettered notes", () => {
  it("letters notes in guide order and groups those on one line", () => {
    const entry = stop({
      excerpts: [{ path: "a.ts", side: "new", start: 10, end: 20, caption: "" }, { path: "b.ts", side: "new", start: 1, end: 5, caption: "" }],
      notes: [
        { path: "a.ts", line: 12, title: "One", body: "" },
        { path: "b.ts", line: 3, title: "Two", body: "" },
        { path: "a.ts", line: 12, title: "Three", body: "" },
      ],
    });
    const { lettered, byExcerpt } = letterStopNotes(entry);
    expect(lettered.map((item) => item.marker)).toEqual(["A", "B", "C"]);
    expect(byExcerpt[0]).toEqual([{ line: 12, markers: [{ marker: "A", title: "One" }, { marker: "C", title: "Three" }] }]);
    expect(byExcerpt[1]).toEqual([{ line: 3, markers: [{ marker: "B", title: "Two" }] }]);
  });

  it("keeps the letter of a note outside every excerpt but marks no line", () => {
    const entry = stop({
      excerpts: [{ path: "a.ts", side: "new", start: 10, end: 20, caption: "" }],
      notes: [{ path: "a.ts", line: 99, title: "Far", body: "" }, { path: "other.ts", line: 12, title: "Elsewhere", body: "" }],
    });
    const { lettered, byExcerpt } = letterStopNotes(entry);
    expect(lettered.map((item) => item.marker)).toEqual(["A", "B"]);
    expect(byExcerpt[0]).toEqual([]);
  });

  it("uses numbers after Z", () => {
    expect(noteMarker(0)).toBe("A");
    expect(noteMarker(25)).toBe("Z");
    expect(noteMarker(26)).toBe("27");
    const notes = Array.from({ length: 28 }, (_unused, index) => ({ path: "a.ts", line: 10, title: `n${index}`, body: "" }));
    const { lettered } = letterStopNotes(stop({ excerpts: [{ path: "a.ts", side: "new", start: 1, end: 20, caption: "" }], notes }));
    expect(lettered.at(-1)?.marker).toBe("28");
  });
});

describe("staleness", () => {
  const guide: Pick<PullRequestGuide, "headSha"> = { headSha: "aaa" };

  it("is stale only when a known head differs", () => {
    expect(isGuideStale(guide, "bbb")).toBe(true);
    expect(isGuideStale(guide, "aaa")).toBe(false);
    expect(isGuideStale(guide, null)).toBe(false);
    expect(isGuideStale(guide, undefined)).toBe(false);
  });

  it("tells a failed run only while it is about the head on screen", () => {
    const failed = { run: { state: "failed" as const, headSha: "aaa", failedAt: "t", detail: "no checkout" }, currentHeadSha: "aaa" };
    expect(guideFailure(failed, "aaa")).toBe("no checkout");
    expect(guideFailure(failed, "bbb")).toBeUndefined();
    expect(guideFailure(failed, null)).toBe("no checkout");
    expect(guideFailure({ run: { state: "running", headSha: "aaa", startedAt: "t" }, currentHeadSha: "aaa" }, "aaa")).toBeUndefined();
    expect(guideFailure(undefined, "aaa")).toBeUndefined();
  });
});

describe("a file's rows", () => {
  it("tracks where each side stands, also across a replacement", () => {
    const rows = diffRows(FILE);
    expect(rows.map((row) => [row.line.kind[0], row.oldAt, row.newAt, row.hunk])).toEqual([
      ["c", 10, 10, 0], ["c", 11, 11, 0], ["r", 12, 12, 0], ["a", 13, 12, 0], ["a", 13, 13, 0], ["c", 13, 14, 0], ["c", 14, 15, 0],
      ["c", 40, 41, 1], ["r", 41, 42, 1], ["c", 42, 42, 1],
    ]);
  });

  it("reads the start of a pure insertion from its header", () => {
    const insertion: UiFileDiff = { path: "n.ts", added: 2, removed: 0, hunks: [{ header: "@@ -9,0 +10,2 @@", lines: [add(10), add(11)] }] };
    expect(diffRows(insertion).map((row) => [row.oldAt, row.newAt])).toEqual([[10, 10], [10, 11]]);
  });
});

describe("an excerpt's rows", () => {
  const rows = diffRows(FILE);

  it("takes a range on the new side", () => {
    expect(excerptRows(rows, { side: "new", start: 11, end: 11 }).map((row) => row.line.text)).toEqual(["c11"]);
  });

  it("brings the lines an added line replaced when the range starts on it", () => {
    expect(excerptRows(rows, { side: "new", start: 12, end: 13 }).map((row) => row.line.text)).toEqual(["-12", "+12", "+13"]);
  });

  it("does not bring a removal from the other hunk", () => {
    const joined = diffRows({ ...FILE, hunks: [{ header: "", lines: [rem(1)] }, { header: "", lines: [add(2)] }] });
    expect(excerptRows(joined, { side: "new", start: 2, end: 2 }).map((row) => row.line.text)).toEqual(["+2"]);
  });

  it("takes removed lines by their old numbers and the lines that replaced them", () => {
    expect(excerptRows(rows, { side: "old", start: 12, end: 12 }).map((row) => row.line.text)).toEqual(["-12", "+12", "+13"]);
    expect(excerptRows(rows, { side: "old", start: 41, end: 41 }).map((row) => row.line.text)).toEqual(["-41"]);
  });

  it("spans two hunks and keeps the rows between", () => {
    const shown = excerptRows(rows, { side: "new", start: 15, end: 41 });
    expect(shown.map((row) => row.line.text)).toEqual(["c15", "c41"]);
    expect(new Set(shown.map((row) => row.hunk))).toEqual(new Set([0, 1]));
  });

  it("finds nothing outside the diff", () => {
    expect(excerptRows(rows, { side: "new", start: 100, end: 120 })).toEqual([]);
    expect(excerptRows(rows, { side: "old", start: 1, end: 2 })).toEqual([]);
  });
});

describe("an excerpt as a diff of its own", () => {
  it("keeps the real line numbers and writes the header git would", () => {
    const view = excerptDiff(FILE, { side: "new", start: 12, end: 13 })!;
    expect(view.diff.hunks).toHaveLength(1);
    expect(view.diff.hunks[0]!.header).toBe("@@ -12,1 +12,2 @@");
    expect(view.diff.hunks[0]!.lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([["removed", 12, undefined], ["added", undefined, 12], ["added", undefined, 13]]);
    expect([view.diff.added, view.diff.removed, view.shown, view.total]).toEqual([2, 1, 3, 10]);
    expect(view.startDelta).toBe(0);
  });

  it("names a pure insertion by the line before the empty old side", () => {
    const insertion: UiFileDiff = { path: "n.ts", added: 2, removed: 0, hunks: [{ header: "@@ -9,0 +10,2 @@", lines: [add(10), add(11)] }] };
    const view = excerptDiff(insertion, { side: "new", start: 10, end: 11 })!;
    expect(view.diff.hunks[0]!.header).toBe("@@ -9,0 +10,2 @@");
    expect(view.collapsible).toBe(true);
  });

  it("cuts an excerpt of removed code on the old side", () => {
    const view = excerptDiff(FILE, { side: "old", start: 41, end: 41 })!;
    expect(view.diff.hunks[0]!.header).toBe("@@ -41,1 +41,0 @@");
    expect(view.diff.removed).toBe(1);
    // A hunk that starts on a removal cannot be offered its surroundings: the view would read its gap on the old side.
    expect(view.collapsible).toBe(false);
  });

  it("makes one hunk per source hunk when the range spans two", () => {
    const view = excerptDiff(FILE, { side: "new", start: 14, end: 41 })!;
    expect(view.diff.hunks.map((hunk) => hunk.header)).toEqual(["@@ -13,2 +14,2 @@", "@@ -40,1 +41,1 @@"]);
    expect(view.startDelta).toBe(-1);
  });

  it("is undefined when no line of the range is in the diff", () => {
    expect(excerptDiff(FILE, { side: "new", start: 500, end: 510 })).toBeUndefined();
  });

  it("puts the old side in step before the cut and back for the expanded lines", () => {
    const view = excerptDiff(FILE, { side: "new", start: 41, end: 42 })!;
    expect(view.startDelta).toBe(-1);
    const seen: number[][] = [];
    const out = expandExcerpt(view, (diff) => {
      seen.push(diff.hunks.flatMap((hunk) => hunk.lines.map((line) => line.oldLine ?? -1)));
      return { ...diff, hunks: [{ header: "", lines: [{ kind: "context", oldLine: 40, newLine: 40, text: "x", expanded: true }, ...diff.hunks[0]!.lines] }] };
    });
    // The expansion saw the old side in step with the new one before the cut (40 -> 41), then it moved back.
    expect(seen[0]).toEqual([41, 42, 43]);
    expect(out.hunks[0]!.lines.map((line) => line.oldLine)).toEqual([39, 40, 41, 42]);
  });

  it("moves old numbers without touching the new side", () => {
    const moved = shiftOldLines(FILE, 3);
    expect(moved.hunks[0]!.lines[0]).toMatchObject({ oldLine: 13, newLine: 10 });
    expect(moved.hunks[0]!.lines[3]).toMatchObject({ newLine: 12 });
    expect(shiftOldLines(FILE, 0)).toBe(FILE);
  });
});

describe("progress", () => {
  const key = guideProgressKey("https://github.com/acme/tau/pull/7", "aaa");

  it("starts at the first stop with nothing seen", () => {
    const store = new GuideProgressStore();
    expect(store.get(key)).toEqual({ position: 0, seen: new Set() });
  });

  it("marks the stop it leaves going forward, not going back", () => {
    const store = new GuideProgressStore();
    store.go(key, 1);
    store.go(key, 2);
    store.go(key, 0);
    expect(store.get(key).position).toBe(0);
    expect([...store.get(key).seen]).toEqual([0, 1]);
  });

  it("is the same for every reader of the key and tells them it changed", () => {
    const store = new GuideProgressStore();
    let calls = 0;
    const off = store.subscribe(() => { calls += 1; });
    store.go(key, 1);
    store.markSeen(key, 4);
    expect(calls).toBe(2);
    expect(store.get(key)).toBe(store.get(key));
    off();
    store.go(key, 2);
    expect(calls).toBe(2);
  });

  it("starts over on a new head and forgets the old tour of that request", () => {
    const store = new GuideProgressStore();
    const other = guideProgressKey("https://github.com/acme/tau/pull/8", "aaa");
    store.go(key, 3);
    store.go(other, 1);
    const next = guideProgressKey("https://github.com/acme/tau/pull/7", "bbb");
    expect(store.get(next).position).toBe(0);
    store.go(next, 1);
    expect(store.get(key).position).toBe(0);
    expect(store.get(other).position).toBe(1);
  });
});
