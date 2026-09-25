import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostCommandCall, HostExtensionCommandHandler, HostExtensionContext, HostExtensionServices } from "tau/host-extension";
import { HistoryCleanup, filesOfDiff, readRetention } from "./cleanup";
import { DeployService } from "./deploy";
import type { DeployResult } from "./deploy-protocol";
import { DRIFT_FILE, DriftService } from "./drift";
import { FolderServerFs } from "./fixtures/fake-server-fs";
import { DEPLOYMENTS_FILE, readDeployments } from "./journal";
import { RollbackService } from "./rollback";
import type { HistoryCleanupResult, RollbackPreview, RollbackResult } from "./rollback-protocol";
import type { SftpJsonTarget } from "./sftp-json";
import { ServerStatusService } from "./status";
import { ServersStore } from "./store";
import { SyncService } from "./sync/service";
import type { ServerHistory, ServersStatus } from "./view-protocol";

const posix = process.platform !== "win32";
const TARGET_ID = "sftp-site-12345678";
const KEY = { workspaceId: "ws1", targetId: TARGET_ID };
const DAY = 24 * 60 * 60 * 1000;

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

/** Every file below `root` with its content and mode. */
function snapshot(root: string, prefix = ""): Record<string, string> {
  return Object.fromEntries(readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? Object.entries(snapshot(root, path)) : [[path, `${modeOf(root, path).toString(8)} ${read(root, path)}`]];
  }).sort(([a], [b]) => a.localeCompare(b)));
}

interface World {
  dir: string;
  server: string;
  local: string;
  store: ServersStore;
  settings: Record<string, unknown>;
  clock: { now: Date };
  cleanup: HistoryCleanup;
  status: ServerStatusService;
  mirrorGit(...args: string[]): string;
  call<T>(name: string, input?: unknown): Promise<T>;
}

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), "tau-rollback-"));
  const server = join(dir, "server");
  const local = join(dir, "local");
  put(server, "index.php", "<?php echo 'home';\n", { mode: 0o640 });
  put(server, "about.php", "<?php echo 'about';\n");
  put(server, "contact.php", "<?php echo 'contact';\n", { mode: 0o640 });
  put(server, "lib/long.php", Array.from({ length: 12 }, (_, line) => `line ${line + 1}\n`).join(""));
  mkdirSync(local);
  git(local, "init", "-q");
  git(local, "config", "user.email", "tester@example.invalid");
  git(local, "config", "user.name", "Tester");
  git(local, "config", "commit.gpgsign", "false");
  const store = new ServersStore(join(dir, "state"), { warn: () => undefined });
  const commands = new Map<string, HostExtensionCommandHandler>();
  const settings: Record<string, unknown> = {};
  const services = {
    stateDir: join(dir, "state"),
    knownWorkspacePath: async (path: string) => path,
    log: () => undefined,
    noteSubprocess: () => undefined,
    settings: async () => ({ values: settings }),
  } as unknown as HostExtensionServices;
  const context = {
    id: "tau.servers",
    services,
    registerCommand: (name: string, handler: HostExtensionCommandHandler) => { commands.set(name, handler); return () => undefined; },
    emit: () => undefined,
  } as unknown as HostExtensionContext;
  const target = {
    id: TARGET_ID, name: "site", protocol: "sftp", host: "127.0.0.1", port: 2222, username: "tester", remotePath: "/srv/site", context: "",
    profiles: [], usable: true, issues: [], ignore: [], concurrency: 4,
  } as unknown as SftpJsonTarget;
  const fs = new FolderServerFs(server, { shell: true, writable: true });
  const transport = async () => Object.assign(fs, { probe: { commands: [] } });
  const project = { root: local, workspaceId: KEY.workspaceId };
  const sync = new SyncService(context, { store, target: async () => ({ project, target }), transport });
  sync.register();
  const list = async () => ({ project, targets: [target] });
  const drift = new DriftService(context, { store, list, sync, workspace: async () => { throw new Error("no Workspace Kit here"); } });
  const deployments = new DeployService(context, {
    store, sync, target: async () => ({ project, target }),
    drift: { state: (cwd) => drift.state(cwd), settled: (key, root, paths) => drift.settled(key, root, paths) },
  });
  deployments.register();
  new RollbackService(context, { store, sync, deploy: deployments }).register();
  const clock = { now: new Date() };
  const cleanup = new HistoryCleanup(context, { store, sync, list, now: () => clock.now });
  cleanup.register();
  const status = new ServerStatusService(context, {
    store, list,
    compare: (input) => sync.compare(input),
    transport,
    drift: { state: (cwd) => drift.state(cwd), check: (input) => drift.check(input, { quiet: true }) },
    uncommittedThreads: (key, root) => deployments.uncommittedThreads(key, root),
  });
  status.register();
  const call = <T>(name: string, input?: unknown) => Promise.resolve(commands.get(name)!(input, { owner: true } as HostCommandCall)) as Promise<T>;
  const mirrorGit = (...args: string[]) => execFileSync("git", args, { cwd: store.mirrorDir(KEY), encoding: "utf8", env: { ...process.env, GIT_DIR: store.mirrorDir(KEY) } }).trim();
  return { dir, server, local, store, settings, clock, cleanup, status, mirrorGit, call };
}

