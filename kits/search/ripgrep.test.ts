import { describe, expect, it } from "vitest";
import { excerpt, parseRipgrepLine, ripgrepArgs, ripgrepError } from "./ripgrep.js";

const match = (data: Record<string, unknown>) => JSON.stringify({ type: "match", data });

describe("ripgrep JSON", () => {
  it("reads a match with its path, line and ranges, without the line break and the indentation", () => {
    const line = match({ path: { text: "./src/a.ts" }, lines: { text: "    const needle = 1;\n" }, line_number: 12, submatches: [{ match: { text: "needle" }, start: 10, end: 16 }] });
    expect(parseRipgrepLine(line)).toEqual({ path: "src/a.ts", line: 12, text: "const needle = 1;", ranges: [[6, 12]] });
  });

  it("turns byte offsets into string offsets on a line with multi-byte characters", () => {
    const line = match({ path: { text: "./utf.txt" }, lines: { text: "héllo needle wörld\n" }, line_number: 1, submatches: [{ start: 7, end: 13 }] });
    const parsed = parseRipgrepLine(line)!;
    expect(parsed.text.slice(parsed.ranges[0]![0], parsed.ranges[0]![1])).toBe("needle");
  });

  it("decodes a path and a line ripgrep had to send as bytes", () => {
    const line = match({ path: { bytes: Buffer.from("./b.txt").toString("base64") }, lines: { bytes: Buffer.from("a needle\n").toString("base64") }, line_number: 3, submatches: [{ start: 2, end: 8 }] });
    expect(parseRipgrepLine(line)).toMatchObject({ path: "b.txt", line: 3, text: "a needle", ranges: [[2, 8]] });
  });

  it("ignores every message that is not a match, and a torn line", () => {
    expect(parseRipgrepLine(JSON.stringify({ type: "begin", data: { path: { text: "./a" } } }))).toBeUndefined();
    expect(parseRipgrepLine('{"type":"match","data":{"path"')).toBeUndefined();
  });

  it("cuts a long line to a window around its first match and keeps the range on the match", () => {
    const long = `${"x".repeat(3000)}needle${"y".repeat(10)}`;
    const cut = excerpt(long, [[3000, 3006]], 100);
    expect(cut.text.startsWith("…")).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(102);
    expect(cut.text.slice(cut.ranges[0]![0], cut.ranges[0]![1])).toBe("needle");
  });

  it("searches literally, case-insensitively and hidden files unless told otherwise, never inside .git", () => {
    expect(ripgrepArgs({ query: "-a(b" })).toEqual(expect.arrayContaining(["--fixed-strings", "--ignore-case", "--hidden", "!.git/"]));
    expect(ripgrepArgs({ query: "-a(b" }).slice(-4)).toEqual(["--regexp", "-a(b", "--", "."]);
    const strict = ripgrepArgs({ query: "a.b", regex: true, caseSensitive: true, wholeWord: true });
    expect(strict).toEqual(expect.arrayContaining(["--case-sensitive", "--word-regexp"]));
    expect(strict).not.toContain("--fixed-strings");
  });

  it("names what is wrong with a regular expression", () => {
    expect(ripgrepError("rg: regex parse error:\n    (?:()\n    ^\nerror: unclosed group\n")).toBe("Not a valid regular expression: unclosed group");
  });
});
