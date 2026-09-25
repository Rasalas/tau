import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostExtensionContext, HostExtensionServices, HostMcpTool } from "tau/host-extension";
import type { PromptAsker } from "./askpass";
import { SERVER_TOOLS } from "./agent-protocol";
import { ServerAgentTools } from "./agent-tools";
import type { ServerCredentials } from "./credentials";
import { startFtpCli, stopFtpCli, type RunningFtp } from "./fixtures/fake-ftp-cli";
import { paths, prepareServersDir, readCalls } from "./fixtures/servers-test-env.mjs";
import { ServerFtp } from "./ftp-service";
import type { SftpJsonTarget } from "./sftp-json";
import { ServersStore } from "./store";
import { gitCall } from "./sync/git";

const ready = process.platform !== "win32" && process.getuid?.() !== 0;

describe.skipIf(!ready)("the agent's server tools over FTP", () => {
  let dir: string;
  let local: string;
  let running: RunningFtp;
  let ftp: ServerFtp;
  let agent: ServerAgentTools;
  let tools: Map<string, HostMcpTool>;
  const run = async (name: string, params: Record<string, unknown>) => {
    const result = await tools.get(name)!.execute("call", params, undefined, undefined, undefined as never) as { content: Array<{ text: string }> };
    return result.content.map((part) => part.text).join("");
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "tau-agent-ftp-"));
    prepareServersDir(dir);
    // The FTP login's home is the fake root, so its ~/tmp is root/tmp.
    mkdirSync(join(paths(dir).root, "tmp"), { recursive: true });
    writeFileSync(join(realpathSync(join(paths(dir).root, "site")), "index.php"), "<?php echo 'ftp site';\n");
    running = await startFtpCli(dir, ["--mode", "plain"]);
    local = join(dir, "local");
    mkdirSync(local);
    const store = new ServersStore(join(dir, "state"), { warn: () => undefined });
    const services = { stateDir: join(dir, "state"), log: () => undefined, noteSubprocess: () => undefined, knownWorkspacePath: async (path: string) => path, registerThreadLifecycle: () => () => undefined } as unknown as HostExtensionServices;
    const context = { id: "tau.servers", services, registerCommand: () => () => undefined, emit: () => undefined } as unknown as HostExtensionContext;
    const target = {
      id: "site", protocol: "ftp", host: "127.0.0.1", port: running.port, username: "tester", remotePath: "/site", name: "site", context: "",
      secure: false, hop: [], connectTimeout: 10_000, concurrency: 2, usable: true, ignore: [], password: { value: "ask" },
    } as unknown as SftpJsonTarget;
    const project = { root: local, workspaceId: "ws1" };
    const prompts: PromptAsker = { ask: async () => ({ action: "confirm" }) };
    const credentials = { attempt: () => ({ secret: async () => "test", accepted: async () => undefined, rejected: async () => undefined }) } as unknown as ServerCredentials;
    ftp = new ServerFtp(context, { prompts, credentials, store, lookupTarget: async () => ({ project, target }), env: {} });
    ftp.register();
    agent = new ServerAgentTools({
      list: async () => ({ project, targets: [target] }),
      transport: (input) => ftp.transport(input),
      status: async () => { throw new Error("not used"); },
      preview: async () => { throw new Error("not used"); },
      targetLevel: async () => "full",
      threadLevel: async () => undefined,
      mirrorDir: () => join(dir, "state", "mirror.git"),
      git: gitCall(),
    });
    await agent.isServerProject(local);
    tools = new Map(agent.tools({ sessionId: "t", cwd: local }).map((tool) => [tool.name, tool]));
  }, 60_000);

  afterAll(async () => {
    await ftp?.dispose();
    await stopFtpCli(running);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the site and writes ~/tmp over the file protocol, and offers no commands", async () => {
    expect([...tools.keys()]).not.toContain(SERVER_TOOLS.exec);
    expect(await run(SERVER_TOOLS.read, { path: "index.php" })).toContain("ftp site");
    expect(await run(SERVER_TOOLS.putTmp, { path: "probe/note.txt", content: "hello" })).toContain("Wrote ~/tmp/probe/note.txt (5 bytes)");
    expect(readFileSync(join(paths(dir).root, "tmp", "probe", "note.txt"), "utf8")).toBe("hello");
    await expect(run(SERVER_TOOLS.putTmp, { path: "../site/index.php", content: "x" })).rejects.toThrow(/relative to ~\/tmp/u);
    expect(readCalls(dir).filter((call) => call.outside)).toEqual([]);
  }, 60_000);
});
