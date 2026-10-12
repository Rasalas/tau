import { describe, expect, it } from "vitest";
import type { UiDiffLine, UiFileDiff } from "tau";
import { decodeGuideStops, guideChangeOf, normalizeGuide } from "./guide-normalize.js";
import type { GuideStop } from "./guide-protocol.js";
import type { PullRequestFile } from "./protocol.js";

const stop = (patch: Partial<GuideStop> = {}): GuideStop => ({ title: "Stop", summary: "", attention: null, excerpts: [], files: [], notes: [], questions: [], ...patch });

/** A diff with `added` new-side line numbers and `removed` old-side ones; context lines between are filled in. */
function diff(path: string, added: number[], removed: number[] = []): UiFileDiff {
  const lines: UiDiffLine[] = [
    ...removed.map((oldLine): UiDiffLine => ({ kind: "removed", oldLine, text: `-${oldLine}` })),
    ...added.map((newLine): UiDiffLine => ({ kind: "added", newLine, text: `+${newLine}` })),
  ];
  return { path, added: added.length, removed: removed.length, hunks: [{ header: "@@", lines }] };
}
const file = (path: string, status: PullRequestFile["status"] = "modified"): PullRequestFile => ({ path, status, added: 1, removed: 0, viewed: "unviewed" });
const change = (diffs: UiFileDiff[], extra: string[] = []) => guideChangeOf({ files: [...diffs.map((entry) => file(entry.path)), ...extra.map((path) => file(path))], diffs });

describe("guideChangeOf", () => {
  it("makes ranges of consecutive changed lines per side", () => {
    const result = guideChangeOf({ files: [file("a.ts")], diffs: [diff("a.ts", [3, 4, 5, 9], [2, 3])] });
    expect(result.files).toEqual(["a.ts"]);
    expect(result.hunks.get("a.ts")).toEqual({ new: [{ start: 3, end: 5 }, { start: 9, end: 9 }], old: [{ start: 2, end: 3 }] });
  });

  it("does not count context lines as touched", () => {
    const withContext: UiFileDiff = { path: "a.ts", added: 1, removed: 0, hunks: [{ header: "@@", lines: [{ kind: "context", oldLine: 1, newLine: 1, text: "" }, { kind: "added", newLine: 2, text: "x" }] }] };
    expect(guideChangeOf({ files: [file("a.ts")], diffs: [withContext] }).hunks.get("a.ts")?.new).toEqual([{ start: 2, end: 2 }]);
  });

  it("keeps a file without a diff in the file list but gives it no hunks", () => {
    const result = guideChangeOf({ files: [file("logo.png")], diffs: [] });
    expect(result.files).toEqual(["logo.png"]);
    expect(result.hunks.has("logo.png")).toBe(false);
  });
});

describe("decodeGuideStops", () => {
  it("reads a well-formed submission", () => {
    const stops = decodeGuideStops({
      stops: [{
        title: " Contract ", summary: "Before and after.", attention: { kind: "contract", note: " Check it. " },
        excerpts: [{ path: "a.ts", side: "new", start: 3, end: 9, caption: "shape" }],
        files: [{ path: "b.ts", note: "renamed" }], notes: [{ path: "a.ts", line: 4, title: "why", body: "because" }], questions: ["Why?"],
      }],
    });
    expect(stops).toEqual([{
      title: "Contract", summary: "Before and after.", attention: { kind: "contract", note: "Check it." },
      excerpts: [{ path: "a.ts", side: "new", start: 3, end: 9, caption: "shape" }],
      files: [{ path: "b.ts", note: "renamed" }], notes: [{ path: "a.ts", line: 4, title: "why", body: "because" }], questions: ["Why?"],
    }]);
  });

  it("survives garbage: wrong types, unknown attention kinds, missing arrays", () => {
    expect(decodeGuideStops(undefined)).toEqual([]);
    expect(decodeGuideStops({ stops: "no" })).toEqual([]);
    const [only] = decodeGuideStops({ stops: [{ title: 4, attention: { kind: "bug", note: "x" }, excerpts: [{ path: "a", start: "1", end: 2 }, { path: "a", start: 0, end: 2 }, null], notes: [{ path: "a" }], files: [{}] }] });
    expect(only).toEqual({ title: "", summary: "", attention: null, excerpts: [], files: [], notes: [], questions: [] });
  });

  it("floors fractional lines and defaults the side to new", () => {
    const [only] = decodeGuideStops({ stops: [{ title: "t", excerpts: [{ path: "a", side: "sideways", start: 2.9, end: 5.2 }] }] });
    expect(only!.excerpts).toEqual([{ path: "a", side: "new", start: 2, end: 5, caption: "" }]);
  });
});

