import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitFilesToBranch, decodeBranchFiles, mergeBranch } from "./branch-commit.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const b64 = (text: string) => Buffer.from(text).toString("base64");

function status(cwd: string) {
  return { head: git(cwd, "rev-parse", "HEAD"), porcelain: git(cwd, "--no-optional-locks", "status", "--porcelain"), index: statSync(join(cwd, ".git", "index")).mtimeMs };
}

describe.skipIf(process.platform === "win32")("commit files to a branch", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "tau-branch-commit-"));
    git(repo, "init", "-q", "--initial-branch=main");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.invalid");
    git(repo, "config", "commit.gpgSign", "false");
    writeFileSync(join(repo, "index.php"), "<?php echo 1;\n");
    writeFileSync(join(repo, "old.php"), "old\n");
    writeFileSync(join(repo, "keep.txt"), "keep\n");
    writeFileSync(join(repo, ".gitattributes"), "*.txt text eol=lf\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "start");
    // Local work the branch must not take along or disturb.
    writeFileSync(join(repo, "keep.txt"), "local edit\n");
    writeFileSync(join(repo, "notes.md"), "untracked\n");
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("commits exactly the named changes on a new branch and leaves the checkout alone", async () => {
    const before = status(repo);
    const result = await commitFilesToBranch(repo, {
      branch: "server-drift/2026-09-25",
      message: "Server drift",
      unique: true,
      files: [{ path: "index.php", content: b64("<?php echo 2;\n") }, { path: "old.php", delete: true }, { path: "bin/run.sh", content: b64("#!/bin/sh\n"), executable: true }],
    });
    expect(result.branch).toBe("server-drift/2026-09-25");
    expect(result.parent).toBe(before.head);
    expect(result.changed.sort()).toEqual(["bin/run.sh", "index.php", "old.php"]);
    expect(git(repo, "rev-parse", `${result.commit}^`)).toBe(before.head);
    expect(git(repo, "diff-tree", "-r", "--name-status", "--no-commit-id", result.commit!)).toBe("A\tbin/run.sh\nM\tindex.php\nD\told.php");
    expect(git(repo, "ls-tree", result.commit!, "bin/run.sh")).toMatch(/^100755 /u);
    expect(git(repo, "show", `${result.commit}:index.php`)).toBe("<?php echo 2;");
    expect(status(repo)).toEqual(before);
    expect(readFileSync(join(repo, "keep.txt"), "utf8")).toBe("local edit\n");
    expect(readFileSync(join(repo, "index.php"), "utf8")).toBe("<?php echo 1;\n");
    expect(existsSync(join(repo, "old.php"))).toBe(true);
  });

  it("names a second branch of the day -2, and makes none when nothing differs", async () => {
    const files = [{ path: "index.php", content: b64("<?php echo 3;\n") }];
    const first = await commitFilesToBranch(repo, { branch: "server-drift/2026-09-25", message: "one", files, unique: true });
    const second = await commitFilesToBranch(repo, { branch: "server-drift/2026-09-25", message: "two", files, unique: true });
    expect(first.branch).toBe("server-drift/2026-09-25");
    expect(second.branch).toBe("server-drift/2026-09-25-2");
    await expect(commitFilesToBranch(repo, { branch: "server-drift/2026-09-25", message: "x", files })).rejects.toThrow(/already exists/u);
    const same = await commitFilesToBranch(repo, { branch: "noop", message: "x", files: [{ path: "index.php", content: b64("<?php echo 1;\n") }] });
    expect(same.commit).toBeUndefined();
    expect(same.changed).toEqual([]);
    expect(git(repo, "branch", "--list", "noop")).toBe("");
  });

  it("applies the project's attributes as git add would", async () => {
    const result = await commitFilesToBranch(repo, { branch: "eol", message: "x", files: [{ path: "keep.txt", content: b64("a\r\nb\r\n") }] });
    expect(git(repo, "cat-file", "-p", `${result.commit}:keep.txt`)).toBe("a\nb");
  });

  it("merges with a merge commit on a click, and backs a conflict out", async () => {
    git(repo, "checkout", "-q", "--", "keep.txt");
    const drift = await commitFilesToBranch(repo, { branch: "server-drift/2026-09-25", message: "drift", files: [{ path: "index.php", content: b64("<?php echo 2;\n") }, { path: "old.php", delete: true }] });
    const merged = await mergeBranch(repo, drift.branch!);
    expect(merged).toMatchObject({ alreadyMerged: false, into: "main" });
    expect(git(repo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    expect(git(repo, "log", "-1", "--format=%s")).toBe("Merge branch 'server-drift/2026-09-25'");
    expect(readFileSync(join(repo, "index.php"), "utf8")).toBe("<?php echo 2;\n");
    expect(existsSync(join(repo, "old.php"))).toBe(false);
    expect(await mergeBranch(repo, drift.branch!)).toMatchObject({ alreadyMerged: true });

    const clash = await commitFilesToBranch(repo, { branch: "clash", message: "server", files: [{ path: "index.php", content: b64("<?php echo 'server';\n") }] });
    writeFileSync(join(repo, "index.php"), "<?php echo 'local';\n");
    git(repo, "commit", "-q", "-am", "local");
    const head = git(repo, "rev-parse", "HEAD");
    await expect(mergeBranch(repo, clash.branch!)).rejects.toThrow(/conflicts in index\.php; nothing was changed/u);
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(git(repo, "status", "--porcelain")).toBe("?? notes.md");
    await expect(mergeBranch(repo, "gone")).rejects.toThrow(/gone/u);
  });

  it("refuses paths outside the repository and .git", () => {
    expect(() => decodeBranchFiles([{ path: "../x", content: "" }])).toThrow();
    expect(() => decodeBranchFiles([{ path: "/etc/hosts", content: "" }])).toThrow();
    expect(() => decodeBranchFiles([{ path: "a/.GIT/config", content: "" }])).toThrow();
    expect(() => decodeBranchFiles([{ path: "./a", content: "" }])).toThrow();
    expect(() => decodeBranchFiles([{ path: "a", content: "" }, { path: "a", delete: true }])).toThrow(/twice/u);
    expect(() => decodeBranchFiles([])).toThrow();
    expect(decodeBranchFiles([{ path: "a", delete: true }, { path: "b", content: "eA==" }])).toEqual([{ path: "a", delete: true }, { path: "b", content: "eA==", executable: false }]);
  });
});
