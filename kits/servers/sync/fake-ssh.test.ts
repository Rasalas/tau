import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostCommandCall, HostExtensionCommandHandler, HostExtensionContext, HostExtensionServices } from "tau/host-extension";
import { findSftpServer, startFakeSshServer } from "../fixtures/fake-ssh-server.mjs";
import { hasCommand } from "../fixtures/run-command";
import { paths, readCalls, TEST_PASSWORD } from "../fixtures/servers-test-env.mjs";
import { ServerPrompts } from "../prompts";
import { SERVERS_PROMPTS_EVENT, type ServerPrompt } from "../protocol";
import type { SftpJsonTarget } from "../sftp-json";
import { ServerSsh } from "../ssh-service";
import { ServersStore } from "../store";
import { readTrust } from "../trust";
import { Mirror, MIRROR_REF } from "./mirror";
import type { CompareResult, DownloadResult, ScanSummary, SyncProgress } from "./protocol";
import { SyncService } from "./service";

const ready = hasCommand("ssh") && Boolean(findSftpServer()) && process.platform !== "win32";
const GITIGNORE = "uploads/\n*.log\n";

function put(root: string, path: string, content: string | Buffer) {
  const file = join(root, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A WordPress-like site: 2,000 plugin files, a gitignored uploads/ and the server's own .git. */
function buildSite(site: string): string[] {
  const synced = [".gitignore", "index.php", "wp-config.php"];
  put(site, ".gitignore", GITIGNORE);
  put(site, "index.php", "<?php require 'wp-config.php';\n");
  put(site, "wp-config.php", "<?php\ndefine('DB_HOST', 'db.example.invalid');\ndefine('DB_PASSWORD', 'fake-password-not-real');\n");
  for (let plugin = 0; plugin < 40; plugin += 1) {
    for (let file = 0; file < 50; file += 1) {
      const path = `wp-content/plugins/p${plugin}/f${file}.php`;
      put(site, path, `<?php // plugin ${plugin} file ${file}\n${"x".repeat((plugin * 50 + file) % 400)}\n`);
      synced.push(path);
    }
  }
  for (let upload = 0; upload < 300; upload += 1) put(site, `uploads/2024/${upload}.jpg`, Buffer.alloc(2048, upload));
  put(site, "debug.log", "noise");
  put(site, ".git/HEAD", "ref: refs/heads/server-only-marker\n");
  put(site, ".git/config", "[core]\n\tbare = false\n");
  put(site, "wp-content/.git/HEAD", "nested\n");
  return synced.sort();
}

function fakeContext(stateDir: string) {
  const commands = new Map<string, HostExtensionCommandHandler>();
  const events: Array<{ name: string; payload: unknown; topic?: string }> = [];
  const services = {
    stateDir,
    findCommand: (name: string) => (name === "ssh" ? "ssh" : undefined),
    noteSubprocess: () => undefined,
    log: () => undefined,
    knownWorkspacePath: async (path: string) => path,
    registerThreadLifecycle: () => () => undefined,
  } as unknown as HostExtensionServices;
  const context = {
    id: "tau.servers",
    services,
    registerCommand: (name: string, handler: HostExtensionCommandHandler) => { commands.set(name, handler); return () => undefined; },
    emit: (name: string, payload: unknown, options?: { topic?: string }) => events.push({ name, payload, ...(options?.topic ? { topic: options.topic } : {}) }),
  } as unknown as HostExtensionContext;
  const call = <T>(name: string, input?: unknown) => Promise.resolve(commands.get(name)!(input, { owner: true } as HostCommandCall)) as Promise<T>;
  return { context, call, events };
}

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

describe.skipIf(!ready)("sync against the fake SSH server", () => {
  let dir: string;
  let controlRoot: string;
  let server: Awaited<ReturnType<typeof startFakeSshServer>>;
  let site: string;
  let synced: string[];
  let local: string;
  let store: ServersStore;
  let ssh: ServerSsh;
  let prompts: ServerPrompts;
  let harness: ReturnType<typeof fakeContext>;
  const saved = process.env.TAU_SERVERS_SSH_CONFIG;

  const target = (id: string): SftpJsonTarget => ({
    id, protocol: "sftp", host: "fake-password", port: server.port, username: "tester", remotePath: site, name: id, context: "",
    hop: [], hostVerification: true, connectTimeout: 10_000, concurrency: 4, usable: true, ignore: [".vscode"],
  }) as unknown as SftpJsonTarget;

  beforeAll(async () => {
    dir = mkdtempSync("/tmp/tau-sync-t-");
    controlRoot = mkdtempSync("/tmp/tau-ctl-");
    server = await startFakeSshServer({ dir, trustHostKey: true });
    process.env.TAU_SERVERS_SSH_CONFIG = paths(dir).sshConfig;
    site = realpathSync(join(paths(dir).root, "site"));
    rmSync(join(site, "index.php"));
    synced = buildSite(site);
    local = join(dir, "local");
    mkdirSync(local);
    execFileSync("git", ["init", "-q", local]);
    writeFileSync(join(local, ".gitignore"), GITIGNORE);
    store = new ServersStore(join(dir, "state"), { warn: () => undefined });
    harness = fakeContext(join(dir, "state"));
    prompts = new ServerPrompts((event, payload) => {
      if (event !== SERVERS_PROMPTS_EVENT) return;
      for (const prompt of (payload as { prompts: ServerPrompt[] }).prompts) {
        queueMicrotask(() => prompts.answer(prompt.id, prompt.kind === "secret" ? { action: "confirm", value: TEST_PASSWORD } : { action: "confirm" }));
      }
    });
    ssh = new ServerSsh(harness.context, { prompts, controlRoot, lookupTarget: async (_cwd, id) => target(id) });
    const sync = new SyncService(harness.context, {
      store,
      target: async (_cwd, id) => ({ project: { root: local, workspaceId: "ws1" }, target: target(id) }),
      transport: (input) => ssh.transport(input),
    });
    sync.register();
  }, 60_000);

  afterAll(async () => {
    if (saved === undefined) delete process.env.TAU_SERVERS_SSH_CONFIG;
    else process.env.TAU_SERVERS_SSH_CONFIG = saved;
    prompts?.dispose();
    await ssh?.dispose();
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(controlRoot, { recursive: true, force: true });
  });

  it("scans, downloads 2,000 files over tar without uploads/ or .git, and the mirror state is the server", async () => {
    const summary = await harness.call<ScanSummary>("scan", { cwd: local, targetId: "site" });
    expect(summary).toMatchObject({ method: "shell", files: synced.length, ignoredFolders: ["uploads"], ignoredFiles: 1, gitRules: true });
    expect(summary.folders.find((folder) => folder.path === "wp-content")).toMatchObject({ files: 2000 });

    const result = await harness.call<DownloadResult>("download", { cwd: local, targetId: "site" });
    expect(result).toMatchObject({ method: "tar", files: synced.length, written: synced.length - 1, unchanged: 1, kept: [], keptDeleted: [], failed: [], liveConfigs: 1 });
    expect(existsSync(join(local, "uploads"))).toBe(false);
    expect(existsSync(join(local, "debug.log"))).toBe(false);
    expect(existsSync(join(local, "wp-content", ".git"))).toBe(false);
    expect(readFileSync(join(local, ".git", "HEAD"), "utf8")).not.toContain("server-only-marker");

    const mirror = new Mirror(store.mirrorDir({ workspaceId: "ws1", targetId: "site" }));
    const files = await mirror.files();
    expect([...files.keys()].sort()).toEqual(synced);
    for (const path of synced) {
      const onServer = readFileSync(join(site, ...path.split("/")));
      expect(sha(await mirror.readBlob(files.get(path)!)), path).toBe(sha(onServer));
      expect(sha(readFileSync(join(local, ...path.split("/")))), path).toBe(sha(onServer));
    }
    expect(execFileSync("git", ["rev-parse", MIRROR_REF], { cwd: mirror.dir, encoding: "utf8" }).trim()).toBe(result.commit);
    expect((await readTrust(store, { workspaceId: "ws1", targetId: "site" })).liveConfigs).toEqual([{ path: "wp-config.php", kind: "wordpress-config", framework: "wordpress" }]);

    const last = harness.events.filter((event) => event.name === "sync-progress").at(-1)!;
    expect(last.topic).toBe("servers-sync");
    expect(last.payload).toMatchObject({ operation: "download", phase: "done", done: synced.length, total: synced.length } satisfies Partial<SyncProgress>);

    // The server's .git was never listed, read or streamed; nothing left the fake root.
    const calls = readCalls(dir);
    expect(calls.filter((entry) => entry.event === "sftp-op" && /\/\.git\b/u.test(String(entry.line)))).toEqual([]);
    expect(calls.filter((entry) => entry.outside)).toEqual([]);
  }, 120_000);

  it("finds a colleague's change and deletion on the server as drift and a local deletion as pending", async () => {
    const clean = await harness.call<CompareResult>("compare", { cwd: local, targetId: "site" });
    expect(clean.pending?.rows).toEqual([]);
    expect(clean.drift?.rows).toEqual([]);

    const transport = await ssh.transport({ cwd: local, targetId: "site" });
    const edit = await transport.exec!("printf '// hotfix\\n' >> index.php && rm wp-content/plugins/p3/f7.php && printf 'x' > uploads/2024/new.jpg");
    expect(edit.code).toBe(0);
    unlinkSync(join(local, "wp-content/plugins/p1/f1.php"));

    for (const method of ["auto", "sftp"]) {
      const result = await harness.call<CompareResult>("compare", { cwd: local, targetId: "site", method });
      expect(result.drift?.method).toBe(method === "sftp" ? "sftp" : "shell");
      expect(result.drift?.rows.map((row) => [row.path, row.change, row.certain])).toEqual([
        ["index.php", "modified", true],
        ["wp-content/plugins/p3/f7.php", "deleted", true],
      ]);
      expect(result.pending?.rows).toEqual([{ path: "wp-content/plugins/p1/f1.php", change: "deleted" }]);
    }
    const thorough = await harness.call<CompareResult>("compare", { cwd: local, targetId: "site", thorough: true, pending: false });
    expect(thorough.drift?.rows.map((row) => row.path)).toEqual(["index.php", "wp-content/plugins/p3/f7.php"]);
    expect(thorough.pending).toBeUndefined();
  }, 120_000);

  it("downloads the same over SFTP alone into a fresh folder", async () => {
    const fresh = join(dir, "fresh");
    mkdirSync(fresh);
    execFileSync("git", ["init", "-q", fresh]);
    writeFileSync(join(fresh, ".gitignore"), GITIGNORE);
    const result = await harness.call<DownloadResult>("download", { cwd: fresh, targetId: "site-sftp", method: "sftp" });
    const now = synced.filter((path) => path !== "wp-content/plugins/p3/f7.php");
    expect(result).toMatchObject({ method: "sftp", files: now.length, failed: [] });
    const files = await new Mirror(store.mirrorDir({ workspaceId: "ws1", targetId: "site-sftp" })).files();
    expect([...files.keys()].sort()).toEqual(now);
    expect(readFileSync(join(fresh, "index.php"), "utf8")).toContain("// hotfix");
    expect(existsSync(join(fresh, "uploads"))).toBe(false);
  }, 120_000);

  it("answers a bad request as the user's mistake, not a broken command", async () => {
    await expect(harness.call("scan", { targetId: "site" })).rejects.toMatchObject({ name: "HostCommandError" });
    const none = await harness.call<CompareResult>("compare", { cwd: join(dir, "fresh"), targetId: "never-downloaded" });
    expect(none).toEqual({ targetId: "never-downloaded" });
  });
});