const ref = (w: World) => ({ cwd: w.local, targetId: TARGET_ID });

async function downloaded(w: World): Promise<void> {
  await w.call("download", ref(w));
  git(w.local, "add", "-A");
  git(w.local, "commit", "-qm", "Server state");
}

let tick = 1_700_000_100;
/** Changes local files and uploads them as one deployment. */
async function deploy(w: World, changes: Record<string, string | null>): Promise<DeployResult> {
  tick += 100;
  const files = Object.entries(changes).map(([path, content]) => {
    const existed = existsSync(join(w.local, ...path.split("/")));
    if (content === null) { unlinkSync(join(w.local, ...path.split("/"))); return { path, op: "delete" }; }
    put(w.local, path, content, { mtime: tick });
    return { path, op: existed ? "modify" : "add" };
  });
  const result = await w.call<DeployResult>("deploy", { ...ref(w), files });
  expect(result.failed).toEqual([]);
  expect(result.deployment).toBeDefined();
  return result;
}

const outcomes = (plan: RollbackPreview) => plan.files.map((file) => [file.path, file.outcome]);

describe.skipIf(!posix)("rollback", () => {
  let w: World;
  beforeEach(() => { w = world(); });
  afterEach(async () => { await w.status.idle(); w.status.dispose(); await w.cleanup.dispose(); rmSync(w.dir, { recursive: true, force: true }); });

  it("restores the server, and rolling back the rollback brings the deployment back", async () => {
    await downloaded(w);
    const start = snapshot(w.server);
    await deploy(w, { "index.php": "<?php echo 'home v2';\n", "pages/new.php": "<?php echo 'new';\n", "contact.php": null });
    const deployed = snapshot(w.server);

    const preview = await w.call<RollbackPreview>("rollback-preview", { ...ref(w), seq: 1 });
    expect(outcomes(preview)).toEqual([["contact.php", "upload"], ["index.php", "upload"], ["pages/new.php", "delete"]]);
    expect(snapshot(w.server)).toEqual(deployed);

    const undone = await w.call<RollbackResult>("rollback", { ...ref(w), seq: 1 });
    expect(undone.rolledBack).toBe(true);
    expect(undone.deployment).toMatchObject({ seq: 2, kind: "rollback", rollbackOf: 1, status: "uploaded" });
    // Every file as before, modes included; the folder the deployment made is gone again.
    expect(snapshot(w.server)).toEqual(start);
    expect(existsSync(join(w.server, "pages"))).toBe(false);
    expect(modeOf(w.server, "contact.php")).toBe(0o640);
    expect((await readDeployments(w.store, KEY)).map((record) => [record.seq, record.kind, record.status])).toEqual([[1, "upload", "rolled-back"], [2, "rollback", "uploaded"]]);
    await expect(w.call("rollback", { ...ref(w), seq: 1 })).rejects.toThrow("Deployment 1 is rolled back already; roll back 2 to bring it back.");

    // The local copy still holds the deployed files: they are pending again.
    const pending = (await w.call<ServersStatus>("status", { cwd: w.local, fresh: true })).targets[0]!.pending;
    expect(pending.map((row) => [row.path, row.change])).toEqual([["contact.php", "deleted"], ["index.php", "modified"], ["pages/new.php", "added"]]);

    const redone = await w.call<RollbackResult>("rollback", { ...ref(w), seq: 2 });
    expect(redone.deployment).toMatchObject({ seq: 3, kind: "rollback", rollbackOf: 2 });
    expect(snapshot(w.server)).toEqual(deployed);
    const again = await w.call<RollbackResult>("rollback", { ...ref(w), seq: 3 });
    expect(again.rolledBack).toBe(true);
    expect(snapshot(w.server)).toEqual(start);

    // Rollback 4 put back what HEAD (the first download) holds: committed.
    const history = await w.call<ServerHistory>("server-history", ref(w));
    expect(history.entries.slice(0, 4).map((entry) => [entry.subject, entry.deployment?.kind, entry.deployment?.rollbackOf, entry.deployment?.rolledBackBy, entry.deployment?.status])).toEqual([
      ["Rollback 4: deployment 3 undone (2 changed, 1 deleted)", "rollback", 3, undefined, "committed"],
      ["Rollback 3: deployment 2 undone (2 changed, 1 deleted)", "rollback", 2, 4, "rolled-back"],
      ["Rollback 2: deployment 1 undone (2 changed, 1 deleted)", "rollback", 1, 3, "rolled-back"],
      ["Deployment 1: 2 changed, 1 deleted", "upload", undefined, 2, "rolled-back"],
    ]);
  });

  it("rolls back an older deployment only after the newer one on the same file, or three-way", async () => {
    await downloaded(w);
    const lines = (edit: (lines: string[]) => void) => {
      const list = Array.from({ length: 12 }, (_, line) => `line ${line + 1}`);
      edit(list);
      return `${list.join("\n")}\n`;
    };
    await deploy(w, { "lib/long.php": lines((list) => { list[0] = "line 1 by deployment 1"; }), "about.php": "<?php echo 'about v2';\n" });
    await deploy(w, { "lib/long.php": lines((list) => { list[0] = "line 1 by deployment 1"; list[10] = "line 11 by deployment 2"; }) });

    const blocked = await w.call<RollbackPreview>("rollback-preview", { ...ref(w), seq: 1 });
    expect(blocked.newer).toEqual([2]);
    expect(blocked.files.find((file) => file.path === "lib/long.php")).toMatchObject({ outcome: "conflict", newer: 2, reason: "Deployment 2 changed this file afterwards. Roll that back first, or merge three-way." });
    expect(blocked.files.find((file) => file.path === "about.php")).toMatchObject({ outcome: "upload" });
    // Without three-way only the file no later deployment touched goes back; deployment 1 is not rolled back.
    const partly = await w.call<RollbackResult>("rollback", { ...ref(w), seq: 1 });
    expect(partly.rolledBack).toBe(false);
    expect(read(w.server, "about.php")).toBe("<?php echo 'about';\n");
    expect(read(w.server, "lib/long.php")).toContain("line 1 by deployment 1");
    expect((await readDeployments(w.store, KEY)).find((record) => record.seq === 1)!.status).toBe("uploaded");

    const merged = await w.call<RollbackPreview>("rollback-preview", { ...ref(w), seq: 1, threeWay: true });
    expect(merged.files.find((file) => file.path === "lib/long.php")).toMatchObject({ outcome: "upload", merged: true, newer: 2 });
    expect(merged.files.find((file) => file.path === "about.php")).toMatchObject({ outcome: "same" });
    const done = await w.call<RollbackResult>("rollback", { ...ref(w), seq: 1, threeWay: true });
    expect(done.rolledBack).toBe(true);
    expect(read(w.server, "lib/long.php")).toBe(lines((list) => { list[10] = "line 11 by deployment 2"; }));

    // The newer one first also works: rolled back in order, the file is as at the start.
    const second = await w.call<RollbackResult>("rollback", { ...ref(w), seq: 2, threeWay: true });
    expect(second.rolledBack).toBe(true);
    expect(read(w.server, "lib/long.php")).toBe(lines(() => undefined));
  });

  it("leaves a file a colleague changed unless the user overwrites it, and a merge that conflicts stays a conflict", async () => {
    await downloaded(w);
    await deploy(w, { "about.php": "<?php echo 'about v2';\n", "index.php": "<?php echo 'home v2';\n" });
    put(w.server, "about.php", "<?php echo 'about hotfix';\n", { mtime: 1_700_009_000 });
    put(w.server, "index.php", "<?php echo 'home hotfix';\n", { mtime: 1_700_009_000, mode: 0o640 });
    const preview = await w.call<RollbackPreview>("rollback-preview", { ...ref(w), seq: 1, threeWay: true });
    expect(preview.newer).toEqual([]);
    expect(preview.files.map((file) => [file.path, file.outcome, file.reason])).toEqual([
      ["about.php", "conflict", "A three-way merge conflicts with the later change in one place. Overwrite it with the file from before, or leave it."],
      ["index.php", "conflict", "A three-way merge conflicts with the later change in one place. Overwrite it with the file from before, or leave it."],
    ]);
    const result = await w.call<RollbackResult>("rollback", { ...ref(w), seq: 1, force: ["index.php"] });
    expect(result.files.map((file) => [file.path, file.outcome, file.forced])).toEqual([["about.php", "conflict", undefined], ["index.php", "conflict", true]]);
    expect(read(w.server, "about.php")).toBe("<?php echo 'about hotfix';\n");
    expect(read(w.server, "index.php")).toBe("<?php echo 'home';\n");
    expect(modeOf(w.server, "index.php")).toBe(0o640);
    // The colleague's file was read before it was overwritten: the rollback's backup holds it.
    expect(w.mirrorGit("show", `refs/tau/deploy/${result.deployment!.seq}^:index.php`)).toBe("<?php echo 'home hotfix';");
    expect(result.rolledBack).toBe(false);
  });

  it("marks a deployment checked, then committed once HEAD holds it; it stays in the history and can still be rolled back", async () => {
    await downloaded(w);
    await deploy(w, { "about.php": "<?php echo 'about v2';\n" });
    expect(await w.call("deployment-mark", { ...ref(w), seq: 1 })).toEqual({ seq: 1, status: "verified" });
    git(w.local, "commit", "-qam", "About v2");
    const history = await w.call<ServerHistory>("server-history", ref(w));
    expect(history.entries[0]!.deployment).toMatchObject({ seq: 1, status: "committed" });
    await expect(w.call("deployment-mark", { ...ref(w), seq: 1, checked: false })).rejects.toThrow("Deployment 1 is committed already.");
    const status = (await w.call<ServersStatus>("status", { cwd: w.local, fresh: true })).targets[0]!;
    expect(status.deployments).toBe("1:committed");

    const undone = await w.call<RollbackResult>("rollback", { ...ref(w), seq: 1 });
    expect(undone.rolledBack).toBe(true);
    expect(read(w.server, "about.php")).toBe("<?php echo 'about';\n");
    expect((await w.call<ServerHistory>("server-history", ref(w))).entries.map((entry) => entry.deployment?.seq).filter(Boolean)).toEqual([2, 1]);
  });

  it("counts a file as committed through the checkout's line-ending rules and Git LFS pointers", async () => {
    await downloaded(w);
    put(w.local, ".gitattributes", "*.txt text eol=crlf\n*.bin filter=lfs\n");
    git(w.local, "add", ".gitattributes");
    git(w.local, "commit", "-qm", "Attributes");
    await w.call("deploy", { ...ref(w), files: [{ path: ".gitattributes", op: "add" }] });
    const content = "binary-ish\u0001content\n";
    await deploy(w, { "notes.txt": "one\r\ntwo\r\n", "asset.bin": content });
    // Git stores the text file with LF; the LFS file as a pointer (written here, as without git-lfs no filter runs).
    const sha = execFileSync("shasum", ["-a", "256"], { input: content, encoding: "utf8" }).split(" ")[0];
    put(w.local, "asset.bin", `version https://git-lfs.github.com/spec/v1\noid sha256:${sha}\nsize ${Buffer.byteLength(content)}\n`);
    git(w.local, "add", "notes.txt", "asset.bin");
    git(w.local, "commit", "-qm", "Notes and asset");
    expect(git(w.local, "cat-file", "blob", "HEAD:notes.txt")).toBe("one\ntwo");
    const records = await (async () => { await w.call("status", { cwd: w.local, fresh: true }); return readDeployments(w.store, KEY); })();
    expect(records.map((record) => [record.seq, record.status])).toEqual([[1, "committed"], [2, "committed"]]);
  });
});

