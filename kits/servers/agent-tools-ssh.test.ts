import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostExtensionContext, HostExtensionServices, HostMcpTool } from "tau/host-extension";
import { SERVER_TOOLS } from "./agent-protocol";
import { ServerAgentTools } from "./agent-tools";
import { findSftpServer, startFakeSshServer } from "./fixtures/fake-ssh-server.mjs";
import { hasCommand } from "./fixtures/run-command";
import { paths, readCalls } from "./fixtures/servers-test-env.mjs";
import { ServerPrompts } from "./prompts";
import type { SftpJsonTarget } from "./sftp-json";
import { ServerSsh } from "./ssh-service";
import { gitCall } from "./sync/git";

const ready = hasCommand("ssh") && hasCommand("git") && Boolean(findSftpServer()) && process.platform !== "win32" && process.getuid?.() !== 0;
const jail = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

describe.skipIf(!ready)("the agent's server tools over ssh to the fake server", () => {
  let dir: string;
  let controlRoot: string;
  let server: Awaited<ReturnType<typeof startFakeSshServer>>;
  let site: string;
  let local: string;
  let ssh: ServerSsh;
  let prompts: ServerPrompts;
  let tools: Map<string, HostMcpTool>;
  const saved = process.env.TAU_SERVERS_SSH_CONFIG;
  const run = async (name: string, params: Record<string, unknown>) => {
    const result = await tools.get(name)!.execute("call", params, undefined, undefined, undefined as never) as { content: Array<{ text: string }> };
    return result.content.map((part) => part.text).join("");
  };

  beforeAll(async () => {
    dir = mkdtempSync("/tmp/tau-agent-t-");
    controlRoot = mkdtempSync("/tmp/tau-ctl-");
    // A command here is what a model might send; the sandbox keeps it to the fake's folders.
    server = await startFakeSshServer({ dir, trustHostKey: true, sandbox: jail });
    process.env.TAU_SERVERS_SSH_CONFIG = paths(dir).sshConfig;
    site = realpathSync(join(paths(dir).root, "site"));
    execFileSync("git", ["init", "-q", site]);
    execFileSync("git", ["-C", site, "add", "-A"]);
    execFileSync("git", ["-C", site, "-c", "user.email=t@example.invalid", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-qm", "live"]);
    local = join(dir, "local");
    mkdirSync(local);
    writeFileSync(join(local, "probe.php"), "<?php echo 'probe';\n");
    const services = {
      stateDir: join(dir, "state"),
      findCommand: (name: string) => (name === "ssh" ? "ssh" : undefined),
      noteSubprocess: () => undefined,
      log: () => undefined,
      knownWorkspacePath: async (path: string) => path,
    } as unknown as HostExtensionServices;
    const context = { id: "tau.servers", services, registerCommand: () => () => undefined, emit: () => undefined } as unknown as HostExtensionContext;
    const target = {
      id: "site", protocol: "sftp", host: "fake", port: server.port, username: "tester", remotePath: site, name: "site", context: "",
      hop: [], hostVerification: true, connectTimeout: 10_000, concurrency: 4, usable: true, ignore: [],
    } as unknown as SftpJsonTarget;
    prompts = new ServerPrompts(() => undefined);
    ssh = new ServerSsh(context, { prompts, controlRoot, lookupTarget: async () => target });
    const agent = new ServerAgentTools({
      list: async () => ({ project: { root: local, workspaceId: "ws1" }, targets: [target] }),
      transport: (input) => ssh.transport(input),
      status: async () => { throw new Error("not used"); },
      preview: async () => { throw new Error("not used"); },
      targetLevel: async () => "full",
      threadLevel: async () => undefined,
      mirrorDir: () => join(dir, "state", "mirror.git"),
      git: gitCall(),
    });
    tools = new Map(agent.tools({ sessionId: "t", cwd: local }).map((tool) => [tool.name, tool]));
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

  it("puts a file into ~/tmp and runs it there", async () => {
    expect(await run(SERVER_TOOLS.putTmp, { path: "checks/probe.php", localPath: "probe.php" })).toContain("Wrote ~/tmp/checks/probe.php (20 bytes)");
    expect(readFileSync(join(paths(dir).home, "tmp", "checks", "probe.php"), "utf8")).toBe("<?php echo 'probe';\n");
    const out = await run(SERVER_TOOLS.exec, { command: "cat checks/probe.php && pwd", cwd: "tmp" });
    expect(out).toContain("exit 0");
    expect(out).toContain("<?php echo 'probe';");
    await expect(run(SERVER_TOOLS.putTmp, { path: "../escape.txt", content: "x" })).rejects.toThrow(/relative to ~\/tmp/u);
    expect(existsSync(join(paths(dir).home, "escape.txt"))).toBe(false);
  }, 30_000);

  it("reads the server's Git without writing its index", async () => {
    const index = join(site, ".git", "index");
    const before = statSync(index).mtimeMs;
    writeFileSync(join(site, "index.php"), "<?php echo 'hotfix';\n");
    const out = await run(SERVER_TOOLS.exec, { command: "git status --porcelain" });
    expect(out).toContain(" M index.php");
    expect(statSync(index).mtimeMs).toBe(before);
    expect(existsSync(join(site, ".git", "index.lock"))).toBe(false);
    await expect(run(SERVER_TOOLS.exec, { command: "git stash" })).rejects.toThrow("`git stash`");
    expect(execFileSync("git", ["-C", site, "stash", "list"], { encoding: "utf8" })).toBe("");
  }, 30_000);

  it("reads only the site's folder and ~/tmp", async () => {
    expect(await run(SERVER_TOOLS.read, { path: "~/tmp/checks/probe.php" })).toContain("probe");
    await expect(run(SERVER_TOOLS.list, { path: "/etc" })).rejects.toThrow();
    expect(readCalls(dir).filter((call) => call.outside)).toEqual([]);
  }, 30_000);

  it.skipIf(!jail)("keeps a command to the fake's folders", async () => {
    const outside = mkdtempSync("/tmp/tau-agent-outside-");
    try {
      const out = await run(SERVER_TOOLS.exec, { command: `echo x > ${outside}/x.txt` });
      expect(out).toMatch(/exit [1-9]/u);
      expect(existsSync(join(outside, "x.txt"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }, 30_000);
});
