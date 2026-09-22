import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contentPattern, isIgnored, parseGitignore, searchWalkedFiles, walkProject } from "./walker.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function project(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tau-search-walker-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

describe("gitignore rules", () => {
  const rules = parseGitignore([
    "# build output",
    "dist/",
    "*.log",
    "!keep.log",
    "/root-only.txt",
    "docs/**/*.tmp",
    "\\#literal",
  ].join("\n"));

  it("ignores a name at any depth, a folder only as a folder, and takes a negation back", () => {
    expect(isIgnored(rules, "a/b/error.log", false)).toBe(true);
    expect(isIgnored(rules, "a/keep.log", false)).toBe(false);
    expect(isIgnored(rules, "pkg/dist", true)).toBe(true);
    expect(isIgnored(rules, "pkg/dist", false)).toBe(false);
  });

  it("anchors a pattern with a slash to its own folder", () => {
    expect(isIgnored(rules, "root-only.txt", false)).toBe(true);
    expect(isIgnored(rules, "sub/root-only.txt", false)).toBe(false);
    expect(isIgnored(rules, "docs/a/b/x.tmp", false)).toBe(true);
    expect(isIgnored(rules, "docs/x.tmp", false)).toBe(true);
    expect(isIgnored(rules, "other/x.tmp", false)).toBe(false);
    expect(isIgnored(rules, "#literal", false)).toBe(true);
  });

  it("reads a nested .gitignore below its own folder only", () => {
    const nested = [...parseGitignore("*.gen.ts"), ...parseGitignore("!keep.gen.ts\nlocal", "pkg")];
    expect(isIgnored(nested, "pkg/keep.gen.ts", false)).toBe(false);
    expect(isIgnored(nested, "other/keep.gen.ts", false)).toBe(true);
    expect(isIgnored(nested, "pkg/sub/local", true)).toBe(true);
    expect(isIgnored(nested, "local", true)).toBe(false);
  });
});

describe("walker", () => {
  it("lists the files every .gitignore on the way lets through, never .git", async () => {
    const root = await project({
      ".gitignore": "node_modules/\n*.log\n",
      ".git/HEAD": "ref: main",
      ".env.example": "A=1",
      "src/a.ts": "export const needle = 1;",
      "src/debug.log": "needle",
      "node_modules/x/index.js": "needle",
      "pkg/.gitignore": "generated/\n",
      "pkg/generated/out.ts": "needle",
      "pkg/index.ts": "  // no NEEDLE here? yes: Needle",
    });
    const { files, truncated } = await walkProject(root);
    expect(truncated).toBe(false);
    expect(files.sort()).toEqual([".env.example", ".gitignore", "pkg/.gitignore", "pkg/index.ts", "src/a.ts"]);
    expect((await walkProject(root, { limit: 2 })).truncated).toBe(true);
  });

  it("finds a literal query case-insensitively with ranges on the trimmed line, and skips binary files", async () => {
    const root = await project({
      "a.ts": "export const needle = 1;\nno match\n",
      "b.ts": "  // Needle and needle",
      "c.bin": Buffer.from([110, 101, 101, 100, 108, 101, 0, 1]),
    });
    const { matches } = await searchWalkedFiles(root, ["a.ts", "b.ts", "c.bin"], contentPattern({ query: "needle" }));
    expect(matches).toEqual([
      { path: "a.ts", line: 1, text: "export const needle = 1;", ranges: [[13, 19]] },
      { path: "b.ts", line: 1, text: "// Needle and needle", ranges: [[3, 9], [14, 20]] },
    ]);
    const strict = await searchWalkedFiles(root, ["b.ts"], contentPattern({ query: "Needle", caseSensitive: true }));
    expect(strict.matches[0]!.ranges).toEqual([[3, 9]]);
  });

  it("stops at the limit and when the caller cancels", async () => {
    const root = await project({ "a.txt": "x\nx\nx\n", "b.txt": "x\n" });
    expect(await searchWalkedFiles(root, ["a.txt", "b.txt"], contentPattern({ query: "x" }), { limit: 2 })).toMatchObject({ truncated: true, matches: [{ line: 1 }, { line: 2 }] });
    expect(await searchWalkedFiles(root, ["a.txt"], contentPattern({ query: "x" }), { cancelled: () => true })).toEqual({ matches: [], truncated: true });
  });

  it("matches whole words and regular expressions, and refuses one JavaScript cannot read", () => {
    expect("a needles needle".match(contentPattern({ query: "needle", wholeWord: true }))).toEqual(["needle"]);
    expect("x1 x22".match(contentPattern({ query: "x\\d+", regex: true }))).toEqual(["x1", "x22"]);
    expect(() => contentPattern({ query: "(", regex: true })).toThrow();
    expect("a(b".match(contentPattern({ query: "a(b" }))).toEqual(["a(b"]);
  });
});
