import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostCommandCall, HostExtensionCommandHandler, HostExtensionContext, HostExtensionServices } from "tau/host-extension";
import { FolderServerFs } from "./fixtures/fake-server-fs";
import type { SftpJsonTarget } from "./sftp-json";
import { ServerStatusService } from "./status";
import { ServersStore } from "./store";
import { SyncService } from "./sync/service";
import { TARGET_FILE } from "./target-settings";
import { blockUpload } from "./trust";
import { SERVERS_STATUS_EVENT, SERVERS_STATUS_TOPIC, type ServerHistory, type ServersStatus, type TargetStatus } from "./view-protocol";
import type { UiFileDiff } from "tau/host-extension";

const posix = process.platform !== "win32";
const WORKSPACE_ID = "ws1";
const TARGET_ID = "sftp-site-12345678";

function put(root: string, path: string, content: string, mtime = 1_700_000_000) {
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
  fs: FolderServerFs;
  reachable: boolean;
  status: ServerStatusService;
  events: Array<{ name: string; payload: unknown; topic?: string }>;
  call<T>(name: string, input?: unknown): Promise<T>;
}

function world(options: { shell?: boolean } = {}): World {
  const dir = mkdtempSync(join(tmpdir(), "tau-status-"));
  const server = join(dir, "server");
  const local = join(dir, "local");
  put(server, "index.php", "<?php echo 'home';\n");
  put(server, "about.php", "<?php echo 'about';\n");
  put(server, "css/site.css", "body{}\n");
  put(server, "wp-config.php", "<?php\ndefine('DB_HOST', 'db.example.invalid');\ndefine('DB_PASSWORD', 'fake-password-not-real');\n");
  mkdirSync(local);
  execFileSync("git", ["init", "-q", local]);
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
    emit: (name: string, payload: unknown, emitOptions?: { topic?: string }) => events.push({ name, payload, ...(emitOptions?.topic ? { topic: emitOptions.topic } : {}) }),
  } as unknown as HostExtensionContext;
  const target = { id: TARGET_ID, name: "site", protocol: "sftp", host: "127.0.0.1", port: 2222, username: "tester", remotePath: "/srv/site", context: "", profiles: [], usable: true, issues: [], ignore: [], concurrency: 4 } as unknown as SftpJsonTarget;
  const fs = new FolderServerFs(server, { shell: options.shell ?? true });
  const w = { dir, server, local, store, fs, reachable: true, events } as World;
  const transport = async () => {
    if (!w.reachable) throw new Error("Could not connect to site: Connection refused");
    return Object.assign(fs, { probe: { commands: ["git"] } });
  };
  const sync = new SyncService(context, { store, target: async () => ({ project: { root: local, workspaceId: WORKSPACE_ID }, target }), transport });
  sync.register();
  w.status = new ServerStatusService(context, {
    store,
    list: async () => ({ project: { root: local, workspaceId: WORKSPACE_ID }, targets: [target] }),
    compare: (input) => sync.compare(input),
    transport,
    terminalCommand: async () => "ssh -t fake",
  });
  w.status.register();
  w.call = <T>(name: string, input?: unknown) => Promise.resolve(commands.get(name)!(input, { owner: true } as HostCommandCall)) as Promise<T>;
  return w;
}

const only = (status: ServersStatus): TargetStatus => status.targets[0]!;

async function settle(w: World): Promise<TargetStatus> {
  // The first status starts a check by itself; `check` joins it.
  return only(await w.call<ServersStatus>("check", { cwd: w.local, targetId: TARGET_ID }));
}

