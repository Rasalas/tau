import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostCommandCall, HostExtensionCommandHandler, HostExtensionContext, HostExtensionServices } from "tau/host-extension";
import { DeployService } from "./deploy";
import type { DeployResult } from "./deploy-protocol";
import { findSftpServer, startFakeSshServer } from "./fixtures/fake-ssh-server.mjs";
import { hasCommand } from "./fixtures/run-command";
import { paths, readCalls } from "./fixtures/servers-test-env.mjs";
import { ServerPrompts } from "./prompts";
import type { SftpJsonTarget } from "./sftp-json";
import { ServerSsh } from "./ssh-service";
import { ServersStore } from "./store";
import type { CompareResult } from "./sync/protocol";
import { SyncService } from "./sync/service";

const ready = hasCommand("ssh") && Boolean(findSftpServer()) && process.platform !== "win32" && process.getuid?.() !== 0;

function put(root: string, path: string, content: string, mode?: number) {
  const file = join(root, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode !== undefined) chmodSync(file, mode);
}

const later = (root: string, path: string) => { const t = Date.now() / 1000 + 5; utimesSync(join(root, ...path.split("/")), t, t); };

describe.skipIf(!ready)("deployments over ssh to the fake server", () => {
  let dir: string;
  let controlRoot: string;
  let server: Awaited<ReturnType<typeof startFakeSshServer>>;
  let site: string;
  let local: string;
  let ssh: ServerSsh;
  let prompts: ServerPrompts;
  const commands = new Map<string, HostExtensionCommandHandler>();
  const call = <T>(name: string, input?: unknown) => Promise.resolve(commands.get(name)!(input, { owner: true } as HostCommandCall)) as Promise<T>;
  const saved = process.env.TAU_SERVERS_SSH_CONFIG;
  const ref = () => ({ cwd: local, targetId: "site" });

  beforeAll(async () => {
    dir = mkdtempSync("/tmp/tau-deploy-t-");
    controlRoot = mkdtempSync("/tmp/tau-ctl-");
    server = await startFakeSshServer({ dir, trustHostKey: true });
    process.env.TAU_SERVERS_SSH_CONFIG = paths(dir).sshConfig;
    site = realpathSync(join(paths(dir).root, "site"));
    put(site, "index.php", "<?php echo 'home';\n", 0o640);
    put(site, "about.php", "<?php echo 'about';\n");
    put(site, "contact.php", "<?php echo 'contact';\n");
    put(site, "css/site.css", "body{}\n", 0o604);
    local = join(dir, "local");
    mkdirSync(local);
    execFileSync("git", ["init", "-q", local]);
    const store = new ServersStore(join(dir, "state"), { warn: () => undefined });
    const services = {
      stateDir: join(dir, "state"),
      findCommand: (name: string) => (name === "ssh" ? "ssh" : undefined),
      noteSubprocess: () => undefined,
      log: () => undefined,
      knownWorkspacePath: async (path: string) => path,
    } as unknown as HostExtensionServices;
    const context = {
      id: "tau.servers",
      services,
      registerCommand: (name: string, handler: HostExtensionCommandHandler) => { commands.set(name, handler); return () => undefined; },
      emit: () => undefined,
    } as unknown as HostExtensionContext;
    const target = {
      id: "site", protocol: "sftp", host: "fake", port: server.port, username: "tester", remotePath: site, name: "site", context: "",
      hop: [], hostVerification: true, connectTimeout: 10_000, concurrency: 4, usable: true, ignore: [],
    } as unknown as SftpJsonTarget;
    prompts = new ServerPrompts(() => undefined);
    ssh = new ServerSsh(context, { prompts, controlRoot, lookupTarget: async () => target });
    const project = { root: local, workspaceId: "ws1" };
    const sync = new SyncService(context, { store, target: async () => ({ project, target }), transport: (input) => ssh.transport(input) });
    sync.register();
    new DeployService(context, { store, sync, target: async () => ({ project, target }) }).register();
    await call("download", ref());
  }, 60_000);

  afterAll(async () => {
    if (saved === undefined) delete process.env.TAU_SERVERS_SSH_CONFIG;
    else process.env.TAU_SERVERS_SSH_CONFIG = saved;
    if (site && existsSync(join(site, "css"))) chmodSync(join(site, "css"), 0o755);
    prompts?.dispose();
    await ssh?.dispose();
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(controlRoot, { recursive: true, force: true });
  });

  it("uploads three changes and a deletion by posix-rename, keeping each file's mode", async () => {
    put(local, "index.php", "<?php echo 'home, new';\n");
    put(local, "about.php", "<?php echo 'about, new';\n");
    put(local, "css/site.css", "body{color:red}\n");
    unlinkSync(join(local, "contact.php"));
    const result = await call<DeployResult>("deploy", { ...ref(), files: [
      { path: "index.php", op: "modify" }, { path: "about.php", op: "modify" }, { path: "css/site.css", op: "modify" }, { path: "contact.php", op: "delete" },
    ] });
    expect(result.failed).toEqual([]);
    expect(result.deployment!.files.map((file) => [file.path, file.op, file.written ?? "-"])).toEqual([
      ["about.php", "modify", "rename"], ["contact.php", "delete", "-"], ["css/site.css", "modify", "rename"], ["index.php", "modify", "rename"],
    ]);
    expect(readFileSync(join(site, "index.php"), "utf8")).toBe("<?php echo 'home, new';\n");
    expect(statSync(join(site, "index.php")).mode & 0o777).toBe(0o640);
    expect(statSync(join(site, "css", "site.css")).mode & 0o777).toBe(0o604);
    expect(existsSync(join(site, "contact.php"))).toBe(false);
    expect(readdirSync(site).filter((name) => name.includes(".tau-"))).toEqual([]);
    const ops = readCalls(dir).filter((entry) => entry.event === "sftp-op").map((entry) => String(entry.line));
    expect(ops.some((line) => line.startsWith("posix-rename old") && line.includes("/.index.php.tau-"))).toBe(true);
    expect(readCalls(dir).filter((entry) => entry.outside)).toEqual([]);
    // Recorded with the server's own mtimes: no drift from the upload itself.
    const compared = await call<CompareResult>("compare", ref());
    expect(compared.drift?.rows).toEqual([]);
    expect(compared.pending?.rows).toEqual([]);
  }, 60_000);

  it("does not overwrite a file a colleague changed through the shell", async () => {
    put(local, "about.php", "<?php echo 'about, mine';\n");
    const transport = await ssh.transport(ref());
    expect((await transport.exec!("printf '// hotfix\\n' >> about.php")).code).toBe(0);
    const result = await call<DeployResult>("deploy", { ...ref(), files: [{ path: "about.php", op: "modify" }] });
    expect(result.files[0]).toMatchObject({ outcome: "conflict" });
    expect(result.deployment).toBeUndefined();
    expect(readFileSync(join(site, "about.php"), "utf8")).toBe("<?php echo 'about, new';\n// hotfix\n");
  }, 60_000);

  it("rewrites a file in place in a folder without write permission", async () => {
    chmodSync(join(site, "css"), 0o555);
    put(local, "css/site.css", "body{color:blue}\n");
    later(local, "css/site.css");
    const result = await call<DeployResult>("deploy", { ...ref(), files: [{ path: "css/site.css", op: "modify" }] });
    chmodSync(join(site, "css"), 0o755);
    expect(result.failed).toEqual([]);
    expect(result.deployment!.files[0]).toMatchObject({ path: "css/site.css", written: "in-place", mode: 0o604 });
    expect(readFileSync(join(site, "css", "site.css"), "utf8")).toBe("body{color:blue}\n");
    expect(readdirSync(join(site, "css"))).toEqual(["site.css"]);
  }, 60_000);
});
