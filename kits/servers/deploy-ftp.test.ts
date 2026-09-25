import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostCommandCall, HostExtensionCommandHandler, HostExtensionContext, HostExtensionServices } from "tau/host-extension";
import type { PromptAsker } from "./askpass";
import type { ServerCredentials } from "./credentials";
import { DeployService } from "./deploy";
import type { DeployResult } from "./deploy-protocol";
import { RollbackService } from "./rollback";
import type { RollbackPreview, RollbackResult } from "./rollback-protocol";
import { startFtpCli, stopFtpCli, type RunningFtp } from "./fixtures/fake-ftp-cli";
import { hasCommand } from "./fixtures/run-command";
import { paths, prepareServersDir, readCalls } from "./fixtures/servers-test-env.mjs";
import { ftpTrustOf, ServerFtp } from "./ftp-service";
import type { ServerPromptRequest } from "./protocol";
import type { SftpJsonTarget } from "./sftp-json";
import { ServersStore } from "./store";
import type { CompareResult, DownloadResult } from "./sync/protocol";
import { SyncService } from "./sync/service";
import { readTargetFile } from "./target-settings";

const ready = process.platform !== "win32" && process.getuid?.() !== 0;
const hasOpenssl = hasCommand("openssl", ["version"]);

function put(root: string, path: string, content: string, mode?: number) {
  const file = join(root, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode !== undefined) chmodSync(file, mode);
}

