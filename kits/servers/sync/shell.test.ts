import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HASH_SCRIPT, LIST_SCRIPT, parseHashes, parseListing, pathList } from "./shell";

const posix = process.platform !== "win32";

describe("parseListing", () => {
  it("reads GNU find's NUL records", () => {
    const output = Buffer.from("tau-list gnu\nf 644 5 1700000000.5 a b.txt\0d 755 4096 1700000001.0 dir\0l 777 5 1700000002.0 link\0f 600 1 1700000003.0 new\nline\0");
    expect(parseListing(output)).toEqual([
      { type: "file", mode: 0o644, size: 5, mtime: 1_700_000_000, path: "a b.txt" },
      { type: "directory", mode: 0o755, size: 4096, mtime: 1_700_000_001, path: "dir" },
      { type: "symlink", mode: 0o777, size: 5, mtime: 1_700_000_002, path: "link" },
      { type: "file", mode: 0o600, size: 1, mtime: 1_700_000_003, path: "new\nline" },
    ]);
  });

  it("reads stat -c and BSD stat -f lines, a name with a newline included", () => {
    expect(parseListing(Buffer.from("tau-list statc\n81a4 5 1700000000 ./a.txt\n41ed 64 1700000001 ./dir\n81ed 1 1700000002 ./new\nline\n"))).toEqual([
      { type: "file", mode: 0o644, size: 5, mtime: 1_700_000_000, path: "a.txt" },
      { type: "directory", mode: 0o755, size: 64, mtime: 1_700_000_001, path: "dir" },
      { type: "file", mode: 0o755, size: 1, mtime: 1_700_000_002, path: "new\nline" },
    ]);
    expect(parseListing(Buffer.from("tau-list bsd\n10 644 5 1700000000 ./a.txt\n4 755 64 1700000001 ./dir\n12 755 5 1700000002 ./link\n"))).toEqual([
      { type: "file", mode: 0o644, size: 5, mtime: 1_700_000_000, path: "a.txt" },
      { type: "directory", mode: 0o755, size: 64, mtime: 1_700_000_001, path: "dir" },
      { type: "symlink", mode: 0o755, size: 5, mtime: 1_700_000_002, path: "link" },
    ]);
  });

  it("knows no listing without its header", () => {
    expect(parseListing(Buffer.from("sh: find: not found\n"))).toBeUndefined();
  });
});

describe("parseHashes", () => {
  it("reads plain and escaped names", () => {
    const hash = "a".repeat(64);
    expect([...parseHashes(`${hash}  ./a.txt\n\\${hash}  ./new\\nline\\\\x\n${hash} *./bin\n`)]).toEqual([["a.txt", hash], ["new\nline\\x", hash], ["bin", hash]]);
  });
});

describe.skipIf(!posix)("the scripts on this machine's shell", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tau-shell-"));
    mkdirSync(join(dir, "sub", ".git"), { recursive: true });
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config"), "x");
    writeFileSync(join(dir, "sub", ".git", "HEAD"), "x");
    writeFileSync(join(dir, "sub", "a.php"), "<?php\n");
    writeFileSync(join(dir, "-rf"), "dash");
    writeFileSync(join(dir, "space name.txt"), "s");
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync("/etc", join(dir, "etc-link"));
    utimesSync(join(dir, "sub", "a.php"), 1_700_000_000, 1_700_000_000);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("lists everything but .git, with sizes, modes and mtimes", () => {
    const run = spawnSync("/bin/sh", ["-c", LIST_SCRIPT], { cwd: dir });
    expect(run.status).toBe(0);
    const entries = parseListing(run.stdout)!;
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    expect([...byPath.keys()].sort()).toEqual(["-rf", "etc-link", "run.sh", "space name.txt", "sub", "sub/a.php"]);
    expect(byPath.get("sub/a.php")).toMatchObject({ type: "file", size: 6, mtime: 1_700_000_000 });
    expect(byPath.get("sub")!.type).toBe("directory");
    expect(byPath.get("etc-link")!.type).toBe("symlink");
    expect(byPath.get("run.sh")!.mode & 0o111).not.toBe(0);
  });

  it("hashes the listed files, a dash-name as a file", () => {
    const run = spawnSync("/bin/sh", ["-c", HASH_SCRIPT], { cwd: dir, input: pathList(["-rf", "space name.txt", "missing"]) });
    const hashes = parseHashes(run.stdout.toString());
    expect(hashes.get("-rf")).toBe(createHash("sha256").update("dash").digest("hex"));
    expect(hashes.get("space name.txt")).toBe(createHash("sha256").update("s").digest("hex"));
    expect(hashes.has("missing")).toBe(false);
  });
});
