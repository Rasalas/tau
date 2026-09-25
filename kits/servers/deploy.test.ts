import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostCommandCall, HostExtensionCommandHandler, HostExtensionContext, HostExtensionServices } from "tau/host-extension";
import { DeployService } from "./deploy";
import type { DeployPreview, DeployResolveResult, DeployResult, DeploymentRecord } from "./deploy-protocol";
import { DRIFT_FILE, DriftService } from "./drift";
import { FolderServerFs } from "./fixtures/fake-server-fs";
import { DEPLOYMENTS_FILE, readDeployments } from "./journal";
import type { SftpJsonTarget } from "./sftp-json";
import { ServerStatusService } from "./status";
import { ServersStore } from "./store";
import { MIRROR_INDEX_FILE } from "./sync/mirror";
import type { CompareResult } from "./sync/protocol";
import { SyncService } from "./sync/service";
import { blockUpload } from "./trust";
import type { ServerHistory, ServersStatus, TargetStatus } from "./view-protocol";

const posix = process.platform !== "win32";
const WORKSPACE_ID = "ws1";
const TARGET_ID = "sftp-site-12345678";
const KEY = { workspaceId: WORKSPACE_ID, targetId: TARGET_ID };

function put(root: string, path: string, content: string, options: { mtime?: number; mode?: number } = {}) {
  const file = join(root, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (options.mode !== undefined) chmodSync(file, options.mode);
  const mtime = options.mtime ?? 1_700_000_000;
  utimesSync(file, mtime, mtime);
}

const read = (root: string, path: string) => readFileSync(join(root, ...path.split("/")), "utf8");
const modeOf = (root: string, path: string) => statSync(join(root, ...path.split("/"))).mode & 0o7777;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const mirrorGit = (store: ServersStore, ...args: string[]) => execFileSync("git", args, { cwd: store.mirrorDir(KEY), encoding: "utf8", env: { ...process.env, GIT_DIR: store.mirrorDir(KEY) } }).trim();

/** Every file below `root`, relative. */
function tree(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? tree(root, path) : [path];
  }).sort();
}

interface World {
  dir: string;
  server: string;
  local: string;
  store: ServersStore;
  fs: FolderServerFs;
  target: SftpJsonTarget;
  status: ServerStatusService;
  events: Array<{ name: string; payload: unknown }>;
  call<T>(name: string, input?: unknown): Promise<T>;
}

function world(options: { shell?: boolean; filePerm?: number } = {}): World {
  const dir = mkdtempSync(join(tmpdir(), "tau-deploy-"));
  const server = join(dir, "server");
  const local = join(dir, "local");
  put(server, "index.php", "<?php echo 'home';\n", { mode: 0o640 });
  put(server, "about.php", "<?php echo 'about';\n");
  put(server, "contact.php", "<?php echo 'contact';\n");
  put(server, "css/site.css", "body{}\n");
  put(server, "bin/cron.sh", "#!/bin/sh\necho cron\n", { mode: 0o755 });
  mkdirSync(local);
  git(local, "init", "-q");
  git(local, "config", "user.email", "tester@example.invalid");
  git(local, "config", "user.name", "Tester");
  git(local, "config", "commit.gpgsign", "false");
  const store = new ServersStore(join(dir, "state"), { warn: () => undefined });
  const commands = new Map<string, HostExtensionCommandHandler>();
  const events: World["events"] = [];
  const services = {
    stateDir: join(dir, "state"),
    knownWorkspacePath: async (path: string) => path,
    log: () => undefined,
    noteSubprocess: () => undefined,
  } as unknown as HostExtensionServices;
  const context = {
    id: "tau.servers",
    services,
    registerCommand: (name: string, handler: HostExtensionCommandHandler) => { commands.set(name, handler); return () => undefined; },
    emit: (name: string, payload: unknown) => events.push({ name, payload }),
  } as unknown as HostExtensionContext;
  const target = {
    id: TARGET_ID, name: "site", protocol: "sftp", host: "127.0.0.1", port: 2222, username: "tester", remotePath: "/srv/site", context: "",
    profiles: [], usable: true, issues: [], ignore: [], concurrency: 4, ...(options.filePerm !== undefined ? { filePerm: options.filePerm } : {}),
  } as unknown as SftpJsonTarget;
  const fs = new FolderServerFs(server, { shell: options.shell ?? true, writable: true });
  const transport = async () => Object.assign(fs, { probe: { commands: [] } });
  const project = { root: local, workspaceId: WORKSPACE_ID };
  const sync = new SyncService(context, { store, target: async () => ({ project, target }), transport });
  sync.register();
  const list = async () => ({ project, targets: [target] });
  const drift = new DriftService(context, { store, list, sync, workspace: async () => { throw new Error("no Workspace Kit here"); } });
  const deploy = new DeployService(context, {
    store, sync, target: async () => ({ project, target }),
    drift: { state: (cwd) => drift.state(cwd), settled: (key, root, paths) => drift.settled(key, root, paths) },
  });
  deploy.register();
  const status = new ServerStatusService(context, {
    store, list,
    compare: (input) => sync.compare(input),
    transport,
    drift: { state: (cwd) => drift.state(cwd), check: (input) => drift.check(input, { quiet: true }) },
    uncommittedThreads: (key, root) => deploy.uncommittedThreads(key, root),
  });
  status.register();
  const call = <T>(name: string, input?: unknown) => Promise.resolve(commands.get(name)!(input, { owner: true } as HostCommandCall)) as Promise<T>;
  return { dir, server, local, store, fs, target, status, events, call };
}

