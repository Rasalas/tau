import { describe, expect, it } from "vitest";
import type { UiFileDiff } from "../../shared/workspace-kit-types";
import { compileQuery, EMPTY_QUERY, findInDiffs, groupByLine, lineId, MAX_MATCHES } from "./diff-find";

const diffs: UiFileDiff[] = [
  { path: "src/a.ts", added: 2, removed: 1, hunks: [
    { header: "", lines: [
      { kind: "context", oldLine: 1, newLine: 1, text: "const keep = 1;" },
      { kind: "removed", oldLine: 2, text: "const oldName = 2;" },
      { kind: "added", newLine: 2, text: "const newName = 2; // oldName" },
    ] },
    { header: "", lines: [{ kind: "added", newLine: 40, text: "names and Name" }] },
  ] },
  { path: "src/b.ts", added: 1, removed: 0, hunks: [{ header: "", lines: [{ kind: "added", newLine: 1, text: "nil : nil" }] }] },
];

const find = (text: string, flags: Partial<typeof EMPTY_QUERY> = {}) => findInDiffs(diffs, { ...EMPTY_QUERY, text, ...flags });
const spans = (text: string, flags: Partial<typeof EMPTY_QUERY> = {}) => find(text, flags).matches.map((match) => `${match.path}:${match.start}-${match.end}`);

describe("findInDiffs", () => {
  it("finds removed, added and unchanged lines in the order they are drawn, every file", () => {
    expect(spans("oldName")).toEqual(["src/a.ts:6-13", "src/a.ts:22-29"]);
    expect(spans("nil")).toEqual(["src/b.ts:0-3", "src/b.ts:6-9"]);
    expect(spans("const")).toHaveLength(3);
  });

  it("honours the case, whole-word and regular-expression switches", () => {
    expect(spans("name")).toHaveLength(5);
    expect(find("Name", { caseSensitive: true }).matches.map((match) => match.start)).toEqual([9, 9, 25, 10]);
    expect(find("name", { wholeWord: true }).matches).toHaveLength(1);
    expect(find("name", { wholeWord: true, caseSensitive: true }).matches).toHaveLength(0);
    expect(find("n[a-z]+e", { regex: true }).matches.length).toBeGreaterThan(3);
  });

  it("says when the pattern does not compile and finds nothing for an empty query", () => {
    expect(find("(", { regex: true })).toEqual({ matches: [], invalid: true });
    expect(compileQuery(EMPTY_QUERY)).toBeUndefined();
    expect(find("").matches).toEqual([]);
  });

  it("skips matches of no width and stops at the cap", () => {
    expect(find("x*", { regex: true }).matches).toEqual([]);
    const long: UiFileDiff = { path: "big.txt", added: 1, removed: 0, hunks: [{ header: "", lines: [{ kind: "added", newLine: 1, text: "a".repeat(MAX_MATCHES + 10) }] }] };
    const result = findInDiffs([long], { ...EMPTY_QUERY, text: "a" });
    expect(result.matches).toHaveLength(MAX_MATCHES);
    expect(result.capped).toBe(true);
  });

  it("identifies a line by its kind and numbers, and groups the hits of one line", () => {
    const line = diffs[0]!.hunks[0]!.lines[2]!;
    expect(lineId("src/a.ts", line)).toBe("added::2:src/a.ts");
    expect(lineId("src/a.ts", diffs[0]!.hunks[0]!.lines[0]!)).toBe("context:1:1:src/a.ts");
    const grouped = groupByLine(find("name").matches);
    expect(grouped.get("added::2:src/a.ts")).toHaveLength(2);
  });
});