describe.skipIf(!posix)("history cleanup", () => {
  let w: World;
  beforeEach(() => { w = world(); });
  afterEach(async () => { await w.status.idle(); w.status.dispose(); await w.cleanup.dispose(); rmSync(w.dir, { recursive: true, force: true }); });

  it("keeps only the newest deployment with a retention of one, prunes the rest and can still roll that one back", async () => {
    await downloaded(w);
    const first = await deploy(w, { "about.php": "<?php echo 'about v2';\n" });
    await deploy(w, { "about.php": "<?php echo 'about v3';\n" });
    await deploy(w, { "index.php": "<?php echo 'home v2';\n" });
    const aboutV2 = first.deployment!.files[0]!.after!;
    w.settings.retentionCount = "1";

    const { targets } = await w.call<{ targets: HistoryCleanupResult[] }>("cleanup-history", { cwd: w.local });
    expect(targets).toEqual([{ targetId: TARGET_ID, removed: [1, 2], adopted: [], truncated: true, gc: true }]);
    expect((await readDeployments(w.store, KEY)).map((record) => record.seq)).toEqual([3]);
    expect(w.mirrorGit("for-each-ref", "--format=%(refname)", "refs/tau/deploy/")).toBe("refs/tau/deploy/3");
    // about.php v2 is in no kept state: gone from the shadow repository.
    expect(() => w.mirrorGit("cat-file", "-e", aboutV2)).toThrow();
    const history = await w.call<ServerHistory>("server-history", ref(w));
    expect(history.truncated).toBe(true);
    expect(history.entries.map((entry) => entry.deployment?.seq ?? entry.subject)).toEqual([3]);

    const undone = await w.call<RollbackResult>("rollback", { ...ref(w), seq: 3 });
    expect(undone.rolledBack).toBe(true);
    expect(read(w.server, "index.php")).toBe("<?php echo 'home';\n");
    // A second cleanup moves the boundary on and keeps the newest one only.
    // A commit-graph an earlier gc wrote must not outlive the commits it names.
    w.mirrorGit("commit-graph", "write", "--reachable");
    const again = await w.cleanup.sweep();
    expect(again[0]).toMatchObject({ removed: [3], truncated: true });
    expect((await w.call<ServerHistory>("server-history", ref(w))).entries.map((entry) => entry.deployment?.seq)).toEqual([4]);
    expect(w.mirrorGit("fsck", "--no-progress")).toBe("");
  });

  it("drops deployments older than the days kept, and nothing while they are young", async () => {
    await downloaded(w);
    await deploy(w, { "about.php": "<?php echo 'about v2';\n" });
    await deploy(w, { "index.php": "<?php echo 'home v2';\n" });
    const young = await w.cleanup.sweep();
    expect(young[0]).toMatchObject({ removed: [], adopted: [], truncated: false });
    w.settings.retentionDays = "30";
    w.clock.now = new Date(Date.now() + 31 * DAY);
    const old = await w.cleanup.sweep();
    expect(old[0]!.removed).toEqual([1, 2]);
    expect(await readDeployments(w.store, KEY)).toEqual([]);
    // The current mirror state always stays.
    const history = await w.call<ServerHistory>("server-history", ref(w));
    expect(history.entries).toHaveLength(1);
    expect(read(w.server, "about.php")).toBe("<?php echo 'about v2';\n");
  });

  it("records a deployment a crash left without a journal entry, and lets a bare backup expire", async () => {
    await downloaded(w);
    await deploy(w, { "about.php": "<?php echo 'about v2';\n", "contact.php": null });
    // As if Tau stopped right after writing: the ref holds the deployment, the journal does not.
    await w.store.write(KEY, DEPLOYMENTS_FILE, { deployments: [] });
    // And a backup of a run where nothing went up.
    const head = w.mirrorGit("rev-parse", "refs/tau/server");
    w.mirrorGit("update-ref", "refs/tau/deploy/2", head);

    const result = await w.cleanup.sweep();
    expect(result[0]).toMatchObject({ adopted: [1], removed: [] });
    expect(w.mirrorGit("for-each-ref", "--format=%(refname)", "refs/tau/deploy/")).toBe("refs/tau/deploy/1\nrefs/tau/deploy/2");
    const [record] = await readDeployments(w.store, KEY);
    expect(record).toMatchObject({ seq: 1, kind: "upload", status: "uploaded", note: expect.stringContaining("Recovered") });
    expect(record!.files.map((file) => [file.path, file.op])).toEqual([["about.php", "modify"], ["contact.php", "delete"]]);
    // The recovered deployment rolls back like any other.
    const undone = await w.call<RollbackResult>("rollback", { ...ref(w), seq: 1 });
    expect(undone.rolledBack).toBe(true);
    expect(read(w.server, "contact.php")).toBe("<?php echo 'contact';\n");
    expect(undone.deployment!.seq).toBe(3);

    // Once a deployment went through after it, the bare backup has served; the retention counts deployments only.
    w.settings.retentionCount = "2";
    const later = await w.cleanup.sweep();
    expect(later[0]!.removed).toEqual([2]);
    w.settings.retentionCount = "1";
    expect((await w.cleanup.sweep())[0]!.removed).toEqual([1]);
    expect(w.mirrorGit("for-each-ref", "--format=%(refname)", "refs/tau/deploy/")).toBe("refs/tau/deploy/3");
  });

  it("keeps the blobs a drift import still shows", async () => {
    await downloaded(w);
    const blob = (await deploy(w, { "about.php": "<?php echo 'about v2';\n" })).deployment!.files[0]!.before!;
    const orphan = execFileSync("git", ["hash-object", "-w", "--stdin"], { input: "colleague's version\n", encoding: "utf8", env: { ...process.env, GIT_DIR: w.store.mirrorDir(KEY) } }).trim();
    await w.store.write(KEY, DRIFT_FILE, { imports: [{ branch: "server-drift/2026-09-25", commit: "a".repeat(40), parent: "b".repeat(40), at: new Date().toISOString(), status: "open", files: [{ path: "about.php", change: "modified", certain: true, before: blob, after: orphan }] }] });
    await w.call("cleanup-history", { cwd: w.local });
    expect(w.mirrorGit("cat-file", "blob", orphan)).toBe("colleague's version");
    expect(w.mirrorGit("for-each-ref", "--format=%(refname)", "refs/tau/keep")).toBe("refs/tau/keep");
  });

  it("reads the retention settings as Settings stores them", () => {
    expect(readRetention({ retentionDays: "30", retentionCount: "1" })).toEqual({ days: 30, count: 1 });
    expect(readRetention({ retentionDays: "x", retentionCount: 0 })).toEqual({ days: 90, count: 200 });
    expect(filesOfDiff(`:100644 100755 ${"a".repeat(40)} ${"b".repeat(40)} M\0bin/x.sh\0:000000 100644 ${"0".repeat(40)} ${"c".repeat(40)} A\0new.php\0`)).toEqual([
      { path: "bin/x.sh", op: "modify", before: "a".repeat(40), after: "b".repeat(40), beforeMode: 0o644, mode: 0o755 },
      { path: "new.php", op: "add", after: "c".repeat(40), mode: 0o644 },
    ]);
  });
});