const ref = (w: World) => ({ cwd: w.local, targetId: TARGET_ID });
const only = (status: ServersStatus): TargetStatus => status.targets[0]!;
const pendingOf = async (w: World) => only(await w.call<ServersStatus>("status", { cwd: w.local, fresh: true }));

async function downloaded(w: World): Promise<void> {
  await w.call("download", ref(w));
  git(w.local, "add", "-A");
  git(w.local, "commit", "-qm", "Server state");
}

describe.skipIf(!posix)("deployments", () => {
  let w: World;
  beforeEach(() => { w = world(); });
  afterEach(async () => { await w.status.idle(); w.status.dispose(); rmSync(w.dir, { recursive: true, force: true }); });

  it("uploads chosen changes with the old mode, deletes with a backup, journals it and records the new mirror state", async () => {
    await downloaded(w);
    put(w.local, "index.php", "<?php echo 'home, new';\n", { mtime: 1_700_000_100 });
    put(w.local, "css/site.css", "body{color:red}\n", { mtime: 1_700_000_100 });
    put(w.local, "bin/cron.sh", "#!/bin/sh\necho cron v2\n", { mtime: 1_700_000_100 });
    put(w.local, "pages/new.php", "<?php echo 'new';\n");
    unlinkSync(join(w.local, "contact.php"));

    const before = await pendingOf(w);
    expect(before.pending.map((row) => [row.path, row.change, row.selected])).toEqual([
      ["bin/cron.sh", "modified", true], ["contact.php", "deleted", true], ["css/site.css", "modified", true], ["index.php", "modified", true], ["pages/new.php", "added", true],
    ]);
    const files = before.pending.map((row) => ({ path: row.path, op: row.change === "added" ? "add" : row.change === "deleted" ? "delete" : "modify" }));

    const preview = await w.call<DeployPreview>("deploy-preview", { ...ref(w), files });
    expect(preview.files.map((file) => [file.path, file.outcome])).toEqual([
      ["bin/cron.sh", "upload"], ["css/site.css", "upload"], ["index.php", "upload"], ["pages/new.php", "upload"], ["contact.php", "delete"],
    ]);
    // The preview wrote nothing.
    expect(read(w.server, "index.php")).toBe("<?php echo 'home';\n");
    expect(w.fs.calls.some((call) => /^(write|rename|remove|mkdir|chmod)/u.test(call))).toBe(false);

    const result = await w.call<DeployResult>("deploy", { ...ref(w), files, threadId: "thread-1" });
    const deployment = result.deployment!;
    expect(result.failed).toEqual([]);
    expect(deployment).toMatchObject({ seq: 1, kind: "upload", status: "uploaded", origin: { actor: "user", via: "view", threadId: "thread-1" }, context: "" });
    expect(deployment.checkout.path).toBe(w.local);
    expect(deployment.checkout.head).toMatch(/^[0-9a-f]{40}$/u);
    expect(deployment.files.map((file) => [file.path, file.op, file.written])).toEqual([
      ["bin/cron.sh", "modify", "rename"], ["contact.php", "delete", undefined], ["css/site.css", "modify", "rename"], ["index.php", "modify", "rename"], ["pages/new.php", "add", "rename"],
    ].sort());

    // The server has the new content, the old modes and no temp files.
    expect(read(w.server, "index.php")).toBe("<?php echo 'home, new';\n");
    expect(modeOf(w.server, "index.php")).toBe(0o640);
    expect(modeOf(w.server, "bin/cron.sh")).toBe(0o755);
    expect(modeOf(w.server, "pages/new.php")).toBe(0o644);
    expect(existsSync(join(w.server, "contact.php"))).toBe(false);
    expect(tree(w.server).filter((path) => path.includes(".tau-"))).toEqual([]);

    // The deleted and the overwritten files are backed up in the shadow repository.
    const contact = deployment.files.find((file) => file.path === "contact.php")!;
    expect(mirrorGit(w.store, "cat-file", "blob", contact.before!)).toBe("<?php echo 'contact';");
    const index = deployment.files.find((file) => file.path === "index.php")!;
    expect(mirrorGit(w.store, "cat-file", "blob", index.before!)).toBe("<?php echo 'home';");
    expect(index.beforeMode).toBe(0o640);
    expect(mirrorGit(w.store, "rev-parse", "refs/tau/deploy/1")).toBe(deployment.commit);
    expect(mirrorGit(w.store, "show", "refs/tau/deploy/1^:contact.php")).toBe("<?php echo 'contact';");
    expect(mirrorGit(w.store, "show", "refs/tau/deploy/1:index.php")).toBe("<?php echo 'home, new';");

    // Journal, mirror state and history agree; nothing is pending and the server shows no drift.
    expect((await readDeployments(w.store, KEY)).map((record) => record.seq)).toEqual([1]);
    expect((await w.store.read(KEY, MIRROR_INDEX_FILE))!.commit).toBe(deployment.mirrorCommit);
    expect(deployment.mirrorCommit).toBe(deployment.commit);
    const history = await w.call<ServerHistory>("server-history", ref(w));
    expect(history.entries[0]).toMatchObject({ kind: "change", subject: "Deployment 1: 4 changed, 1 deleted", deployment: { seq: 1, status: "uploaded", threadId: "thread-1", failed: 0 } });
    const after = await pendingOf(w);
    expect(after.pending).toEqual([]);
    const compared = await w.call<CompareResult>("compare", ref(w));
    expect(compared.drift?.rows).toEqual([]);
    const sftpOnly = await w.call<CompareResult>("compare", { ...ref(w), method: "sftp" });
    expect(sftpOnly.drift?.rows).toEqual([]);
    expect(w.events.some((event) => event.name === "deployed")).toBe(true);

    // The thread's deployment is not committed yet; once HEAD holds it, it is.
    expect(after.uncommittedThreads).toEqual(["thread-1"]);
    git(w.local, "add", "-A");
    git(w.local, "commit", "-qm", "Deployed");
    expect((await pendingOf(w)).uncommittedThreads).toEqual([]);
    expect((await readDeployments(w.store, KEY))[0]!.status).toBe("committed");
  });

  it("blocks a file the server changed since the last read, uploads the rest, and merges it locally with conflict markers", async () => {
    await downloaded(w);
    put(w.local, "index.php", "<?php echo 'home';\necho 'local';\n", { mtime: 1_700_000_100 });
    put(w.local, "about.php", "<?php echo 'about, new';\n", { mtime: 1_700_000_100 });
    const files = [{ path: "index.php", op: "modify" }, { path: "about.php", op: "modify" }];
    expect((await w.call<DeployPreview>("deploy-preview", { ...ref(w), files })).files.every((file) => file.outcome === "upload")).toBe(true);
    // A colleague changes the file between the preview and the upload.
    put(w.server, "index.php", "<?php echo 'home';\necho 'hotfix';\n", { mtime: 1_700_000_200, mode: 0o640 });

    const result = await w.call<DeployResult>("deploy", { ...ref(w), files });
    expect(result.files.find((file) => file.path === "index.php")).toMatchObject({ outcome: "conflict", reason: "Changed on the server since Tau last read it." });
    expect(read(w.server, "index.php")).toBe("<?php echo 'home';\necho 'hotfix';\n");
    expect(read(w.server, "about.php")).toBe("<?php echo 'about, new';\n");
    expect(result.deployment!.files.map((file) => file.path)).toEqual(["about.php"]);
    expect(result.deployment!.skipped.map((file) => [file.path, file.outcome])).toEqual([["index.php", "conflict"]]);
    // The mirror keeps the old base for the conflict, so it still shows as one.
    const conflicted = await pendingOf(w);
    expect(conflicted.pending.map((row) => row.path)).toEqual(["index.php"]);

    const merged = await w.call<DeployResolveResult>("deploy-resolve", { ...ref(w), path: "index.php", action: "merge" });
    expect(merged).toEqual({ path: "index.php", action: "merge", conflicts: 1 });
    const text = read(w.local, "index.php");
    expect(text).toContain("<<<<<<< local\necho 'local';\n=======\necho 'hotfix';\n>>>>>>> server\n");
    // With the markers in it the file does not go up.
    const blocked = await w.call<DeployResult>("deploy", { ...ref(w), files: [{ path: "index.php", op: "modify" }] });
    expect(blocked.files[0]).toMatchObject({ outcome: "blocked", reason: "Holds conflict markers from a merge; resolve them before uploading." });
    expect(blocked.deployment).toBeUndefined();
    // Resolved by hand, it goes over the colleague's version knowingly: no conflict any more.
    put(w.local, "index.php", "<?php echo 'home';\necho 'local';\necho 'hotfix';\n", { mtime: 1_700_000_300 });
    const resolved = await w.call<DeployResult>("deploy", { ...ref(w), files: [{ path: "index.php", op: "modify" }] });
    expect(resolved.deployment!.files[0]).toMatchObject({ path: "index.php", op: "modify", mode: 0o640 });
    expect(mirrorGit(w.store, "cat-file", "blob", resolved.deployment!.files[0]!.before!)).toBe("<?php echo 'home';\necho 'hotfix';");
    expect(read(w.server, "index.php")).toBe("<?php echo 'home';\necho 'local';\necho 'hotfix';\n");
  });

  it("takes the server's file locally, or overwrites it anyway on the user's word with its content kept", async () => {
    await downloaded(w);
    put(w.local, "index.php", "<?php echo 'mine';\n", { mtime: 1_700_000_100 });
    put(w.local, "about.php", "<?php echo 'mine too';\n", { mtime: 1_700_000_100 });
    put(w.server, "index.php", "<?php echo 'theirs';\n", { mtime: 1_700_000_200 });
    put(w.server, "about.php", "<?php echo 'theirs too';\n", { mtime: 1_700_000_200 });

    const taken = await w.call<DeployResolveResult>("deploy-resolve", { ...ref(w), path: "index.php", action: "take-server" });
    expect(taken).toEqual({ path: "index.php", action: "take-server", conflicts: 0 });
    expect(read(w.local, "index.php")).toBe("<?php echo 'theirs';\n");
    expect((await pendingOf(w)).pending.map((row) => row.path)).toEqual(["about.php"]);

    const forced = await w.call<DeployResult>("deploy", { ...ref(w), files: [{ path: "about.php", op: "modify" }], force: ["about.php"] });
    expect(forced.files[0]).toMatchObject({ outcome: "conflict", forced: true });
    expect(read(w.server, "about.php")).toBe("<?php echo 'mine too';\n");
    const file = forced.deployment!.files[0]!;
    expect(mirrorGit(w.store, "cat-file", "blob", file.before!)).toBe("<?php echo 'theirs too';");
    // The server's changed content was read before the upload: the history says so.
    const history = await w.call<ServerHistory>("server-history", ref(w));
    expect(history.entries.slice(0, 2).map((entry) => entry.subject)).toEqual(["Deployment 1: 1 changed", expect.stringMatching(/^Server state .* \(before deployment 1\)$/u)]);
  });

  it("rewrites a file in place where its folder takes no new file, and reports what could not go", async () => {
    await downloaded(w);
    w.fs.denyEntries.add("css");
    put(w.local, "css/site.css", "body{color:blue}\n", { mtime: 1_700_000_100 });
    put(w.local, "css/print.css", "@media print{}\n");
    put(w.local, "about.php", "<?php echo 'about, new';\n", { mtime: 1_700_000_100 });
    chmodSync(join(w.server, "css", "site.css"), 0o604);
    const result = await w.call<DeployResult>("deploy", { ...ref(w), files: [{ path: "css/site.css", op: "modify" }, { path: "css/print.css", op: "add" }, { path: "about.php", op: "modify" }] });
    expect(read(w.server, "css/site.css")).toBe("body{color:blue}\n");
    expect(modeOf(w.server, "css/site.css")).toBe(0o604);
    expect(existsSync(join(w.server, "css", "print.css"))).toBe(false);
    expect(result.failed).toEqual([{ path: "css/print.css", op: "add", message: "Permission denied: css/print.css" }]);
    expect(result.deployment!.files.map((file) => [file.path, file.written])).toEqual([["about.php", "rename"], ["css/site.css", "in-place"]]);
    expect(result.deployment!.failed.map((failure) => failure.path)).toEqual(["css/print.css"]);
    expect((await pendingOf(w)).pending.map((row) => row.path)).toEqual(["css/print.css"]);
  });

  it("rewrites in place on a server without an atomic rename", async () => {
    const fs = new FolderServerFs(w.server, { writable: true, atomicRename: false });
    await downloaded(w);
    Object.assign(w.fs.caps, fs.caps);
    put(w.local, "about.php", "<?php echo 'about, new';\n", { mtime: 1_700_000_100 });
    const result = await w.call<DeployResult>("deploy", { ...ref(w), files: [{ path: "about.php", op: "modify" }] });
    expect(result.deployment!.files[0]).toMatchObject({ path: "about.php", written: "in-place" });
    expect(w.fs.calls.some((call) => call.startsWith("rename"))).toBe(false);
  });

  it("leaves a deselected deletion on the server and pending, and names it in the preview", async () => {
    await downloaded(w);
    unlinkSync(join(w.local, "contact.php"));
    unlinkSync(join(w.local, "about.php"));
    const files = [{ path: "about.php", op: "delete" }];
    const preview = await w.call<DeployPreview>("deploy-preview", { ...ref(w), files });
    expect(preview.kept).toEqual(["contact.php"]);
    await w.call<DeployResult>("deploy", { ...ref(w), files });
    expect(existsSync(join(w.server, "about.php"))).toBe(false);
    expect(existsSync(join(w.server, "contact.php"))).toBe(true);
    expect((await pendingOf(w)).pending).toEqual([{ path: "contact.php", change: "deleted", selected: true }]);
  });

  it("blocks the paths of an unmerged drift branch, in the list and in the upload", async () => {
    await downloaded(w);
    const head = git(w.local, "rev-parse", "HEAD");
    const drift = git(w.local, "commit-tree", `${head}^{tree}`, "-p", head, "-m", "Server drift");
    git(w.local, "update-ref", "refs/heads/server-drift/2026-09-25", drift);
    await w.store.write(KEY, DRIFT_FILE, { imports: [{ branch: "server-drift/2026-09-25", commit: drift, parent: head, at: new Date().toISOString(), status: "open", files: [{ path: "index.php", change: "modified", certain: true }] }] });
    put(w.local, "index.php", "<?php echo 'old local';\n", { mtime: 1_700_000_100 });
    const row = (await pendingOf(w)).pending[0]!;
    expect(row).toMatchObject({ path: "index.php", selected: false, blocked: expect.stringContaining("server-drift/2026-09-25 is not merged yet") });
    const result = await w.call<DeployResult>("deploy", { ...ref(w), files: [{ path: "index.php", op: "modify" }] });
    expect(result.files[0]).toMatchObject({ outcome: "blocked" });
    expect(result.deployment).toBeUndefined();
    expect(read(w.server, "index.php")).toBe("<?php echo 'home';\n");
    // Merged, the block is gone.
    git(w.local, "merge", "-q", "--no-edit", "server-drift/2026-09-25");
    expect((await pendingOf(w)).pending[0]!.blocked).toBeUndefined();
  });

  it("refuses what is no longer pending as chosen and what the block list keeps local", async () => {
    await downloaded(w);
    put(w.local, "about.php", "<?php echo 'about, new';\n", { mtime: 1_700_000_100 });
    put(w.local, "wp-config-local.php", "<?php // local\n");
    await blockUpload(w.store, KEY, "wp-config-local.php");
    const result = await w.call<DeployResult>("deploy", { ...ref(w), files: [{ path: "index.php", op: "modify" }, { path: "about.php", op: "delete" }, { path: "wp-config-local.php", op: "add" }] });
    expect(result.files.map((file) => [file.path, file.outcome])).toEqual([["wp-config-local.php", "blocked"], ["about.php", "stale"], ["index.php", "stale"]]);
    expect(result.deployment).toBeUndefined();
    expect(existsSync(join(w.server, "wp-config-local.php"))).toBe(false);
    await expect(w.call("deploy", { ...ref(w), files: [{ path: "../etc/passwd", op: "add" }] })).rejects.toThrow("Choose at least one file");
  });

  it("leaves a file alone that changed on the server during the upload", async () => {
    await downloaded(w);
    put(w.local, "about.php", "<?php echo 'about, new';\n", { mtime: 1_700_000_100 });
    w.fs.afterRead = (path) => {
      if (path === "about.php") put(w.server, "about.php", "<?php echo 'raced';\n", { mtime: 1_700_000_500 });
    };
    const result = await w.call<DeployResult>("deploy", { ...ref(w), files: [{ path: "about.php", op: "modify" }] });
    w.fs.afterRead = undefined;
    expect(result.files[0]).toMatchObject({ outcome: "conflict", reason: "Changed on the server during the upload." });
    expect(read(w.server, "about.php")).toBe("<?php echo 'raced';\n");
    expect(result.deployment).toBeUndefined();
    // Nothing went up and nothing failed: no deployment ref is left behind.
    expect(() => mirrorGit(w.store, "rev-parse", "--verify", "--quiet", "refs/tau/deploy/1")).toThrow();
  });

  it("warns when the last upload of a file came from another branch", async () => {
    await downloaded(w);
    const main = git(w.local, "rev-parse", "--abbrev-ref", "HEAD");
    git(w.local, "checkout", "-qb", "feature");
    put(w.local, "about.php", "<?php echo 'feature';\n", { mtime: 1_700_000_100 });
    await w.call<DeployResult>("deploy", { ...ref(w), files: [{ path: "about.php", op: "modify" }] });
    git(w.local, "checkout", "-q", "-f", main);
    put(w.local, "about.php", "<?php echo 'main';\n", { mtime: 1_700_000_300 });
    const preview = await w.call<DeployPreview>("deploy-preview", { ...ref(w), files: [{ path: "about.php", op: "modify" }] });
    expect(preview.warnings).toEqual([expect.stringMatching(/^about\.php last went up from feature; this upload is from /u)]);
  });

  it("keeps the journal file strict and ordered", async () => {
    const record = { seq: 2, kind: "upload", at: "2026-09-25T10:00:00.000Z", origin: { actor: "user", via: "card", threadId: "t" }, checkout: { path: "/p", branch: "main" }, context: "", files: [{ path: "a.php", op: "add", after: "a".repeat(40), mode: 0o644, written: "rename" }, { path: "../x", op: "add" }], failed: [], skipped: [], status: "committed", commit: "b".repeat(40), mirrorCommit: "c".repeat(40) } as unknown as DeploymentRecord;
    const decoded = DEPLOYMENTS_FILE.decode({ deployments: [record, { ...record, seq: 1 }, { seq: "x" }], extra: 1 }, 1)!;
    expect(decoded.deployments.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(decoded.deployments[0]!.files).toEqual([{ path: "a.php", op: "add", after: "a".repeat(40), mode: 0o644, written: "rename" }]);
    expect(decoded.deployments[0]!.origin).toEqual({ actor: "user", via: "card", threadId: "t" });
    expect(decoded.extra).toBe(1);
  });
});

describe.skipIf(!posix)("deployments with a file mode for new files", () => {
  it("gives a new file the target's filePerm", async () => {
    const w = world({ filePerm: 0o664, shell: false });
    try {
      await downloaded(w);
      put(w.local, "new.php", "<?php\n");
      const result = await w.call<DeployResult>("deploy", { ...ref(w), files: [{ path: "new.php", op: "add" }] });
      expect(result.deployment!.files[0]).toMatchObject({ path: "new.php", op: "add", mode: 0o664 });
      expect(modeOf(w.server, "new.php")).toBe(0o664);
    } finally {
      await w.status.idle();
      w.status.dispose();
      rmSync(w.dir, { recursive: true, force: true });
    }
  });
});
