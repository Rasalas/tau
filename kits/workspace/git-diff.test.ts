import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getFileDiff } from "./workspace-git.js";
import { MAX_DIFF_BYTES, MAX_DIFF_HUNKS, parseUnifiedDiff } from "./git-diff.js";

// The host's global and system Git config (LFS filters, credential helpers)
// would otherwise be read by every fixture process here.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

describe("large diff bounds", () => {
  it("pages hunks and marks the bounded payload", () => {
    const patch = Array.from({ length: MAX_DIFF_HUNKS + 8 }, (_, index) =>
      `@@ -${index + 1},1 +${index + 1},1 @@ generated\n+line ${index}\n`,
    ).join("");
    const first = parseUnifiedDiff("generated.txt", patch, { hunkLimit: 40 });
    expect(first.hunks).toHaveLength(40);
    expect(first.truncated).toBe(true);
    expect(first.nextHunkOffset).toBe(40);
    const second = parseUnifiedDiff("generated.txt", patch, { hunkOffset: first.nextHunkOffset, hunkLimit: 40 });
    expect(second.hunks[0]?.header).toContain("-41");
  });

  it("stops offering paging when the host byte limit is terminal", () => {
    const patch = `@@ -1,1 +1,1 @@ large\n+${"x".repeat(MAX_DIFF_BYTES + 100)}\n`;
    const result = parseUnifiedDiff("large.txt", patch, { hunkLimit: 1 });
    expect(result.truncated).toBe(true);
    expect(result.nextHunkOffset).toBeUndefined();
    expect(result.note).toContain("byte or line limit");
  });

  it("streams and pages hunks from git without retaining the complete patch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-diff-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
      const before = Array.from({ length: 80 }, (_, index) => `line ${index}`);
      await writeFile(join(cwd, "large.txt"), `${before.join("\n")}\n`);
      execFileSync("git", ["add", "large.txt"], { cwd });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
      const after = before.map((line, index) => index % 10 === 0 ? `${line} changed` : line);
      await writeFile(join(cwd, "large.txt"), `${after.join("\n")}\n`);

      const first = await getFileDiff(cwd, "large.txt", { hunkLimit: 2 });
      expect(first.hunks).toHaveLength(2);
      expect(first.nextHunkOffset).toBe(2);
      const second = await getFileDiff(cwd, "large.txt", { hunkOffset: first.nextHunkOffset, hunkLimit: 2 });
      expect(second.hunks).toHaveLength(2);
      expect(second.hunks[0]?.header).not.toBe(first.hunks[0]?.header);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps context bounded by default and expands it only when requested", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-diff-context-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
      const before = Array.from({ length: 30 }, (_, index) => `line ${index}`);
      await writeFile(join(cwd, "context.txt"), `${before.join("\n")}\n`);
      execFileSync("git", ["add", "context.txt"], { cwd });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
      const after = before.map((line, index) => index === 15 ? `${line} changed` : line);
      await writeFile(join(cwd, "context.txt"), `${after.join("\n")}\n`);

      const collapsed = await getFileDiff(cwd, "context.txt");
      const expanded = await getFileDiff(cwd, "context.txt", { contextLines: 100_000 });
      expect(collapsed.hunks[0]?.lines.length).toBeLessThan(expanded.hunks[0]?.lines.length ?? 0);
      expect(expanded.hunks[0]?.lines.some((line) => line.text === "line 0")).toBe(true);
      expect(expanded.hunks[0]?.lines.some((line) => line.text === "line 29")).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("leaves out whitespace-only changes on request, and still diffs an untracked file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tau-diff-whitespace-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
      execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
      await writeFile(join(cwd, "spaces.txt"), "if (a) {\n  run();\n}\n");
      await writeFile(join(cwd, "mixed.txt"), "one\ntwo\n");
      execFileSync("git", ["add", "."], { cwd });
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
      await writeFile(join(cwd, "spaces.txt"), "if (a) {\n    run();\n}\n");
      await writeFile(join(cwd, "mixed.txt"), "one \nthree\n");
      await writeFile(join(cwd, "new.txt"), "fresh\n");

      expect((await getFileDiff(cwd, "spaces.txt")).hunks).toHaveLength(1);
      await expect(getFileDiff(cwd, "spaces.txt", { ignoreWhitespace: true })).resolves.toMatchObject({ hunks: [], note: "Only whitespace changed." });
      const mixed = await getFileDiff(cwd, "mixed.txt", { ignoreWhitespace: true });
      expect(mixed.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind !== "context").map((line) => line.text)).toEqual(["two", "three"]);
      expect((await getFileDiff(cwd, "new.txt", { ignoreWhitespace: true })).hunks[0]?.lines).toEqual([expect.objectContaining({ kind: "added", text: "fresh" })]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

/**
 * Every test here spawns real `git` processes several times over — a snapshot is
 * an `add`/`commit`/`write-tree` triple — and the vitest pool runs four files at
 * once. Isolated the suite needs about a minute; under the full suite's own load
 * the same tests have taken four times that, which is what the 90 s budget below
 * is for. A shorter one turns ordinary load into a red CI run. The per-test
 * numbers are deliberately uniform: they say "this suite is expensive", not
 * "this one test is expensive".
 */
