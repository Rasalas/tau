import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { namesContentsOnly, parseCheckIgnore, SyncIgnore } from "./ignore";

describe("namesContentsOnly", () => {
  it("tells a folder's contents from the folder", () => {
    expect(namesContentsOnly("cache/*")).toBe(true);
    expect(namesContentsOnly("/a/logs/**")).toBe(true);
    expect(namesContentsOnly("uploads/")).toBe(false);
    expect(namesContentsOnly("*")).toBe(false);
    expect(namesContentsOnly("*.log")).toBe(false);
  });
});

describe("parseCheckIgnore", () => {
  it("reads four NUL fields per match", () => {
    expect(parseCheckIgnore(Buffer.from(".gitignore\x001\x00uploads/\x00uploads/a b\x00.gitignore\x003\x00!keep\x00keep\x00"))).toEqual([
      { pattern: "uploads/", path: "uploads/a b" },
      { pattern: "!keep", path: "keep" },
    ]);
  });
});

describe("SyncIgnore", () => {
  let repo: string;
  let plain: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "tau-ignore-"));
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, ".gitignore"), "uploads/\ncache/*\n!cache/keep\n*.log\n!keep.log\n");
    mkdirSync(join(repo, "site"));
    writeFileSync(join(repo, "site", ".gitignore"), "local-only.php\n");
    writeFileSync(join(repo, "ignore-list"), "# from ignoreFile\nnode_modules\n");
    plain = mkdtempSync(join(tmpdir(), "tau-ignore-plain-"));
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  });

  it("prunes folders Git, sftp.json or .git leave out, but not a folder whose contents alone are ignored", async () => {
    const ignore = await SyncIgnore.create({ localDir: repo, patterns: [".vscode", "/secret"], ignoreFile: "ignore-list", projectDir: repo });
    expect(ignore.gitRules).toBe(true);
    const dirs = await ignore.dirs(["uploads", "cache", "src", ".vscode", "a/.git", "node_modules", "secret", "sub/secret"]);
    expect([...dirs].sort()).toEqual([".vscode", "a/.git", "node_modules", "secret", "uploads"]);
  });

  it("ignores files as Git does, re-includes and all, and through their folders when asked", async () => {
    const ignore = await SyncIgnore.create({ localDir: repo, patterns: [".vscode"], exclude: ["big"] });
    const files = await ignore.files(["cache/a", "cache/keep", "x.log", "keep.log", "index.php", "uploads/2024/a.jpg", "big/file", "sub/.git/config"]);
    expect([...files].sort()).toEqual(["big/file", "cache/a", "sub/.git/config", "uploads/2024/a.jpg", "x.log"]);
    const deep = await ignore.files([".vscode/settings.json", "src/.vscode/x"], { ancestors: true });
    expect([...deep].sort()).toEqual([".vscode/settings.json", "src/.vscode/x"]);
    expect([...(await ignore.files([".vscode/settings.json"]))]).toEqual([]);
  });

  it("maps a target's context folder onto the repository, even before the folder exists", async () => {
    const site = await SyncIgnore.create({ localDir: join(repo, "site") });
    expect([...(await site.files(["local-only.php", "index.php", "a.log"]))].sort()).toEqual(["a.log", "local-only.php"]);
    const fresh = await SyncIgnore.create({ localDir: join(repo, "not", "yet") });
    expect(fresh.gitRules).toBe(true);
    expect([...(await fresh.dirs(["uploads", "src"]))]).toEqual(["uploads"]);
  });

  it("works outside a repository with sftp.json rules and .git only", async () => {
    const ignore = await SyncIgnore.create({ localDir: plain, patterns: ["*.tmp"] });
    expect(ignore.gitRules).toBe(false);
    expect([...(await ignore.files(["a.tmp", "uploads/a.jpg", ".git/HEAD"]))].sort()).toEqual([".git/HEAD", "a.tmp"]);
  });
});
