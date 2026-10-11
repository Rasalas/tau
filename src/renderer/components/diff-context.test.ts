import { describe, expect, it } from "vitest";
import type { UiDiffLine, UiFileDiff } from "../../shared/workspace-kit-types";
import { diffGaps, expandDiffContext, FILE_END, splitFileText, stepRange } from "./diff-context";

const ctx = (oldLine: number, newLine: number): UiDiffLine => ({ kind: "context", oldLine, newLine, text: `line ${newLine}` });

/** A 30-line file: line 5 replaced, a line added after 6, and line 20 removed. */
const file = Array.from({ length: 31 }, (_unused, index) => `line ${index + 1}`);
const diff: UiFileDiff = {
  path: "a.ts",
  added: 2,
  removed: 2,
  hunks: [
    { header: "@@ -4,4 +4,5 @@", lines: [ctx(4, 4), { kind: "removed", oldLine: 5, text: "old 5" }, { kind: "added", newLine: 5, text: "line 5" }, ctx(6, 6), { kind: "added", newLine: 7, text: "line 7" }] },
    { header: "@@ -19,3 +19,2 @@", lines: [ctx(18, 19), { kind: "removed", oldLine: 19, text: "gone" }, ctx(20, 20)] },
  ],
};

describe("diffGaps", () => {
  it("names the stretches a diff leaves out, with the file's length known or not", () => {
    expect(diffGaps(diff).map(({ index, where, unchanged, from, to }) => [index, where, unchanged, from, to])).toEqual([[0, "start", 3, 1, 3], [1, "between", 11, 8, 18]]);
    expect(diffGaps(diff, 31).at(-1)).toMatchObject({ index: 2, where: "end", unchanged: 11, from: 21, to: 31 });
    expect(diffGaps(diff, "unknown").at(-1)).toMatchObject({ where: "end", from: 21, to: FILE_END });
    expect(diffGaps(diff, 20).at(-1)?.where).toBe("between");
  });

  it("counts a hunk that only removes lines on the old side", () => {
    const removal: UiFileDiff = { path: "b.ts", added: 0, removed: 1, hunks: [{ header: "@@ -9 +8,0 @@", lines: [{ kind: "removed", oldLine: 9, text: "x" }] }, { header: "@@", lines: [{ kind: "added", newLine: 20, text: "y" }] }] };
    expect(diffGaps(removal).map(({ unchanged, from, to }) => [unchanged, from, to])).toEqual([[8, 1, 8], [11, 9, 19]]);
  });

  it("leaves out the end of a truncated diff", () => {
    expect(diffGaps({ ...diff, truncated: true }, 31).some((gap) => gap.where === "end")).toBe(false);
  });
});

describe("stepRange", () => {
  const [, between] = diffGaps(diff);
  it("reveals from the change above, from the change below, or everything", () => {
    expect(stepRange(between!, "down", 4)).toEqual({ from: 8, to: 11 });
    expect(stepRange(between!, "up", 4)).toEqual({ from: 15, to: 18 });
    expect(stepRange(between!, "all")).toEqual({ from: 8, to: 18 });
    expect(stepRange(between!, "down", 99)).toEqual({ from: 8, to: 18 });
  });
});

describe("expandDiffContext", () => {
  it("joins a revealed stretch to the hunk above and keeps the old numbers in step", () => {
    const next = expandDiffContext(diff, file, [{ from: 8, to: 9 }]);
    expect(next.hunks).toHaveLength(2);
    expect(next.hunks[0]!.lines.slice(-2)).toEqual([
      { kind: "context", oldLine: 7, newLine: 8, text: "line 8", expanded: true },
      { kind: "context", oldLine: 8, newLine: 9, text: "line 9", expanded: true },
    ]);
    expect(next.hunks[0]!.header).toBe("@@ -4,5 +4,6 @@");
    expect(next.hunks[1]).toEqual(diff.hunks[1]);
    expect(diffGaps(next)[1]).toMatchObject({ from: 10, to: 18, unchanged: 9 });
  });

  it("joins a stretch to the hunk below, and leaves a floating one as a hunk of its own", () => {
    const below = expandDiffContext(diff, file, [{ from: 17, to: 18 }]);
    expect(below.hunks[1]!.lines.slice(0, 3).map((line) => line.newLine)).toEqual([17, 18, 19]);
    expect(below.hunks[1]!.lines[0]).toMatchObject({ oldLine: 16, expanded: true });
    const floating = expandDiffContext(diff, file, [{ from: 12, to: 13 }]);
    expect(floating.hunks).toHaveLength(3);
    expect(floating.hunks[1]!.lines.map((line) => line.newLine)).toEqual([12, 13]);
  });

  it("merges two hunks when the whole gap is revealed, and orders any ranges", () => {
    const merged = expandDiffContext(diff, file, [{ from: 12, to: 18 }, { from: 8, to: 11 }, { from: 1, to: 3 }]);
    expect(merged.hunks).toHaveLength(1);
    const numbers = merged.hunks[0]!.lines.filter((line) => line.newLine !== undefined).map((line) => line.newLine);
    expect(numbers).toEqual(Array.from({ length: 20 }, (_unused, index) => index + 1));
    expect(merged.hunks[0]!.lines.filter((line) => line.expanded)).toHaveLength(14);
    expect(diffGaps(merged)).toEqual([]);
  });

  it("reveals the lines after the last hunk and clamps to the file's end", () => {
    const next = expandDiffContext(diff, file, [{ from: 21, to: 9999 }]);
    expect(next.hunks.at(-1)!.lines.at(-1)).toMatchObject({ newLine: 31, oldLine: 31, expanded: true });
    expect(diffGaps(next, 31)).toHaveLength(2);
  });

  it("changes nothing without a range, and does not touch the diff it was given", () => {
    expect(expandDiffContext(diff, file, [])).toBe(diff);
    const before = JSON.stringify(diff);
    expandDiffContext(diff, file, [{ from: 1, to: 31 }]);
    expect(JSON.stringify(diff)).toBe(before);
  });
});

describe("splitFileText", () => {
  it("drops the empty line after the last newline and keeps a file without one", () => {
    expect(splitFileText("a\nb\n")).toEqual(["a", "b"]);
    expect(splitFileText("a\nb")).toEqual(["a", "b"]);
    expect(splitFileText("")).toEqual([]);
  });
});