describe.skipIf(!posix)("the server view's status", () => {
  let w: World;
  beforeEach(() => { w = world(); });
  afterEach(async () => { await w.status.idle(); w.status.dispose(); rmSync(w.dir, { recursive: true, force: true }); });

  it("says a target was never read, checks the server once by itself and tells the watching clients", async () => {
    const first = only(await w.call<ServersStatus>("status", { cwd: w.local }));
    expect(first).toMatchObject({ targetId: TARGET_ID, label: "site", address: "sftp://tester@127.0.0.1:2222/srv/site", state: "never-read", level: "ask", pending: [] });
    const checked = await settle(w);
    expect(checked.state).toBe("never-read");
    expect(checked.checkedAt).toBeTruthy();
    expect(checked.serverGit).toEqual({ repository: false, reason: "The folder on the server is no Git repository." });
    expect(w.events.some((event) => event.name === SERVERS_STATUS_EVENT && event.topic === SERVERS_STATUS_TOPIC)).toBe(true);
    const checks = w.fs.calls.filter((call) => call.startsWith("exec git"));
    expect(checks.length).toBe(1);
    // Asking again does not reach the server again.
    await w.call("status", { cwd: w.local });
    expect(w.fs.calls.filter((call) => call.startsWith("exec git")).length).toBe(1);
  });

  it("goes from in sync to pending, with deletions as a group of their own and credential files unchosen", async () => {
    await w.call("download", { cwd: w.local, targetId: TARGET_ID });
    expect((await settle(w)).state).toBe("in-sync");
    writeFileSync(join(w.local, "index.php"), "<?php echo 'home v2';\n");
    writeFileSync(join(w.local, "wp-config.php"), "<?php\ndefine('DB_HOST', 'localhost');\n");
    unlinkSync(join(w.local, "about.php"));
    put(w.local, "new.php", "<?php\n");
    put(w.local, "wp-config-local.php", "<?php // mine\n");
    await blockUpload(w.store, { workspaceId: WORKSPACE_ID, targetId: TARGET_ID }, "wp-config-local.php");
    const status = only(await w.call<ServersStatus>("status", { cwd: w.local, fresh: true }));
    expect(status.state).toBe("pending");
    expect(status.pendingTotal).toBe(4);
    expect(status.pending).toEqual([
      { path: "about.php", change: "deleted", selected: true },
      { path: "index.php", change: "modified", size: 22, selected: true },
      { path: "new.php", change: "added", size: 6, selected: true },
      { path: "wp-config.php", change: "modified", size: 38, selected: false, credentials: ["WordPress database settings"] },
    ]);
    expect(status.withheld).toEqual(["wp-config-local.php"]);
    expect(status.liveConfigs).toEqual([{ path: "wp-config.php", label: "WordPress database settings" }]);
  });

  it("shows server drift, and a conflict when both sides changed a file", async () => {
    await w.call("download", { cwd: w.local, targetId: TARGET_ID });
    await settle(w);
    put(w.server, "css/site.css", "body{color:blue}\n", 1_700_000_900);
    unlinkSync(join(w.server, "about.php"));
    let status = only(await w.call<ServersStatus>("check", { cwd: w.local, targetId: TARGET_ID }));
    expect(status.state).toBe("drift");
    expect(status.drift?.map((row) => [row.path, row.change])).toEqual([["about.php", "deleted"], ["css/site.css", "modified"]]);
    writeFileSync(join(w.local, "css/site.css"), "body{color:red}\n");
    status = only(await w.call<ServersStatus>("check", { cwd: w.local, targetId: TARGET_ID }));
    expect(status.state).toBe("conflict");
    expect(status.conflicts).toEqual(["css/site.css"]);
  });

  it("marks an unreachable server and still lists what is not uploaded", async () => {
    await w.call("download", { cwd: w.local, targetId: TARGET_ID });
    await settle(w);
    w.reachable = false;
    writeFileSync(join(w.local, "index.php"), "<?php echo 'offline edit';\n");
    const status = only(await w.call<ServersStatus>("check", { cwd: w.local, targetId: TARGET_ID }));
    expect(status.state).toBe("unreachable");
    expect(status.unreachable).toBe("Could not connect to site: Connection refused");
    expect(status.pending.map((row) => row.path)).toEqual(["index.php"]);
    w.reachable = true;
    expect(only(await w.call<ServersStatus>("check", { cwd: w.local, targetId: TARGET_ID })).state).toBe("pending");
    // A connection that drops after the login: the listing fails the way ssh does.
    const lost = Object.assign(new Error("SFTP did not start on site: Connection refused"), { name: "SshConnectError" });
    const fail = async () => { throw lost; };
    Object.assign(w.fs, { list: fail, execStream: fail, exec: fail });
    expect(only(await w.call<ServersStatus>("check", { cwd: w.local, targetId: TARGET_ID }))).toMatchObject({ state: "unreachable", unreachable: lost.message });
  });

  it("diffs a pending file against the mirror state and lists the recorded reads", async () => {
    await w.call("download", { cwd: w.local, targetId: TARGET_ID });
    writeFileSync(join(w.local, "index.php"), "<?php echo 'home v2';\n");
    unlinkSync(join(w.local, "about.php"));
    const changed = await w.call<UiFileDiff>("server-diff", { cwd: w.local, targetId: TARGET_ID, source: "pending", path: "index.php" });
    expect(changed).toMatchObject({ path: "index.php", added: 1, removed: 1 });
    expect(changed.hunks[0]!.lines.map((line) => [line.kind, line.text])).toEqual([["removed", "<?php echo 'home';"], ["added", "<?php echo 'home v2';"]]);
    const gone = await w.call<UiFileDiff>("server-diff", { cwd: w.local, targetId: TARGET_ID, source: "pending", path: "about.php" });
    expect(gone).toMatchObject({ added: 0, removed: 1 });
    await expect(w.call("server-diff", { cwd: w.local, targetId: TARGET_ID, source: "pending", path: "../escape" })).rejects.toThrow(/Name a file/u);

    put(w.server, "css/site.css", "body{color:blue}\n", 1_700_000_900);
    await w.call("download", { cwd: w.local, targetId: TARGET_ID });
    const history = await w.call<ServerHistory>("server-history", { cwd: w.local, targetId: TARGET_ID });
    expect(history.entries.map((entry) => [entry.kind, entry.added, entry.modified, entry.deleted])).toEqual([["read", 0, 1, 0], ["read", 4, 0, 0]]);
    expect(history.entries[0]!.files).toEqual([{ path: "css/site.css", change: "modified" }]);
    const step = await w.call<UiFileDiff>("server-diff", { cwd: w.local, targetId: TARGET_ID, source: "history", commit: history.entries[0]!.commit, path: "css/site.css" });
    expect(step.hunks[0]!.lines.map((line) => line.kind)).toEqual(["removed", "added"]);
  });

  it("keeps the level for the agent's commands per target, and what later tickets add to target.json", async () => {
    expect(await w.call("target-levels", { cwd: w.local })).toEqual({ levels: { [TARGET_ID]: "ask" } });
    await w.store.write({ workspaceId: WORKSPACE_ID, targetId: TARGET_ID }, TARGET_FILE, { level: "ask", hostKey: "SHA256:x" });
    await w.call("set-target-level", { cwd: w.local, targetId: TARGET_ID, level: "full" });
    expect(await w.call("target-levels", { cwd: w.local })).toEqual({ levels: { [TARGET_ID]: "full" } });
    expect(await w.store.read({ workspaceId: WORKSPACE_ID, targetId: TARGET_ID }, TARGET_FILE)).toEqual({ level: "full", hostKey: "SHA256:x" });
    await expect(w.call("set-target-level", { cwd: w.local, targetId: TARGET_ID, level: "root" })).rejects.toThrow(/read-only, ask or full/u);
    expect(only(await w.call<ServersStatus>("status", { cwd: w.local })).level).toBe("full");
  });
});

