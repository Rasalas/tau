import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServersStore } from "../store";
import { blobId, entryOf, loadMirrorState, Mirror, MIRROR_INDEX_FILE, MIRROR_REF, saveMirrorState, type MirrorEntry } from "./mirror";

const logger = { warn: () => undefined };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Every file below a folder with its size and mtime: what "left untouched" means. */
function fingerprint(dir: string): string {
  return (readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[]).sort().map((name) => {
    const info = statSync(join(dir, name));
    return `${name}:${info.size}:${info.mtimeMs}`;
  }).join("\n");
}

describe("the mirror state", () => {
  let dir: string;
  let store: ServersStore;
  const key = { workspaceId: "ws1", targetId: "sftp-site-12345678" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tau-mirror-"));
    store = new ServersStore(join(dir, "state"), logger);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function record(mirror: Mirror, files: Record<string, string>, message = "read") {
    const entries = new Map<string, MirrorEntry>();
    for (const [path, content] of Object.entries(files)) {
      const data = Buffer.from(content);
      await mirror.ensure();
      await mirror.writeBlob(data);
      entries.set(path, entryOf(data, { mtime: 1_700_000_000, mode: path.endsWith(".sh") ? 0o755 : 0o644 }));
    }
    return saveMirrorState(store, key, mirror, entries, message);
  }

  it("keeps a commit on refs/tau/server in a bare repository in the state folder, with index.json beside it", async () => {
    const mirror = new Mirror(store.mirrorDir(key));
    const state = await record(mirror, { "index.php": "<?php echo 1;", "a b/c.txt": "c", "run.sh": "#!/bin/sh", "new\nline": "n" });
    const repo = store.mirrorDir(key);
    expect(git(repo, "rev-parse", "--is-bare-repository")).toBe("true");
    expect(git(repo, "rev-parse", MIRROR_REF)).toBe(state.commit);
    expect(git(repo, "fsck", "--strict", "--no-dangling")).toBe("");
    expect(git(repo, "cat-file", "-p", `${MIRROR_REF}:a b/c.txt`)).toBe("c");
    expect(git(repo, "ls-tree", MIRROR_REF, "run.sh")).toMatch(/^100755 blob/u);
    expect([...(await mirror.files())].sort()).toEqual([...state.entries].map(([path, entry]) => [path, entry.oid]).sort());
    expect(existsSync(join(repo, "objects", "info", "alternates"))).toBe(false);
    const index = await store.read(key, MIRROR_INDEX_FILE);
    expect(index?.commit).toBe(state.commit);
    expect(statSync(join(store.targetDir(key), "index.json")).mode & 0o777).toBe(0o600);
    // A second state has the first as parent.
    const next = await record(mirror, { "index.php": "<?php echo 2;" });
    expect(git(repo, "rev-parse", `${next.commit}^`)).toBe(state.commit);
    expect((await loadMirrorState(store, key, mirror))?.entries.size).toBe(1);
  });

  it("writes nothing into the project, not even an object's mtime, and reads the project's blobs when asked", async () => {
    const project = join(dir, "project");
    execFileSync("git", ["init", "-q", project]);
    // A commit may start Git's background maintenance, whose lock file would change the fingerprint under the test.
    git(project, "config", "maintenance.auto", "false");
    git(project, "config", "gc.auto", "0");
    writeFileSync(join(project, "shared.php"), "same content on both sides");
    writeFileSync(join(project, "only-here.txt"), "the project has this one");
    git(project, "add", ".");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: project });
    const before = fingerprint(join(project, ".git"));
    const mirror = new Mirror(store.mirrorDir(key), { projectObjects: join(project, ".git", "objects") });
    await record(mirror, { "shared.php": "same content on both sides" });
    expect(fingerprint(join(project, ".git"))).toBe(before);
    // The shared blob lives in the mirror itself: a gc in the project cannot take it.
    const shared = blobId(Buffer.from("same content on both sides"));
    expect(existsSync(join(store.mirrorDir(key), "objects", shared.slice(0, 2), shared.slice(2)))).toBe(true);
    const onlyHere = git(project, "rev-parse", "HEAD:only-here.txt");
    expect((await mirror.readBlob(onlyHere)).toString()).toBe("the project has this one");
    expect(fingerprint(join(project, ".git"))).toBe(before);
  });

  it("sets the ref to index.json after a crash between the two, and has no state without an index", async () => {
    const mirror = new Mirror(store.mirrorDir(key));
    expect(await loadMirrorState(store, key, mirror)).toBeUndefined();
    const first = await record(mirror, { "a.txt": "1" });
    const second = await record(mirror, { "a.txt": "2" });
    // As if the process ended after writing index.json and before moving the ref.
    git(store.mirrorDir(key), "update-ref", MIRROR_REF, first.commit);
    const loaded = await loadMirrorState(store, key, mirror);
    expect(loaded?.commit).toBe(second.commit);
    expect(git(store.mirrorDir(key), "rev-parse", MIRROR_REF)).toBe(second.commit);
    expect(readFileSync(join(store.targetDir(key), "index.json"), "utf8")).toContain(second.commit);
  });
});