/** Download, server drift and a deployment over the fake FTP server, as the sync and deploy commands run them. */
function suite(mode: "plain" | "explicit") {
  let dir: string;
  let site: string;
  let local: string;
  let running: RunningFtp;
  let store: ServersStore;
  let context: HostExtensionContext;
  let target: SftpJsonTarget;
  const asked: ServerPromptRequest[] = [];
  const prompts: PromptAsker = { ask: async (request) => { asked.push(request); return { action: "confirm" }; } };
  const credentials = { attempt: () => ({ secret: async () => "test", accepted: async () => undefined, rejected: async () => undefined }) } as unknown as ServerCredentials;
  const project = { root: "", workspaceId: "ws1" };
  let ftp: ServerFtp;
  const commands = new Map<string, HostExtensionCommandHandler>();
  const call = <T>(name: string, input?: unknown) => Promise.resolve(commands.get(name)!(input, { owner: true } as HostCommandCall)) as Promise<T>;
  const ref = () => ({ cwd: local, targetId: "site" });
  const ftpCommands = () => readCalls(dir).filter((entry) => entry.tool === "ftp" && entry.event === "command");
  const newFtp = () => new ServerFtp(context, { prompts, credentials, store, lookupTarget: async () => ({ project, target }), env: {} });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), `tau-ftp-deploy-${mode}-`));
    prepareServersDir(dir);
    site = realpathSync(join(paths(dir).root, "site"));
    put(site, "index.php", "<?php echo 'home';\n", 0o640);
    put(site, "about.php", "<?php echo 'about';\n");
    put(site, "contact.php", "<?php echo 'contact';\n");
    put(site, "css/site.css", "body{}\n", 0o604);
    running = await startFtpCli(dir, ["--mode", mode, ...(mode === "plain" ? [] : ["--require-tls"])]);
    local = join(dir, "local");
    mkdirSync(local);
    execFileSync("git", ["init", "-q", local]);
    project.root = local;
    store = new ServersStore(join(dir, "state"), { warn: () => undefined });
    const services = {
      stateDir: join(dir, "state"),
      log: () => undefined,
      noteSubprocess: () => undefined,
      knownWorkspacePath: async (path: string) => path,
      registerThreadLifecycle: () => () => undefined,
    } as unknown as HostExtensionServices;
    context = {
      id: "tau.servers",
      services,
      registerCommand: (name: string, handler: HostExtensionCommandHandler) => { commands.set(name, handler); return () => undefined; },
      emit: () => undefined,
    } as unknown as HostExtensionContext;
    target = {
      id: "site", protocol: "ftp", host: "127.0.0.1", port: running.port, username: "tester", remotePath: "/site", name: "site", context: "",
      secure: mode !== "plain", hop: [], connectTimeout: 10_000, concurrency: 2, usable: true, ignore: [], password: { value: "ask" },
    } as unknown as SftpJsonTarget;
    ftp = newFtp();
    ftp.register();
    const sync = new SyncService(context, { store, target: async () => ({ project, target }), transport: (input) => ftp.transport(input) });
    sync.register();
    const deploy = new DeployService(context, { store, sync, target: async () => ({ project, target }) });
    deploy.register();
    new RollbackService(context, { store, sync, deploy }).register();
  }, 60_000);

  afterAll(async () => {
    await ftp?.dispose();
    await stopFtpCli(running);
    rmSync(dir, { recursive: true, force: true });
  });

  it("asks once before it connects, and keeps the answer for the target", async () => {
    const result = await call<DownloadResult>("download", ref());
    expect(result.method).toBe("sftp");
    expect(result.files).toBe(4);
    expect(readFileSync(join(local, "index.php"), "utf8")).toBe("<?php echo 'home';\n");
    expect(readFileSync(join(local, "css", "site.css"), "utf8")).toBe("body{}\n");
    expect(asked).toHaveLength(1);
    const trust = ftpTrustOf(await readTargetFile(store, { workspaceId: "ws1", targetId: "site" }));
    if (mode === "plain") {
      expect(asked[0]!.title).toBe("Send the password unencrypted?");
      expect(trust.plain).toBe(`ftp://tester@127.0.0.1:${running.port}`);
    } else {
      expect(asked[0]!.title).toBe("Trust this server's certificate?");
      expect(asked[0]!.detail).toContain("SHA-256 ");
      expect(Object.keys(trust.certificates ?? {})).toEqual([`127.0.0.1:${running.port}`]);
    }
    // A new connection (the project reopened) does not ask again.
    await ftp.dispose();
    ftp = newFtp();
    const compared = await call<CompareResult>("compare", ref());
    expect(asked).toHaveLength(1);
    expect(compared.drift?.rows).toEqual([]);
    expect(compared.pending?.rows).toEqual([]);
  }, 60_000);

  it("sees a colleague's change and deletion on the server as drift", async () => {
    put(site, "about.php", "<?php echo 'about';\n// hotfix\n");
    unlinkSync(join(site, "contact.php"));
    const compared = await call<CompareResult>("compare", ref());
    expect(compared.drift?.rows.map((row) => [row.path, row.change, row.certain])).toEqual([["about.php", "modified", true], ["contact.php", "deleted", true]]);
    await call<DownloadResult>("download", ref());
    expect(readFileSync(join(local, "about.php"), "utf8")).toContain("hotfix");
    expect(existsSync(join(local, "contact.php"))).toBe(false);
    expect((await call<CompareResult>("compare", ref())).drift?.rows).toEqual([]);
  }, 60_000);

  it("deploys through temp files and RNTO, keeps modes and leaves no drift", async () => {
    put(local, "index.php", "<?php echo 'home, new';\n");
    put(local, "css/site.css", "body{color:red}\n");
    put(local, "pages/pricing.php", "price\n");
    unlinkSync(join(local, "about.php"));
    const result = await call<DeployResult>("deploy", { ...ref(), files: [
      { path: "index.php", op: "modify" }, { path: "css/site.css", op: "modify" }, { path: "pages/pricing.php", op: "add" }, { path: "about.php", op: "delete" },
    ] });
    expect(result.failed).toEqual([]);
    expect(result.deployment!.files.map((file) => [file.path, file.op, file.written ?? "-"])).toEqual([
      ["about.php", "delete", "-"], ["css/site.css", "modify", "rename"], ["index.php", "modify", "rename"], ["pages/pricing.php", "add", "rename"],
    ]);
    expect(readFileSync(join(site, "index.php"), "utf8")).toBe("<?php echo 'home, new';\n");
    expect(statSync(join(site, "index.php")).mode & 0o777).toBe(0o640);
    expect(statSync(join(site, "css", "site.css")).mode & 0o777).toBe(0o604);
    expect(readFileSync(join(site, "pages", "pricing.php"), "utf8")).toBe("price\n");
    expect(existsSync(join(site, "about.php"))).toBe(false);
    expect(readdirSync(site).filter((name) => name.includes(".tau-"))).toEqual([]);
    const renames = ftpCommands().filter((entry) => entry.directive === "RNTO").map((entry) => entry.arg);
    expect(renames).toEqual(expect.arrayContaining(["/site/index.php", "/site/css/site.css", "/site/pages/pricing.php"]));
    const compared = await call<CompareResult>("compare", ref());
    expect(compared.drift?.rows).toEqual([]);
    expect(compared.pending?.rows).toEqual([]);
    const tls = ftpCommands().filter((entry) => ["USER", "PASS", "STOR", "RETR"].includes(String(entry.directive))).map((entry) => entry.tls);
    expect(new Set(tls)).toEqual(new Set([mode !== "plain"]));
  }, 60_000);

  it("does not overwrite a file changed on the server meanwhile", async () => {
    put(local, "index.php", "<?php echo 'home, mine';\n");
    put(site, "index.php", "<?php echo 'home, new';\n// colleague\n");
    const result = await call<DeployResult>("deploy", { ...ref(), files: [{ path: "index.php", op: "modify" }] });
    expect(result.files[0]).toMatchObject({ outcome: "conflict" });
    expect(readFileSync(join(site, "index.php"), "utf8")).toContain("colleague");
  }, 60_000);

  it("rolls the deployment back, leaves the colleague's file unless told, and rolls the rollback back", async () => {
    const preview = await call<RollbackPreview>("rollback-preview", { ...ref(), seq: 1 });
    expect(preview.files.map((file) => [file.path, file.outcome])).toEqual([
      ["about.php", "upload"], ["css/site.css", "upload"], ["index.php", "conflict"], ["pages/pricing.php", "delete"],
    ]);
    const undone = await call<RollbackResult>("rollback", { ...ref(), seq: 1, force: ["index.php"] });
    expect(undone.failed).toEqual([]);
    expect(undone.rolledBack).toBe(true);
    expect(readFileSync(join(site, "index.php"), "utf8")).toBe("<?php echo 'home';\n");
    expect(statSync(join(site, "index.php")).mode & 0o777).toBe(0o640);
    expect(readFileSync(join(site, "css", "site.css"), "utf8")).toBe("body{}\n");
    expect(statSync(join(site, "css", "site.css")).mode & 0o777).toBe(0o604);
    expect(readFileSync(join(site, "about.php"), "utf8")).toContain("hotfix");
    expect(existsSync(join(site, "pages"))).toBe(false);
    expect(ftpCommands().some((entry) => entry.directive === "RMD" && entry.arg === "/site/pages")).toBe(true);

    const redone = await call<RollbackResult>("rollback", { ...ref(), seq: undone.deployment!.seq });
    expect(redone.rolledBack).toBe(true);
    expect(readFileSync(join(site, "index.php"), "utf8")).toContain("colleague");
    expect(readFileSync(join(site, "pages", "pricing.php"), "utf8")).toBe("price\n");
    expect(existsSync(join(site, "about.php"))).toBe(false);
    expect((await call<CompareResult>("compare", ref())).drift?.rows).toEqual([]);
  }, 60_000);
}

describe.skipIf(!ready)("sync and deployments over plain FTP", () => suite("plain"));
describe.skipIf(!ready || !hasOpenssl)("sync and deployments over explicit FTPS", () => suite("explicit"));