describe.skipIf(!posix)("the server's own Git", () => {
  let w: World;
  beforeEach(() => { w = world(); });
  afterEach(async () => { await w.status.idle(); w.status.dispose(); rmSync(w.dir, { recursive: true, force: true }); });

  it("reads branch, changes and commits without writing the server's index", async () => {
    const git = (...args: string[]) => execFileSync("git", ["-C", w.server, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "d@x", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "d@x" } });
    git("init", "-q", "-b", "live");
    git("add", "-A");
    git("commit", "-q", "-m", "Site as deployed");
    // A touched file makes a plain `git status` refresh (and write) the index.
    utimesSync(join(w.server, "index.php"), 1_700_100_000, 1_700_100_000);
    writeFileSync(join(w.server, "about.php"), "<?php echo 'hotfix';\n");
    const index = join(w.server, ".git", "index");
    const before = statSync(index).mtimeMs;
    const status = await settle(w);
    expect(status.serverGit).toMatchObject({ repository: true, branch: "live", changed: 1, files: [{ path: "about.php", code: " M" }] });
    expect(status.serverGit && "commits" in status.serverGit ? status.serverGit.commits.map((commit) => commit.subject) : []).toEqual(["Site as deployed"]);
    expect(statSync(index).mtimeMs).toBe(before);
    expect(existsSync(join(w.server, ".git", "index.lock"))).toBe(false);
    expect(w.fs.calls.filter((call) => call.startsWith("exec git")).every((call) => call.includes("--no-optional-locks"))).toBe(true);
    expect(readFileSync(join(w.server, "about.php"), "utf8")).toContain("hotfix");
  });

  it("hands out the command a terminal types to log in", async () => {
    expect(await w.call("ssh-terminal", { cwd: w.local, targetId: TARGET_ID })).toEqual({ command: "ssh -t fake" });
  });
});
