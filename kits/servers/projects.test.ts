import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostExtensionServices } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createWorkspaceHostExtension } from "../workspace/host.js";
import { findSftpServer, startFakeSshServer } from "./fixtures/fake-ssh-server.mjs";
import { hasCommand } from "./fixtures/run-command";
import { paths, readCalls } from "./fixtures/servers-test-env.mjs";
import type { DraftListing, FolderInspection, ProjectMade } from "./project-plan";
import { registerServerProjects } from "./projects";
import { ServerPrompts } from "./prompts";
import { ServerSsh } from "./ssh-service";
import { ServersStore } from "./store";
import type { CompareResult, ScanSummary } from "./sync/protocol";
import { SyncService } from "./sync/service";
import { ServerTargets } from "./targets";

const ready = hasCommand("ssh") && Boolean(findSftpServer()) && process.platform !== "win32";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function put(root: string, path: string, content: string | Buffer) {
  const file = join(root, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Every file below `root` but `.git`, with its size and mtime. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else { const info = statSync(path); files[relative(root, path)] = `${info.size}:${info.mtimeMs}`; }
    }
  };
  walk(root);
  return files;
}

describe.skipIf(!ready)("a project from the fake SSH server", () => {
  let dir: string;
  let controlRoot: string;
  let server: Awaited<ReturnType<typeof startFakeSshServer>>;
  let site: string;
  let invoke: <T>(command: string, input?: unknown) => Promise<T>;
  let stop: () => Promise<void>;
  const saved = process.env.TAU_SERVERS_SSH_CONFIG;
  const admitted = new Set<string>();

  beforeAll(async () => {
    dir = mkdtempSync("/tmp/tau-proj-t-");
    controlRoot = mkdtempSync("/tmp/tau-ctl-");
    server = await startFakeSshServer({ dir, trustHostKey: true });
    process.env.TAU_SERVERS_SSH_CONFIG = paths(dir).sshConfig;
    site = realpathSync(join(paths(dir).root, "site"));
    put(site, "index.php", "<?php require 'wp-config.php';\n");
    put(site, "wp-config.php", "<?php\ndefine('DB_HOST', 'db.example.invalid');\ndefine('DB_PASSWORD', 'fake-password-not-real');\n");
    for (let file = 0; file < 20; file += 1) put(site, `wp-content/plugins/p/f${file}.php`, `<?php // ${file}\n`);
    for (let file = 0; file < 5; file += 1) put(site, `wp-content/uploads/2024/${file}.jpg`, Buffer.alloc(4096, file));
    put(site, "cache/page.html", "<html></html>\n");
    put(site, "bin/cron.sh", "#!/bin/sh\n");
    execFileSync("chmod", ["755", join(site, "bin/cron.sh")]);
    put(site, ".git/HEAD", "ref: refs/heads/server-only-marker\n");

    const services: Partial<HostExtensionServices> = {
      stateDir: join(dir, "state"),
      findCommand: (name: string) => (name === "ssh" ? "ssh" : undefined),
      noteSubprocess: () => undefined,
      knownWorkspacePath: async (path: string) => {
        if (!admitted.has(path)) throw new Error(`unknown workspace ${path}`);
        return path;
      },
      admitWorkspace: (path: string) => { admitted.add(path); return { workspaceId: `ws1_${createHash("sha256").update(path).digest("hex").slice(0, 16)}`, displayPath: path }; },
      workspaceRef: (path: string) => ({ workspaceId: `ws1_${createHash("sha256").update(path).digest("hex").slice(0, 16)}`, displayPath: path }),
      describeProjects: () => () => undefined,
      registerTurnObserver: () => () => undefined,
      registerThreadLifecycle: () => () => undefined,
      pinTranscriptEntries: () => () => undefined,
      registerRuntimeExtension: () => () => undefined,
      cwd: () => dir,
    };
    const registry = await activateHostKit(createWorkspaceHostExtension(), services);
    let ssh: ServerSsh | undefined;
    let prompts: ServerPrompts | undefined;
    // The kit's host entry as host.ts builds it, with its own control folder.
    await registry.activate({
      id: "tau.servers", name: "Servers", isolation: "in-process",
      permissions: ["process", "network", "sessions", "runtime:extend", "workspace:read", "workspace:write"],
      activate(context) {
        const store = new ServersStore(context.services.stateDir, { warn: () => undefined });
        const targets = new ServerTargets({ services: context.services, store });
        targets.register(context);
        prompts = new ServerPrompts(() => undefined);
        ssh = new ServerSsh(context, { prompts, controlRoot, lookupTarget: async (cwd, id) => (await targets.target(cwd, id)).target });
        ssh.register();
        const sync = new SyncService(context, { store, target: (cwd, id) => targets.target(cwd, id), transport: (input) => ssh!.transport(input) });
        sync.register();
        registerServerProjects(context, { store, targets, ssh, sync });
      },
    });
    invoke = <T,>(command: string, input?: unknown) => registry.invoke("tau.servers", command, input) as Promise<T>;
    stop = async () => { prompts?.dispose(); await ssh?.dispose(); };
  }, 60_000);

  afterAll(async () => {
    if (saved === undefined) delete process.env.TAU_SERVERS_SSH_CONFIG;
    else process.env.TAU_SERVERS_SSH_CONFIG = saved;
    await stop?.();
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(controlRoot, { recursive: true, force: true });
  });

  it("browses the server from the login folder and sizes a folder before anything comes down", async () => {
    const start = await invoke<DraftListing>("draft-browse", { server: { alias: "fake" } });
    expect(start.path).toBe(realpathSync(paths(dir).root));
    expect(start.directories.map((entry) => entry.name)).toContain("site");
    const inSite = await invoke<DraftListing>("draft-browse", { server: { alias: "fake" }, path: `${start.path}/site` });
    expect(inSite).toMatchObject({ path: site, parent: start.path, files: 2 });
    expect(inSite.directories.map((entry) => entry.name)).toEqual(["bin", "cache", "wp-content"]);

    const summary = await invoke<ScanSummary>("draft-scan", { server: { alias: "fake" }, remotePath: site });
    expect(summary).toMatchObject({ files: 29, gitRules: false });
    expect(summary.folders.map((folder) => folder.path)).toEqual(["bin", "cache", "wp-content", "wp-content/plugins", "wp-content/uploads"]);
    await invoke("draft-close");
    await expect(invoke("draft-browse", { server: { address: "tester@192.0.2.1" } })).rejects.toThrow(/loopback/iu);
    await expect(invoke("draft-browse", { server: { address: "ftp://tester@127.0.0.1" } })).rejects.toThrow("FTP");
  }, 60_000);

  it("makes a project with one commit of the server state, the deselected folders in .gitignore, and nothing to upload or import", async () => {
    const parent = join(dir, "projects");
    mkdirSync(parent);
    const made = await invoke<ProjectMade>("create-project", {
      server: { alias: "fake" }, remotePath: site, parent, name: "shop", exclude: ["wp-content/uploads", "cache"],
    });
    const project = realpathSync(join(parent, "shop"));
    expect(made).toMatchObject({ path: project, branch: "main", files: 24, ignoredIn: "gitignore", liveConfigs: 1 });
    expect(git(project, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(project, "log", "-1", "--format=%s")).toMatch(new RegExp(`^Server state fake:${site} \\d{4}-\\d{2}-\\d{2}$`, "u"));
    expect(git(project, "status", "--porcelain", "--ignored=no")).toBe("");
    expect(git(project, "ls-tree", "HEAD", "bin/cron.sh")).toMatch(/^100755 /u);
    const tracked = git(project, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
    expect(tracked).toContain(".gitignore");
    expect(tracked.some((path) => path.startsWith("wp-content/uploads") || path.startsWith("cache/") || path.startsWith(".vscode"))).toBe(false);
    expect(readFileSync(join(project, ".gitignore"), "utf8")).toMatch(/^\/cache\/\n\/wp-content\/uploads\/\n[\s\S]*\/\.vscode\/sftp\.json\n$/mu);
    expect(existsSync(join(project, "wp-content", "uploads"))).toBe(false);
    expect(readFileSync(join(project, ".git", "HEAD"), "utf8")).not.toContain("server-only-marker");
    const sftp = JSON.parse(readFileSync(join(project, ".vscode", "sftp.json"), "utf8")) as Record<string, unknown>;
    expect(sftp).toMatchObject({ name: "fake", host: "fake", port: server.port, username: "tester", remotePath: site, ignore: [".vscode", ".git", ".DS_Store", "/.gitignore"] });
    expect(sftp).not.toHaveProperty("password");

    // The deselected folders are not drift "added", and Tau's .gitignore is nothing to upload.
    const targetId = (await invoke<{ targets: Array<{ id: string }> }>("targets", { cwd: project })).targets[0]!.id;
    const compared = await invoke<CompareResult>("compare", { cwd: project, targetId });
    expect(compared.pending?.rows).toEqual([]);
    expect(compared.drift?.rows).toEqual([]);
    expect(readCalls(dir).filter((entry) => entry.outside)).toEqual([]);
  }, 120_000);

  it("refuses a folder that holds something and leaves no half-made project behind", async () => {
    const parent = join(dir, "busy");
    put(parent, "shop/notes.txt", "mine\n");
    await expect(invoke("create-project", { server: { alias: "fake" }, remotePath: site, parent, name: "shop", exclude: [] })).rejects.toThrow("not empty");
    expect(readFileSync(join(parent, "shop/notes.txt"), "utf8")).toBe("mine\n");
    await expect(invoke("create-project", { server: { alias: "fake" }, remotePath: `${site}/missing`, parent, name: "gone", exclude: [] })).rejects.toThrow();
    expect(existsSync(join(parent, "gone"))).toBe(false);
  }, 60_000);

  it("gives a folder with sftp.json its Git: the server is the first commit, the files stay, git status shows the one difference", async () => {
    const local = join(dir, "linked");
    cpSync(site, local, { recursive: true, filter: (source) => !source.includes(`${site}/.git`) && !source.includes("uploads") });
    put(local, "index.php", "<?php // edited here\n");
    put(local, "node_modules/x/index.js", "local tooling\n");
    put(local, ".vscode/sftp.json", JSON.stringify({ name: "live", host: "fake", port: server.port, username: "tester", remotePath: site, ignore: [".vscode", "node_modules"] }));
    const before = snapshot(local);

    const inspection = await invoke<FolderInspection>("inspect-folder", { path: local });
    expect(inspection).toMatchObject({ path: realpathSync(local), hasGit: false, empty: false });
    const targetId = inspection.targets[0]!.id;
    const summary = await invoke<ScanSummary>("link-scan", { path: local, targetId });
    expect(summary.folders.map((folder) => folder.path)).toContain("wp-content/uploads");

    const made = await invoke<ProjectMade>("link-folder", { path: local, exclude: { [targetId]: ["wp-content/uploads"] } });
    expect(made).toMatchObject({ branch: "main", ignoredIn: "exclude", files: 24 });
    expect(snapshot(local)).toEqual(before);
    expect(git(local, "status", "--porcelain")).toBe("M index.php");
    expect(git(local, "rev-list", "--count", "HEAD")).toBe("1");
    expect(readFileSync(join(local, ".git", "info", "exclude"), "utf8")).toContain("/.vscode/sftp.json\n/wp-content/uploads/\n.vscode\nnode_modules\n");

    const compared = await invoke<CompareResult>("compare", { cwd: realpathSync(local), targetId });
    expect(compared.pending?.rows).toEqual([expect.objectContaining({ path: "index.php", change: "modified" })]);
    expect(compared.drift?.rows).toEqual([]);
    await expect(invoke("link-folder", { path: local, exclude: {} })).rejects.toThrow("has Git already");
  }, 120_000);
});