describe("normalizeGuide", () => {
  const a = diff("a.ts", [10, 11, 12, 13, 14, 15, 40, 41], [5, 6]);

  it("clamps an excerpt to the changed lines it overlaps", () => {
    const [first] = normalizeGuide([stop({ excerpts: [{ path: "a.ts", side: "new", start: 1, end: 12, caption: "c" }] })], change([a]));
    expect(first!.excerpts).toEqual([{ path: "a.ts", side: "new", start: 10, end: 12, caption: "c" }]);
  });

  it("spans two changed ranges when the excerpt covers both", () => {
    const [first] = normalizeGuide([stop({ excerpts: [{ path: "a.ts", side: "new", start: 12, end: 40, caption: "" }] })], change([a]));
    expect(first!.excerpts[0]).toMatchObject({ start: 12, end: 36 }); // capped at 25 lines
  });

  it("swaps a reversed range", () => {
    const [first] = normalizeGuide([stop({ excerpts: [{ path: "a.ts", side: "new", start: 14, end: 11, caption: "" }] })], change([a]));
    expect(first!.excerpts[0]).toMatchObject({ start: 11, end: 14 });
  });

  it("drops an excerpt that sits entirely in unchanged lines or on the wrong side", () => {
    const [first] = normalizeGuide([stop({ excerpts: [
      { path: "a.ts", side: "new", start: 20, end: 30, caption: "" },
      { path: "a.ts", side: "old", start: 10, end: 15, caption: "" },
    ] })], change([a]));
    expect(first!.excerpts).toEqual([]);
  });

  it("shows removed code with the old side", () => {
    const [first] = normalizeGuide([stop({ excerpts: [{ path: "a.ts", side: "old", start: 4, end: 9, caption: "" }] })], change([a]));
    expect(first!.excerpts[0]).toMatchObject({ side: "old", start: 5, end: 6 });
  });

  it("drops excerpts of files outside the change", () => {
    const [first] = normalizeGuide([stop({ excerpts: [{ path: "other.ts", side: "new", start: 1, end: 3, caption: "" }] })], change([a]));
    expect(first!.excerpts).toEqual([]);
  });

  it("merges excerpts that overlap or touch and keeps the first caption", () => {
    const [first] = normalizeGuide([stop({ excerpts: [
      { path: "a.ts", side: "new", start: 10, end: 11, caption: "" },
      { path: "a.ts", side: "new", start: 12, end: 14, caption: "second" },
    ] })], change([a]));
    expect(first!.excerpts).toEqual([{ path: "a.ts", side: "new", start: 10, end: 14, caption: "second" }]);
  });

  it("does not merge the two sides of a file", () => {
    const [first] = normalizeGuide([stop({ excerpts: [
      { path: "a.ts", side: "new", start: 10, end: 11, caption: "" },
      { path: "a.ts", side: "old", start: 5, end: 6, caption: "" },
    ] })], change([a]));
    expect(first!.excerpts).toHaveLength(2);
  });

  it("caps an excerpt at 25 lines", () => {
    const big = diff("big.ts", Array.from({ length: 80 }, (_, index) => index + 1));
    const [first] = normalizeGuide([stop({ excerpts: [{ path: "big.ts", side: "new", start: 1, end: 80, caption: "" }] })], change([big]));
    expect(first!.excerpts[0]).toMatchObject({ start: 1, end: 25 });
  });

  it("keeps notes inside an excerpt and drops the rest, at most three", () => {
    const [first] = normalizeGuide([stop({
      excerpts: [{ path: "a.ts", side: "new", start: 10, end: 15, caption: "" }],
      notes: [
        { path: "a.ts", line: 10, title: "one", body: "" }, { path: "a.ts", line: 11, title: "two", body: "" },
        { path: "a.ts", line: 99, title: "outside", body: "" }, { path: "other.ts", line: 10, title: "wrong file", body: "" },
        { path: "a.ts", line: 12, title: "  ", body: "no title" }, { path: "a.ts", line: 13, title: "three", body: "" }, { path: "a.ts", line: 14, title: "four", body: "" },
      ],
    })], change([a]));
    expect(first!.notes.map((note) => note.title)).toEqual(["one", "two", "three"]);
  });

  it("anchors a note against the clamped excerpt, not the submitted one", () => {
    const [first] = normalizeGuide([stop({
      excerpts: [{ path: "a.ts", side: "new", start: 1, end: 12, caption: "" }],
      notes: [{ path: "a.ts", line: 3, title: "before the change", body: "" }],
    })], change([a]));
    expect(first!.notes).toEqual([]);
  });

  it("drops a stop without a title, empty questions and an attention without a note; keeps two questions", () => {
    const result = normalizeGuide([
      stop({ title: "  " }),
      stop({ title: "Real", attention: { kind: "risk", note: "  " }, questions: ["", "Why?", "Really?", "Third?"] }),
    ], change([a]));
    expect(result[0]).toMatchObject({ title: "Real", attention: null, questions: ["Why?", "Really?"] });
  });

  it("lists a file only in the first stop that owns it and never when it is excerpted anywhere", () => {
    const b = diff("b.ts", [1]);
    const c = diff("c.ts", [1]);
    const result = normalizeGuide([
      stop({ title: "One", files: [{ path: "b.ts", note: "n" }, { path: "c.ts" }], excerpts: [{ path: "a.ts", side: "new", start: 10, end: 11, caption: "" }] }),
      stop({ title: "Two", files: [{ path: "b.ts" }], excerpts: [{ path: "c.ts", side: "new", start: 1, end: 1, caption: "" }] }),
    ], change([a, b, c]));
    expect(result[0]!.files).toEqual([{ path: "b.ts", note: "n" }]);
    expect(result[1]!.files).toEqual([]);
  });

  it("ignores files outside the change in a files list", () => {
    const [first] = normalizeGuide([stop({ files: [{ path: "ghost.ts" }, { path: "a.ts" }] })], change([a]));
    expect(first!.files).toEqual([{ path: "a.ts" }]);
  });

  it("appends a skim stop with every changed file the tour forgot, in diff order", () => {
    const result = normalizeGuide([stop({ excerpts: [{ path: "a.ts", side: "new", start: 10, end: 11, caption: "" }] })], change([a, diff("z.ts", [1])], ["logo.png"]));
    expect(result.at(-1)).toMatchObject({ title: "Other files", files: [{ path: "z.ts" }, { path: "logo.png" }], excerpts: [], notes: [] });
  });

  it("puts every file in a skim stop when the tour is empty of useful stops", () => {
    const result = normalizeGuide([], change([a]));
    expect(result).toHaveLength(1);
    expect(result[0]!.files).toEqual([{ path: "a.ts" }]);
  });

  it("adds no skim stop when every file is placed", () => {
    const result = normalizeGuide([stop({ excerpts: [{ path: "a.ts", side: "new", start: 10, end: 11, caption: "" }] })], change([a]));
    expect(result).toHaveLength(1);
  });

  it("keeps at most eight stops of the tour and folds the files of the rest into the skim stop", () => {
    const many = Array.from({ length: 10 }, (_, index) => stop({ title: `Stop ${index}`, excerpts: [{ path: `f${index}.ts`, side: "new", start: 1, end: 1, caption: "" }] }));
    const result = normalizeGuide(many, change(many.map((_, index) => diff(`f${index}.ts`, [1]))));
    expect(result).toHaveLength(9);
    expect(result.at(-1)!.files.map((entry) => entry.path)).toEqual(["f8.ts", "f9.ts"]);
  });

  it("drops the note of a file entry that is only blanks", () => {
    const [first] = normalizeGuide([stop({ files: [{ path: "a.ts", note: "   " }] })], change([a]));
    expect(first!.files).toEqual([{ path: "a.ts" }]);
  });
});
