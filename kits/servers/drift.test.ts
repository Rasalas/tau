import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostExtensionContext } from "tau/host-extension";
import { commitFilesToBranch, mergeBranch } from "../workspace/branch-commit.js";
import { DriftService, parseDiff } from "./drift.js";
import { undecidedDrift } from "./drift-protocol.js";
import { FolderServerFs } from "./fixtures/fake-server-fs.js";
import { readSftpJsonFile, type SftpJsonTarget } from "./sftp-json.js";
import { ServersStore } from "./store.js";
import { SyncService } from "./sync/service.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const logger = { warn: () => undefined };
const MTIME = 1_700_000_000;

function put(root: string, path: string, content: string, mtime = MTIME) {
  const file = join(root, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  utimesSync(file, mtime, mtime);
}

const SITE: Record<string, string> = {
  "index.php": "<?php echo 'home';\n",
  "about.php": "<?php echo 'about';\n",
  "css/site.css": "body { color: black; }\n",
};

interface World {
  dir: string;
  project: string;
  server: string;
  fs: FolderServerFs;
  target: SftpJsonTarget;
  sync: SyncService;
  drift: DriftService;
  workspaceCalls: string[];
  events: unknown[];
}

async function world(options: { shell?: boolean; download?: boolean } = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "tau-drift-"));
  const project = join(dir, "project");
  const server = join(dir, "server");
  for (const [path, content] of Object.entries(SITE)) { put(project, path, content); put(server, path, content); }
  put(project, ".gitignore", "uploads/\n");
  put(server, "uploads/photo.jpg", "binary");
  put(project, ".vscode/sftp.json", JSON.stringify({ name: "site", host: "127.0.0.1", port: 2222, username: "tester", remotePath: "/srv/site", ignore: [".vscode"] }));
  git(project, "init", "-q", "--initial-branch=main");
  git(project, "config", "user.name", "Test");
  git(project, "config", "user.email", "test@example.invalid");
  git(project, "config", "commit.gpgSign", "false");
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "start");
  const target = (await readSftpJsonFile(project))!.targets[0]!;
  const store = new ServersStore(join(dir, "state"), logger);
  const fs = new FolderServerFs(server, { shell: options.shell ?? false });
  const events: unknown[] = [];
  const context = {
    services: { knownWorkspacePath: async (path: string) => path, log: () => undefined, registerThreadLifecycle: () => () => undefined },
    emit: (event: string, payload: unknown) => { events.push({ event, payload }); },
    registerCommand: () => () => undefined,
  } as unknown as HostExtensionContext;
  const project$ = { root: project, workspaceId: "ws1" };
  const sync = new SyncService(context, { store, target: async () => ({ project: project$, target }), transport: async () => fs });
  const workspaceCalls: string[] = [];
  const drift = new DriftService(context, {
    store,
    list: async () => ({ project: project$, targets: [target] }),
    sync,
    // Workspace Kit's own functions, as its commands run them.
    workspace: async (command, input) => {
      workspaceCalls.push(command);
      const fields = input as Record<string, unknown> & { workspace: string };
      if (command === "commit-files-to-branch") return commitFilesToBranch(fields.workspace, fields as never);
      if (command === "merge-branch") return mergeBranch(fields.workspace, fields.branch as string);
      throw new Error(command);
    },
    now: () => new Date(2026, 8, 25, 10, 0, 0),
  });
  if (options.download !== false) await sync.download({ cwd: project, targetId: target.id });
  return { dir, project, server, fs, target, sync, drift, workspaceCalls, events };
}

function checkout(project: string) {
  return {
    head: git(project, "rev-parse", "HEAD"),
    status: git(project, "--no-optional-locks", "status", "--porcelain"),
    files: Object.fromEntries(Object.keys(SITE).map((path) => [path, existsSync(join(project, path)) ? readFileSync(join(project, path), "utf8") : null])),
  };
}

