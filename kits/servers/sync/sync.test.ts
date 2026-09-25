import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FolderServerFs } from "../fixtures/fake-server-fs";
import { ServersStore } from "../store";
import { compareDrift, comparePending, deletedFrom } from "./compare";
import { download } from "./download";
import { SyncIgnore } from "./ignore";
import { loadMirrorState, Mirror, saveMirrorState } from "./mirror";
import { scanLocal, scanServer, summarize } from "./scan";

const logger = { warn: () => undefined };
const posix = process.platform !== "win32";
const key = { workspaceId: "ws1", targetId: "sftp-site-12345678" };
const GITIGNORE = "uploads/\ncache/*\n!cache/keep\n*.log\n";

function put(root: string, path: string, content: string | Buffer, mtime = 1_700_000_000) {
  const file = join(root, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  utimesSync(file, mtime, mtime);
}

interface World {
  dir: string;
  server: string;
  local: string;
  store: ServersStore;
  mirror: Mirror;
}

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), "tau-sync-"));
  const server = join(dir, "server");
  const local = join(dir, "local");
  // The server's own .gitignore is only content; the local one decides.
  put(server, ".gitignore", GITIGNORE);
  put(server, "index.php", "<?php require 'wp-config.php';\n");
  put(server, "wp-config.php", "<?php\ndefine('DB_HOST', 'db.example.invalid');\ndefine('DB_PASSWORD', 'fake-password-not-real');\n");
  put(server, "css/site.css", "body{}\n");
  put(server, "js/app.js", "console.log(1)\n");
  put(server, "uploads/2024/photo.jpg", Buffer.alloc(3000, 1));
  put(server, "cache/page.html", "cached");
  put(server, "cache/keep", "kept by !cache/keep");
  put(server, ".vscode/settings.json", "{}");
  put(server, ".git/config", "[core]\n");
  put(server, "sub/.git/HEAD", "ref: x\n");
  put(server, "error.log", "boom");
  put(server, "bin/run.sh", "#!/bin/sh\n");
  chmodSync(join(server, "bin/run.sh"), 0o755);
  symlinkSync("/etc", join(server, "etc-link"));
  mkdirSync(local);
  execFileSync("git", ["init", "-q", local]);
  put(local, ".gitignore", GITIGNORE);
  const store = new ServersStore(join(dir, "state"), logger);
  return { dir, server, local, store, mirror: new Mirror(store.mirrorDir(key)) };
}

async function pull(w: World, fs: FolderServerFs, options: { overwrite?: boolean; method?: "sftp" } = {}) {
  const ignore = await SyncIgnore.create({ localDir: w.local, patterns: [".vscode"] });
  const listing = await scanServer(fs, ignore, options.method ? { method: options.method } : {});
  const previous = await loadMirrorState(w.store, key, w.mirror);
  const outcome = await download(fs, listing, previous, w.mirror, { localDir: w.local, ...options });
  const state = await saveMirrorState(w.store, key, w.mirror, outcome.entries, "test");
  return { ignore, listing, outcome, state };
}

const SYNCED = [".gitignore", "bin/run.sh", "cache/keep", "css/site.css", "index.php", "js/app.js", "wp-config.php"];

