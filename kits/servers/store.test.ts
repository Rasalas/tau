import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServersStore, mainCheckoutOf, ownerWorkspaceId, type TargetFileSpec } from "./store.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

interface Note extends Record<string, unknown> { text: string }
const NOTE: TargetFileSpec<Note> = {
  name: "note.json",
  version: 1,
  decode: (value) => (value && typeof (value as Note).text === "string" ? { text: (value as Note).text } : undefined),
};

const KEY = { workspaceId: "ws1_abcDEF-123_x", targetId: "site" };
const quiet = { warn: () => undefined };
const mode = async (path: string) => (await stat(path)).mode & 0o777;

describe("ServersStore", () => {
  it("keeps a target under targets/<workspaceId>/<targetId>/ in the kit's state folder", async () => {
    const stateDir = await tempDir("tau-servers-state-");
    const store = new ServersStore(stateDir, quiet);
    expect(store.targetDir(KEY)).toBe(join(stateDir, "targets", KEY.workspaceId, KEY.targetId));
    expect(store.mirrorDir(KEY)).toBe(join(stateDir, "targets", KEY.workspaceId, KEY.targetId, "mirror.git"));

    await store.write(KEY, NOTE, { text: "hello" });
    const file = join(store.targetDir(KEY), "note.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, text: "hello" });
    await expect(store.read(KEY, NOTE)).resolves.toEqual({ text: "hello" });
    await expect(store.read({ ...KEY, targetId: "other" }, NOTE)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("writes files only the user may read, in folders only the user may enter", async () => {
    const stateDir = await tempDir("tau-servers-mode-");
    const store = new ServersStore(stateDir, quiet);
    await store.write(KEY, NOTE, { text: "secret-free" });
    expect(await mode(join(store.targetDir(KEY), "note.json"))).toBe(0o600);
    expect(await mode(store.targetDir(KEY))).toBe(0o700);
    expect(await mode(join(stateDir, "targets", KEY.workspaceId))).toBe(0o700);
    expect(await mode(join(stateDir, "targets"))).toBe(0o700);
  });

  it("writes atomically: the last of concurrent writes wins and no temp file stays behind", async () => {
    const stateDir = await tempDir("tau-servers-atomic-");
    const store = new ServersStore(stateDir, quiet);
    await Promise.all(["a", "b", "c"].map((text) => store.write(KEY, NOTE, { text })));
    await expect(store.read(KEY, NOTE)).resolves.toEqual({ text: "c" });
    expect(await readdir(store.targetDir(KEY))).toEqual(["note.json"]);
  });

  it("moves an unreadable file aside instead of losing it", async () => {
    const stateDir = await tempDir("tau-servers-corrupt-");
    const store = new ServersStore(stateDir, quiet);
    await store.write(KEY, NOTE, { text: "x" });
    await writeFile(join(store.targetDir(KEY), "note.json"), "{ not json");
    await expect(store.read(KEY, NOTE)).resolves.toBeUndefined();
    expect((await readdir(store.targetDir(KEY))).some((name) => name.startsWith("note.json.corrupt-"))).toBe(true);
  });

  it("lists a workspace's targets and forgets one with everything in it", async () => {
    const stateDir = await tempDir("tau-servers-list-");
    const store = new ServersStore(stateDir, quiet);
    await expect(store.targets(KEY.workspaceId)).resolves.toEqual([]);
    await store.write({ ...KEY, targetId: "staging" }, NOTE, { text: "s" });
    await store.write(KEY, NOTE, { text: "p" });
    await store.write({ workspaceId: "ws1_other", targetId: "elsewhere" }, NOTE, { text: "o" });
    await expect(store.targets(KEY.workspaceId)).resolves.toEqual(["site", "staging"]);
    await store.remove(KEY);
    await expect(store.targets(KEY.workspaceId)).resolves.toEqual(["staging"]);
    await expect(store.targets("../escape")).resolves.toEqual([]);
  });

  it("refuses ids that would leave the targets folder", async () => {
    const store = new ServersStore("/state", quiet);
    for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", ".hidden", "x".repeat(129)]) {
      expect(() => store.targetDir({ ...KEY, targetId: bad }), bad).toThrow();
      expect(() => store.targetDir({ ...KEY, workspaceId: bad }), bad).toThrow();
    }
    await expect(store.write({ ...KEY, targetId: ".." }, NOTE, { text: "x" })).rejects.toThrow("Not a target id");
  });
});

describe("the workspace a project's targets belong to", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

  it("is the main checkout for the repository and each of its worktrees", async () => {
    const root = await tempDir("tau-servers-git-");
    const main = join(root, "project");
    git(root, "init", "-q", "project");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "worktree", "add", "-q", "-b", "feature", join(root, "feature"));
    expect(await mainCheckoutOf(main)).toBe(main);
    expect(await mainCheckoutOf(join(root, "feature"))).toBe(main);

    const refs = (path: string) => ({ workspaceId: `ws1_${Buffer.from(path).toString("base64url").slice(-24)}` });
    await expect(ownerWorkspaceId(join(root, "feature"), refs)).resolves.toBe(refs(main).workspaceId);
  });

  it("is the folder itself outside Git", async () => {
    const folder = await tempDir("tau-servers-plain-");
    await expect(mainCheckoutOf(folder)).resolves.toBe(folder);
  });
});