describe.skipIf(process.platform === "win32").each([{ shell: false }, { shell: true }])("server drift (shell: $shell)", ({ shell }) => {
  let w: World;
  beforeEach(async () => { w = await world({ shell }); });
  afterEach(() => rmSync(w.dir, { recursive: true, force: true }));

  it("imports a colleague's edit and deletion as exactly one branch commit, leaving the checkout alone", async () => {
    // A colleague edits one file and deletes another on the server.
    put(w.server, "index.php", "<?php echo 'hotfix';\n", MTIME + 60);
    unlinkSync(join(w.server, "about.php"));
    const before = checkout(w.project);

    const checked = await w.drift.check({ cwd: w.project, targetId: w.target.id });
    const files = checked.targets[0]!.check!.files;
    expect(files.map((file) => [file.path, file.change])).toEqual([["about.php", "deleted"], ["index.php", "modified"]]);
    expect(undecidedDrift(checked).files).toBe(2);

    const result = await w.drift.import({ cwd: w.project, targetId: w.target.id });
    const branch = result.imported!.branch;
    expect(branch).toBe("server-drift/2026-09-25");
    expect(git(w.project, "diff-tree", "-r", "--name-status", "--no-commit-id", branch)).toBe("D\tabout.php\nM\tindex.php");
    expect(git(w.project, "rev-parse", `${branch}^`)).toBe(before.head);
    expect(git(w.project, "show", `${branch}:index.php`)).toBe("<?php echo 'hotfix';");
    expect(checkout(w.project)).toEqual(before);
    // Resolved: the mirror now holds the server as read.
    expect(undecidedDrift(result.state)).toMatchObject({ files: 0, imports: [{ item: { branch, status: "open" } }] });
    expect((await w.drift.check({ cwd: w.project, targetId: w.target.id })).targets[0]!.check!.files).toEqual([]);

    const diff = await w.drift.diff({ cwd: w.project, targetId: w.target.id, path: "index.php", branch });
    expect(diff).toMatchObject({ added: 1, removed: 1 });

    // A second drift the same day gets its own branch.
    put(w.server, "css/site.css", "body { color: red; }\n", MTIME + 120);
    const second = await w.drift.import({ cwd: w.project, targetId: w.target.id });
    expect(second.imported!.branch).toBe("server-drift/2026-09-25-2");
    expect(git(w.project, "diff-tree", "-r", "--name-status", "--no-commit-id", second.imported!.branch)).toBe("M\tcss/site.css");
    expect(checkout(w.project)).toEqual(before);

    // Merging is a click: a normal merge commit.
    const merged = await w.drift.merge({ cwd: w.project, targetId: w.target.id, branch });
    expect(git(w.project, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    expect(readFileSync(join(w.project, "index.php"), "utf8")).toBe("<?php echo 'hotfix';\n");
    expect(existsSync(join(w.project, "about.php"))).toBe(false);
    expect(merged.targets[0]!.imports.map((item) => [item.branch, item.status])).toEqual([["server-drift/2026-09-25-2", "open"], [branch, "merged"]]);
    expect(w.workspaceCalls).toEqual(["commit-files-to-branch", "commit-files-to-branch", "merge-branch"]);
  });

  it("says later once for the same drift, and asks again when it grows", async () => {
    put(w.server, "index.php", "<?php echo 'hotfix';\n", MTIME + 60);
    await w.drift.check({ cwd: w.project, targetId: w.target.id });
    const later = await w.drift.later({ cwd: w.project, targetId: w.target.id });
    expect(undecidedDrift(later).files).toBe(0);
    expect(undecidedDrift(await w.drift.check({ cwd: w.project, targetId: w.target.id })).files).toBe(0);
    put(w.server, "new.php", "<?php\n", MTIME + 60);
    expect(undecidedDrift(await w.drift.check({ cwd: w.project, targetId: w.target.id })).files).toBe(2);
  });
});

describe.skipIf(process.platform === "win32")("server drift edge cases", () => {
  let w: World;
  afterEach(() => rmSync(w.dir, { recursive: true, force: true }));

  it("drops a touch the check could not rule out, and commits nothing", async () => {
    w = await world({ shell: false });
    put(w.server, "index.php", SITE["index.php"]!, MTIME + 60);
    const checked = await w.drift.check({ cwd: w.project, targetId: w.target.id });
    expect(checked.targets[0]!.check!.files).toEqual([{ path: "index.php", change: "modified", certain: false }]);
    const result = await w.drift.import({ cwd: w.project, targetId: w.target.id });
    expect(result.imported).toBeUndefined();
    expect(w.workspaceCalls).toEqual([]);
    expect(git(w.project, "branch", "--list", "server-drift/*")).toBe("");
    expect((await w.drift.check({ cwd: w.project, targetId: w.target.id })).targets[0]!.check!.files).toEqual([]);
  });

  it("compares with HEAD before Tau ever read the server, then keeps the server as its mirror", async () => {
    w = await world({ shell: false, download: false });
    put(w.server, "about.php", "<?php echo 'changed';\n", MTIME + 60);
    put(w.server, "contact.php", "<?php echo 'new';\n", MTIME + 60);
    const state = await w.drift.check({ cwd: w.project, targetId: w.target.id });
    expect(state.targets[0]!.check).toMatchObject({ baseline: "head" });
    // .gitignore is in HEAD and not on the server: never deployed, not deleted. uploads/ and .vscode are ignored.
    expect(state.targets[0]!.check!.files.map((file) => [file.path, file.change])).toEqual([["about.php", "modified"], ["contact.php", "added"]]);
    const before = checkout(w.project);
    const result = await w.drift.import({ cwd: w.project, targetId: w.target.id });
    expect(git(w.project, "diff-tree", "-r", "--name-status", "--no-commit-id", result.imported!.branch)).toBe("M\tabout.php\nA\tcontact.php");
    expect(checkout(w.project)).toEqual(before);
    const again = await w.drift.check({ cwd: w.project, targetId: w.target.id });
    expect(again.targets[0]!.check).toMatchObject({ baseline: "mirror", files: [] });
  });

  it("names a target it cannot compare yet", async () => {
    w = await world({ download: false });
    git(w.project, "update-ref", "-d", "HEAD");
    const state = await w.drift.state(w.project);
    expect(state.targets[0]).toMatchObject({ unchecked: true, imports: [] });
    await expect(w.drift.import({ cwd: w.project, targetId: w.target.id })).rejects.toThrow(/download it first/u);
  });
});

describe("parseDiff", () => {
  it("reads hunks, counts and a binary note", () => {
    const diff = parseDiff("a.php", "diff --git a/x b/y\nindex 1..2\n--- a/x\n+++ b/y\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n\\ No newline at end of file\n");
    expect(diff).toMatchObject({ added: 1, removed: 1, hunks: [{ lines: [{ kind: "context", oldLine: 1, newLine: 1 }, { kind: "removed", oldLine: 2 }, { kind: "added", newLine: 2 }] }] });
    expect(parseDiff("b.png", "Binary files a/x and b/y differ\n").note).toBe("Binary file");
  });
});