describe.skipIf(!posix).each([
  { name: "with a shell (find, tar, sha256sum)", shell: true },
  { name: "SFTP only", shell: false },
])("download and compare against a fake server $name", ({ shell }) => {
  let w: World;
  let fs: FolderServerFs;

  beforeEach(() => {
    w = world();
    fs = new FolderServerFs(w.server, { shell });
  });

  afterEach(() => rmSync(w.dir, { recursive: true, force: true }));

  it("brings down what is not ignored, never .git, and records the server as the mirror state", async () => {
    const { listing, outcome, state } = await pull(w, fs);
    expect(listing.method).toBe(shell ? "shell" : "sftp");
    expect(outcome.method).toBe(shell ? "tar" : "sftp");
    expect([...state.entries.keys()].sort()).toEqual(SYNCED);
    expect(listing.ignoredFolders).toEqual([".vscode", "uploads"]);
    expect(listing.skipped).toEqual(["etc-link"]);
    for (const path of ["uploads/2024/photo.jpg", "cache/page.html", "error.log", ".vscode/settings.json", "sub/.git/HEAD", "etc-link"]) {
      expect(existsSync(join(w.local, ...path.split("/"))), path).toBe(false);
    }
    expect(readFileSync(join(w.local, ".git", "config"), "utf8")).not.toBe("[core]\n");
    expect(readFileSync(join(w.local, "index.php"), "utf8")).toBe("<?php require 'wp-config.php';\n");
    expect(statSync(join(w.local, "bin/run.sh")).mode & 0o111).not.toBe(0);
    expect(Math.floor(statSync(join(w.local, "css/site.css")).mtimeMs / 1000)).toBe(1_700_000_000);
    // Mirror = server, blob for blob.
    const files = await w.mirror.files();
    for (const path of SYNCED) expect((await w.mirror.readBlob(files.get(path)!)).equals(readFileSync(join(w.server, ...path.split("/")))), path).toBe(true);
    expect(outcome.findings.map((finding) => finding.path)).toEqual(["wp-config.php"]);
    // Nothing of the server's .git was listed, read or streamed.
    expect(fs.calls.filter((call) => /(^|\/)\.git(\/|$)/u.test(call.replace(/^exec .*/su, "")))).toEqual([]);
    expect(summarize("t", listing, true).folders.map((folder) => folder.path)).toEqual(["bin", "cache", "css", "js"]);
  });

  it("reports local additions, edits and deletions as pending, and nothing for a fresh copy", async () => {
    const { ignore, state } = await pull(w, fs);
    const pending = async (options: { thorough?: boolean; blocklist?: string[] } = {}) =>
      comparePending(w.local, await scanLocal(w.local, ignore), state, ignore, options);
    expect((await pending()).rows).toEqual([]);
    writeFileSync(join(w.local, "css/site.css"), "body{color:red}\n");
    put(w.local, "js/app.js", "console.log(2)\n", 1_700_000_500); // same size, new content
    put(w.local, "new.php", "<?php\n");
    put(w.local, "wp-config-local.php", "<?php // override\n");
    put(w.local, "uploads/local.jpg", "ignored");
    unlinkSync(join(w.local, "index.php"));
    const result = await pending({ blocklist: ["wp-config-local.php"] });
    expect(result.rows).toEqual([
      { path: "css/site.css", change: "modified", size: 16 },
      { path: "index.php", change: "deleted" },
      { path: "js/app.js", change: "modified", size: 15 },
      { path: "new.php", change: "added", size: 6 },
    ]);
    expect(result.withheld).toEqual(["wp-config-local.php"]);
    // Touched but unchanged is not pending.
    utimesSync(join(w.local, "bin/run.sh"), 1_800_000_000, 1_800_000_000);
    expect((await pending()).rows.map((row) => row.path)).not.toContain("bin/run.sh");
  });

  it("reports server edits, additions and deletions as drift, a mere touch not, an ignored change not", async () => {
    const { ignore, state } = await pull(w, fs);
    const drift = async (thorough = false) => compareDrift(fs, await scanServer(fs, ignore), state, ignore, { thorough });
    expect(await drift()).toEqual([]);
    put(w.server, "css/site.css", "body{margin:0}\n", 1_700_000_100);
    put(w.server, "js/app.js", "console.log(3)\n", 1_700_000_200); // same size
    utimesSync(join(w.server, "index.php"), 1_700_000_300, 1_700_000_300); // touched only
    put(w.server, "added.php", "<?php\n");
    put(w.server, "uploads/new.jpg", "ignored");
    rmSync(join(w.server, "wp-config.php"));
    const rows = await drift();
    expect(rows.map((row) => [row.path, row.change])).toEqual([
      ["added.php", "added"], ["css/site.css", "modified"], ["js/app.js", "modified"], ["wp-config.php", "deleted"],
      ...(shell ? [] : [["index.php", "modified"]]),
    ].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)));
    // Without a shell a touch is only a guess until a thorough run reads the file.
    if (!shell) expect(rows.find((row) => row.path === "index.php")!.certain).toBe(false);
    const thorough = await drift(true);
    expect(thorough.map((row) => row.path)).toEqual(["added.php", "css/site.css", "js/app.js", "wp-config.php"]);
    expect(thorough.every((row) => row.certain)).toBe(true);
  });

  it("downloads again without losing local work, and overwrites only when asked", async () => {
    await pull(w, fs);
    writeFileSync(join(w.local, "css/site.css"), "local edit\n");
    writeFileSync(join(w.local, "wp-config.php"), "<?php // local edit\n");
    unlinkSync(join(w.local, "js/app.js"));
    put(w.server, "index.php", "<?php // v2\n", 1_700_000_900);
    // Deleted on the server: one untouched here, one edited here.
    rmSync(join(w.server, "bin/run.sh"));
    rmSync(join(w.server, "wp-config.php"));
    const ignore = await SyncIgnore.create({ localDir: w.local, patterns: [".vscode"] });
    const listing = await scanServer(fs, ignore);
    const previous = await loadMirrorState(w.store, key, w.mirror);
    const outcome = await download(fs, listing, previous, w.mirror, { localDir: w.local, deletedOnServer: await deletedFrom(listing, previous!, ignore) });
    const state = await saveMirrorState(w.store, key, w.mirror, outcome.entries, "test");
    expect(outcome.kept).toEqual(["css/site.css"]);
    expect(outcome.keptDeleted).toEqual(["js/app.js"]);
    expect(outcome.removed).toEqual(["bin/run.sh"]);
    expect(readFileSync(join(w.local, "css/site.css"), "utf8")).toBe("local edit\n");
    expect(existsSync(join(w.local, "js/app.js"))).toBe(false);
    expect(existsSync(join(w.local, "bin/run.sh"))).toBe(false);
    expect(readFileSync(join(w.local, "wp-config.php"), "utf8")).toBe("<?php // local edit\n");
    expect(readFileSync(join(w.local, "index.php"), "utf8")).toBe("<?php // v2\n");
    const local = await scanLocal(w.local, ignore);
    expect((await comparePending(w.local, local, state, ignore)).rows.map((row) => [row.path, row.change])).toEqual([
      ["css/site.css", "modified"], ["js/app.js", "deleted"], ["wp-config.php", "added"],
    ]);
    put(w.server, "bin/run.sh", "#!/bin/sh\n");
    put(w.server, "wp-config.php", "<?php\n");
    const forced = await pull(w, fs, { overwrite: true });
    expect(forced.outcome.kept).toEqual([]);
    expect(readFileSync(join(w.local, "css/site.css"), "utf8")).toBe("body{}\n");
    expect(existsSync(join(w.local, "js/app.js"))).toBe(true);
  });

  it("never writes through a local folder link", async () => {
    const outside = join(w.dir, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(w.local, "css"));
    const { outcome } = await pull(w, fs);
    expect(outcome.failed.map((entry) => entry.path)).toEqual(["css/site.css"]);
    expect(existsSync(join(outside, "site.css"))).toBe(false);
  });
});

describe.skipIf(!posix)("a folder the server will not list", () => {
  it("is a gap: its mirrored files are neither drift nor dropped from the mirror", async () => {
    const w = world();
    try {
      const fs = new FolderServerFs(w.server);
      await pull(w, fs);
      fs.refuse.add("css");
      const { ignore, listing, state } = await pull(w, fs, { method: "sftp" });
      expect(listing.unreadable).toEqual(["css"]);
      expect(state.entries.has("css/site.css")).toBe(true);
      expect(await compareDrift(fs, await scanServer(fs, ignore, { method: "sftp" }), state, ignore)).toEqual([]);
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });
});
