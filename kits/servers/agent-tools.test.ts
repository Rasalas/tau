import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  HostCommandCall, HostExtensionCommandHandler, HostExtensionContext, HostExtensionServices, HostMcpInstructionsProvider, HostMcpTool, HostMcpToolGate,
  HostMcpToolProvider, RuntimeExtensionFactory,
} from "tau/host-extension";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { kitMcpEndpoint } from "../../src/main/test-support/host-kit-harness.js";
import { SERVER_TOOLS, parseServerMark, parseUploadProposal } from "./agent-protocol";
import { SERVER_INSTRUCTIONS, ServerAgentTools, registerServerAgentTools, serverExecCommand } from "./agent-tools";
import { DeployService } from "./deploy";
import type { DeployResult } from "./deploy-protocol";
import { DriftService } from "./drift";
import { FolderServerFs } from "./fixtures/fake-server-fs";
import { readDeployments } from "./journal";
import type { TargetLevel } from "./protocol";
import type { SftpJsonTarget } from "./sftp-json";
import { ServerStatusService } from "./status";
import { ServersStore } from "./store";
import { gitCall } from "./sync/git";
import { SyncService } from "./sync/service";

const posix = process.platform !== "win32";
const WORKSPACE_ID = "ws1";
const TARGET_ID = "sftp-site-12345678";
const SESSION = { sessionId: "thread-1", cwd: "" };

function put(root: string, path: string, content: string, mtime = 1_700_000_000) {
  const file = join(root, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  utimesSync(file, mtime, mtime);
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

interface Hooks {
  tools: Map<string, HostMcpTool>;
  on: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
}

interface World {
  dir: string;
  server: string;
  local: string;
  other: string;
  store: ServersStore;
  fs: FolderServerFs;
  levels: { target: TargetLevel; thread: TargetLevel | undefined };
  status: ServerStatusService;
  agent: ServerAgentTools;
  call<T>(name: string, input?: unknown): Promise<T>;
  pi: RuntimeExtensionFactory;
  mcpTools: HostMcpToolProvider;
  mcpGate: HostMcpToolGate;
  instructions: HostMcpInstructionsProvider;
}

function world(options: { mcp?: HostExtensionServices["mcp"] } = {}): World {
  const dir = mkdtempSync(join(tmpdir(), "tau-agent-tools-"));
  const server = join(dir, "server");
  const local = join(dir, "local");
  const other = join(dir, "other");
  put(server, "index.php", "<?php echo 'home';\n");
  put(server, "about.php", "<?php echo 'about';\n");
  put(server, "wp-config.php", "<?php\ndefine('DB_HOST', 'db.example.invalid');\n");
  mkdirSync(local);
  mkdirSync(other);
  git(local, "init", "-q");
  git(local, "config", "user.email", "tester@example.invalid");
  git(local, "config", "user.name", "Tester");
  git(local, "config", "commit.gpgsign", "false");
  const store = new ServersStore(join(dir, "state"), { warn: () => undefined });
  const commands = new Map<string, HostExtensionCommandHandler>();
  let pi: RuntimeExtensionFactory | undefined;
  let mcpTools: HostMcpToolProvider | undefined;
  let mcpGate: HostMcpToolGate | undefined;
  let instructions: HostMcpInstructionsProvider | undefined;
  const services = {
    stateDir: join(dir, "state"),
    knownWorkspacePath: async (path: string) => path,
    log: () => undefined,
    noteSubprocess: () => undefined,
    registerRuntimeExtension: (_name: string, factory: RuntimeExtensionFactory) => { pi = factory; return () => undefined; },
    registerThreadLifecycle: () => () => undefined,
    mcp: options.mcp ?? {
      registerTools: (provider: HostMcpToolProvider) => { mcpTools = provider; return () => undefined; },
      gate: (gate: HostMcpToolGate) => { mcpGate = gate; return () => undefined; },
      registerInstructions: (provider: HostMcpInstructionsProvider) => { instructions = provider; return () => undefined; },
    },
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
  const project = { root: local, workspaceId: WORKSPACE_ID };
  const sync = new SyncService(context, { store, target: async () => ({ project, target }), transport });
  sync.register();
  const list = async (cwd: string) => (cwd === local ? { project, targets: [target] } : { project: { root: cwd, workspaceId: "ws2" }, targets: [] });
  const drift = new DriftService(context, { store, list, sync, workspace: async () => { throw new Error("no Workspace Kit here"); } });
  const deploy = new DeployService(context, { store, sync, target: async () => ({ project, target }), drift: { state: (cwd) => drift.state(cwd), settled: (key, root, paths) => drift.settled(key, root, paths) } });
  deploy.register();
  const status = new ServerStatusService(context, { store, list, compare: (input) => sync.compare(input), transport, drift: { state: (cwd) => drift.state(cwd), check: (input) => drift.check(input, { quiet: true }) } });
  status.register();
  const levels: World["levels"] = { target: "ask", thread: undefined };
  const agent = new ServerAgentTools({
    list,
    transport,
    status: (input) => status.status(input),
    preview: (input) => deploy.preview(input),
    targetLevel: async () => levels.target,
    threadLevel: async () => levels.thread,
    mirrorDir: (key) => store.mirrorDir(key),
    git: gitCall(),
  });
  registerServerAgentTools(context, agent);
  const call = <T>(name: string, input?: unknown) => Promise.resolve(commands.get(name)!(input, { owner: true } as HostCommandCall)) as Promise<T>;
  return { dir, server, local, other, store, fs, levels, status, agent, call, pi: pi!, mcpTools: mcpTools!, mcpGate: mcpGate!, instructions: instructions! };
}

async function piHooks(w: World, cwd: string): Promise<Hooks> {
  const hooks: Hooks = { tools: new Map(), on: new Map() };
  const api = {
    registerTool: (tool: HostMcpTool) => hooks.tools.set(tool.name, tool),
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => hooks.on.set(event, [...(hooks.on.get(event) ?? []), handler]),
  };
  await w.pi(api as never, { ...SESSION, cwd });
  return hooks;
}

const textOf = (value: { content: Array<{ type: string; text?: string }> }) => value.content.map((part) => part.text ?? "").join("");

async function run(hooks: Hooks, name: string, params: Record<string, unknown>) {
  return textOf(await hooks.tools.get(name)!.execute("call-1", params, undefined, undefined, undefined as never) as never);
}

/** Pi's `tool_call` hook with a scripted answer to every question; the questions asked come back too. */
async function toolCall(hooks: Hooks, toolName: string, input: Record<string, unknown>, answer = true) {
  const asked: Array<{ title: string; message: string }> = [];
  const ctx = { ui: { confirm: async (title: string, message: string) => { asked.push({ title, message }); return answer; } }, signal: undefined };
  const verdicts = await Promise.all((hooks.on.get("tool_call") ?? []).map((handler) => handler({ type: "tool_call", toolName, toolCallId: "call-1", input }, ctx)));
  return { verdict: verdicts.find(Boolean) as { block: true; reason: string } | undefined, asked };
}

async function downloaded(w: World) {
  await w.call("download", { cwd: w.local, targetId: TARGET_ID });
  git(w.local, "add", "-A");
  git(w.local, "commit", "-qm", "Server state");
}

const writesIn = (calls: readonly string[]) => calls.filter((entry) => /^(write|rename|remove|mkdir|rmdir|chmod|setMtime) /u.test(entry));

describe.skipIf(!posix)("the agent's server tools", () => {
  let w: World;
  beforeEach(() => { w = world(); });
  afterEach(async () => { await w.status.idle(); w.status.dispose(); rmSync(w.dir, { recursive: true, force: true }); });

  it("go only to threads of a server project, with the prompt section", async () => {
    const plain = await piHooks(w, w.other);
    expect(plain.tools.size).toBe(0);
    expect(plain.on.size).toBe(0);
    const hooks = await piHooks(w, w.local);
    expect([...hooks.tools.keys()].sort()).toEqual(Object.values(SERVER_TOOLS).sort());
    const prompt = hooks.on.get("before_agent_start")![0]!({ systemPrompt: "base" }, {}) as { systemPrompt: string };
    expect(prompt.systemPrompt).toBe(`base\n\n${SERVER_INSTRUCTIONS}`);
    expect(SERVER_INSTRUCTIONS).toContain("Only the user uploads");

    // Over MCP: a checkout Tau has not asked about yet counts by its own sftp.json.
    expect(w.mcpTools({ sessionId: "t", cwd: w.other })).toEqual([]);
    expect(w.mcpTools({ sessionId: "t", cwd: w.local }).map((tool) => tool.name)).toContain(SERVER_TOOLS.exec);
    expect(w.instructions({ sessionId: "t", cwd: w.local })).toBe(SERVER_INSTRUCTIONS);
    expect(w.instructions({ sessionId: "t", cwd: w.other })).toBeUndefined();
  });

  it("reads, lists and diffs without asking and without writing", async () => {
    await downloaded(w);
    put(w.local, "index.php", "<?php echo 'home, new';\n");
    const hooks = await piHooks(w, w.local);
    const writesBefore = writesIn(w.fs.calls).length;
    for (const [name, input] of [[SERVER_TOOLS.read, { path: "index.php" }], [SERVER_TOOLS.list, {}], [SERVER_TOOLS.diff, { paths: ["index.php"] }], [SERVER_TOOLS.status, {}]] as const) {
      const { verdict, asked } = await toolCall(hooks, name, input);
      expect(verdict).toBeUndefined();
      expect(asked).toEqual([]);
    }
    const read = await run(hooks, SERVER_TOOLS.read, { path: "index.php" });
    expect(parseServerMark(read)).toEqual({ label: "site", address: "sftp://tester@127.0.0.1:2222/srv/site" });
    expect(read).toContain("<?php echo 'home';");
    expect(await run(hooks, SERVER_TOOLS.list, {})).toMatch(/index\.php/u);
    const diff = await run(hooks, SERVER_TOOLS.diff, { paths: ["index.php"] });
    expect(diff).toContain("-<?php echo 'home';");
    expect(diff).toContain("+<?php echo 'home, new';");
    const status = await run(hooks, SERVER_TOOLS.status, {});
    expect(status).toContain(`site (id ${TARGET_ID})`);
    expect(status).toContain("commands on the server: ask the user first");
    expect(status).toContain("modified index.php");
    expect(writesIn(w.fs.calls).length).toBe(writesBefore);
    await expect(run(hooks, SERVER_TOOLS.read, { path: "../etc/passwd" })).rejects.toThrow(/relative to the site's folder/u);
    await expect(run(hooks, SERVER_TOOLS.read, { path: ".git/config" })).rejects.toThrow();
  });

  it("asks before a command at ask, runs it at full, refuses it read-only", async () => {
    await downloaded(w);
    const hooks = await piHooks(w, w.local);
    const ask = await toolCall(hooks, SERVER_TOOLS.exec, { command: "ls", cwd: "tmp" });
    expect(ask.asked).toEqual([{ title: "Run on the server site?", message: "ls\n\nsftp://tester@127.0.0.1:2222/srv/site in ~/tmp" }]);
    expect(ask.verdict).toBeUndefined();
    const declined = await toolCall(hooks, SERVER_TOOLS.exec, { command: "ls" }, false);
    expect(declined.verdict).toMatchObject({ block: true, reason: expect.stringContaining("did not allow server_exec") });

    w.levels.target = "full";
    expect((await toolCall(hooks, SERVER_TOOLS.exec, { command: "ls" })).asked).toEqual([]);
    const listing = await run(hooks, SERVER_TOOLS.exec, { command: "ls" });
    expect(listing).toMatch(/^\[site · sftp:\/\/tester@127\.0\.0\.1:2222\/srv\/site\] \/srv\/site\n\$ ls\nexit 0\n/u);
    expect(listing).toContain("index.php");
    expect(w.fs.calls).toContain("exec export GIT_OPTIONAL_LOCKS=0 && {\nls\n}");

    // The thread's own level narrows a target at full.
    w.levels.thread = "ask";
    expect((await toolCall(hooks, SERVER_TOOLS.exec, { command: "ls" })).asked).toHaveLength(1);
    w.levels.thread = "read-only";
    expect((await toolCall(hooks, SERVER_TOOLS.exec, { command: "ls" })).verdict).toMatchObject({ block: true, reason: expect.stringContaining("this thread is read-only") });
    await expect(run(hooks, SERVER_TOOLS.exec, { command: "ls" })).rejects.toThrow(/this thread is read-only/u);
    w.levels.thread = undefined;
    w.levels.target = "read-only";
    expect((await toolCall(hooks, SERVER_TOOLS.putTmp, { path: "a.txt", content: "x" })).verdict).toMatchObject({ block: true });
  });

  it("refuses Git writes on the server at every level, in the tool itself too", async () => {
    await downloaded(w);
    git(w.server, "init", "-q");
    const hooks = await piHooks(w, w.local);
    for (const level of ["ask", "full"] as const) {
      w.levels.target = level;
      const { verdict, asked } = await toolCall(hooks, SERVER_TOOLS.exec, { command: "git add . && git commit -m wip" });
      expect(asked).toEqual([]);
      expect(verdict).toMatchObject({ block: true, reason: expect.stringContaining("`git add`") });
    }
    const calls = w.fs.calls.length;
    await expect(run(hooks, SERVER_TOOLS.exec, { command: "git commit -m wip" })).rejects.toThrow(/Git on the server|read-only/u);
    expect(w.fs.calls.length).toBe(calls);
    // Reading Git runs, without the index lock.
    expect(await run(hooks, SERVER_TOOLS.exec, { command: "git status --porcelain" })).toContain("exit 0");
  });

  it("treats a local ssh, scp or curl to the server like server_exec", async () => {
    const hooks = await piHooks(w, w.local);
    w.levels.target = "full";
    const push = await toolCall(hooks, "bash", { command: "ssh tester@127.0.0.1 -p 2222 'cd /srv/site && git push'" });
    expect(push.verdict).toMatchObject({ block: true, reason: expect.stringContaining("`git push`") });
    w.levels.target = "ask";
    const copy = await toolCall(hooks, "bash", { command: "scp index.php tester@127.0.0.1:/srv/site/" });
    expect(copy.asked).toEqual([{ title: "Run on the server site?", message: "scp index.php tester@127.0.0.1:/srv/site/\n\nsftp://tester@127.0.0.1:2222/srv/site (through local scp)" }]);
    // Access Kit asks for bash at "ask" already.
    w.levels.thread = "ask";
    expect((await toolCall(hooks, "bash", { command: "scp index.php 127.0.0.1:/srv/site/" })).asked).toEqual([]);
    expect((await toolCall(hooks, "bash", { command: "npm test" })).asked).toEqual([]);
  });

  it("gates the same over MCP, where the runtime is not Pi", async () => {
    await downloaded(w);
    const asked: string[] = [];
    const gateCall = async (toolName: string, input: Record<string, unknown>) => w.mcpGate({
      threadId: "t", cwd: w.local, toolName, input, signal: new AbortController().signal,
      confirm: async (title) => { asked.push(title); return false; },
    });
    await expect(gateCall(SERVER_TOOLS.read, { path: "index.php" })).resolves.toBeUndefined();
    await expect(gateCall(SERVER_TOOLS.exec, { command: "ls" })).resolves.toMatchObject({ block: true });
    expect(asked).toEqual(["Run on the server site?"]);
    await expect(gateCall(SERVER_TOOLS.exec, { command: "git push" })).resolves.toMatchObject({ block: true, reason: expect.stringContaining("`git push`") });
    await expect(gateCall("edit", { path: "x" })).resolves.toBeUndefined();
  });

  it("proposes an upload as a card and writes nothing until the user's click uploads it", async () => {
    await downloaded(w);
    put(w.local, "index.php", "<?php echo 'home, new';\n", 1_700_000_100);
    put(w.local, "wp-config.php", "<?php\ndefine('DB_HOST', 'localhost');\n", 1_700_000_100);
    unlinkSync(join(w.local, "about.php"));
    const hooks = await piHooks(w, w.local);
    expect((await toolCall(hooks, SERVER_TOOLS.proposeUpload, {})).asked).toEqual([]);
    const writesBefore = writesIn(w.fs.calls).length;
    const output = await run(hooks, SERVER_TOOLS.proposeUpload, { note: "Home page greets." });
    const proposal = parseUploadProposal(output)!;
    expect(proposal).toMatchObject({ workspace: w.local, threadId: "thread-1", target: { id: TARGET_ID, label: "site" }, note: "Home page greets." });
    expect(proposal.files.map((file) => [file.path, file.outcome])).toEqual([["index.php", "upload"], ["about.php", "delete"]]);
    expect(proposal.leftOut).toEqual([{ path: "wp-config.php", reason: expect.stringContaining("holds live credentials") }]);
    expect(proposal.message).toContain("Nothing was uploaded");
    // Nothing on the server changed, no deployment exists.
    expect(writesIn(w.fs.calls).length).toBe(writesBefore);
    expect(readFileSync(join(w.server, "index.php"), "utf8")).toBe("<?php echo 'home';\n");
    expect(existsSync(join(w.server, "about.php"))).toBe(true);
    expect(await readDeployments(w.store, { workspaceId: WORKSPACE_ID, targetId: TARGET_ID })).toEqual([]);

    // Named files: one pending, one not.
    const named = parseUploadProposal(await run(hooks, SERVER_TOOLS.proposeUpload, { files: ["index.php", "./missing.php"] }))!;
    expect(named.files.map((file) => file.path)).toEqual(["index.php"]);
    expect(named.leftOut.map((entry) => entry.path)).toEqual(["missing.php"]);

    // The card's click: `deploy` with what the card shows.
    const files = proposal.files.filter((file) => file.outcome === "upload" || file.outcome === "delete").map((file) => ({ path: file.path, op: file.op }));
    const done = await w.call<DeployResult>("deploy", { cwd: proposal.workspace, targetId: proposal.target.id, files, via: "card", threadId: proposal.threadId });
    expect(done.deployment).toMatchObject({ origin: { actor: "user", via: "card", threadId: "thread-1" } });
    expect(readFileSync(join(w.server, "index.php"), "utf8")).toBe("<?php echo 'home, new';\n");
    expect(existsSync(join(w.server, "about.php"))).toBe(false);
  });

  it("answers a project without servers and an unknown server plainly", async () => {
    const hooks = await piHooks(w, w.local);
    await expect(run(hooks, SERVER_TOOLS.read, { path: "index.php", target: "nope" })).rejects.toThrow(`No server "nope" here. The servers are: site (${TARGET_ID}).`);
    await expect(run(hooks, SERVER_TOOLS.read, { path: "index.php", target: "SITE" })).resolves.toContain("home");
  });

  it("never upload: no tool reaches the deploy command", () => {
    const source = readFileSync(fileURLToPath(new URL("./agent-tools.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/["'](deploy|deploy-resolve)["']|\.deploy\(|invokeHostExtension/u);
  });

  it("runs a command only once its folder is entered", () => {
    const marker = join(w.dir, "ran.txt");
    const line = `cd ${join(w.dir, "missing")} && ${serverExecCommand(`true; touch ${marker}\n# a comment`)}`;
    expect(() => execFileSync("/bin/sh", ["-c", line], { stdio: "ignore" })).toThrow();
    expect(existsSync(marker)).toBe(false);
    execFileSync("/bin/sh", ["-c", `cd ${w.dir} && ${serverExecCommand(`true; touch ${marker}`)}`]);
    expect(existsSync(marker)).toBe(true);
  });
});

// Stands in for a runtime Tau does not own (the Agent SDK's): it reaches the tools only over MCP.
describe.skipIf(!posix)("the agent's server tools over Tau's MCP endpoint", () => {
  it("lists them for a server project's thread, asks before a command, refuses Git writes, never uploads", async () => {
    let answer = false;
    const questions: string[] = [];
    const endpoint = kitMcpEndpoint((_thread, title, message) => { questions.push(`${title} ${message.split("\n")[0]}`); return answer; });
    const w = world({ mcp: endpoint.mcp });
    const client = new Client({ name: "fake-runtime", version: "1.0.0" });
    try {
      await downloaded(w);
      put(w.local, "index.php", "<?php echo 'home, new';\n", 1_700_000_100);
      await w.agent.isServerProject(w.local);
      const connection = (await endpoint.mcp.connect({ sessionId: "sdk-thread", cwd: w.local }))!;
      await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { ...connection.headers } } }));
      expect(client.getInstructions()).toContain("<server_targets>");
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(Object.values(SERVER_TOOLS).sort());
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args }) as { content: Array<{ text?: string }>; isError?: boolean };
        return { text: result.content.map((part) => part.text ?? "").join(""), isError: result.isError === true };
      };

      expect(await call(SERVER_TOOLS.read, { path: "index.php" })).toMatchObject({ isError: false, text: expect.stringContaining("home") });
      expect(questions).toEqual([]);
      const declined = await call(SERVER_TOOLS.exec, { command: "ls" });
      expect(declined).toMatchObject({ isError: true, text: expect.stringContaining("did not allow server_exec") });
      expect(questions).toEqual(["Run on the server site? ls"]);
      answer = true;
      expect(await call(SERVER_TOOLS.exec, { command: "ls" })).toMatchObject({ isError: false, text: expect.stringContaining("index.php") });
      expect(await call(SERVER_TOOLS.exec, { command: "git commit -m x" })).toMatchObject({ isError: true, text: expect.stringContaining("`git commit`") });
      expect(questions).toHaveLength(2);

      const writes = writesIn(w.fs.calls).length;
      const proposal = parseUploadProposal((await call(SERVER_TOOLS.proposeUpload, {})).text)!;
      expect(proposal.threadId).toBe("sdk-thread");
      expect(proposal.files.map((file) => [file.path, file.outcome])).toEqual([["index.php", "upload"]]);
      expect(writesIn(w.fs.calls).length).toBe(writes);
      expect(readFileSync(join(w.server, "index.php"), "utf8")).toBe("<?php echo 'home';\n");
    } finally {
      await client.close().catch(() => undefined);
      await w.status.idle();
      w.status.dispose();
      await endpoint.close();
      rmSync(w.dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("the agent's server tools on an FTP target", () => {
  const target = (id: string, name: string, protocol: "sftp" | "ftp") => ({
    id, name, protocol, host: "127.0.0.1", port: protocol === "ftp" ? 21 : 22, username: "tester", remotePath: "/site", context: "", usable: true,
  }) as unknown as SftpJsonTarget;
  const agentFor = (targets: SftpJsonTarget[], transport: () => Promise<never>) => new ServerAgentTools({
    list: async () => ({ project: { root: "/p", workspaceId: "ws" }, targets }),
    transport,
    status: async () => { throw new Error("not used"); },
    preview: async () => { throw new Error("not used"); },
    targetLevel: async () => "full",
    threadLevel: async () => undefined,
    mirrorDir: () => "/nowhere",
    git: gitCall(),
  });

  it("offers no server_exec when every target is FTP, and refuses it on one in a mixed project without asking or connecting", async () => {
    const connect = async (): Promise<never> => { throw new Error("must not connect"); };
    const ftpOnly = agentFor([target("f", "files", "ftp")], connect);
    await ftpOnly.isServerProject("/p");
    const names = ftpOnly.tools({ sessionId: "t", cwd: "/p" }).map((tool) => tool.name);
    expect(names).not.toContain(SERVER_TOOLS.exec);
    expect(names).toContain(SERVER_TOOLS.putTmp);

    const mixed = agentFor([target("s", "site", "sftp"), target("f", "files", "ftp")], connect);
    await mixed.isServerProject("/p");
    const exec = mixed.tools({ sessionId: "t", cwd: "/p" }).find((tool) => tool.name === SERVER_TOOLS.exec)!;
    const asked: string[] = [];
    const verdict = await mixed.gate({ sessionId: "t", cwd: "/p" }, SERVER_TOOLS.exec, { command: "ls", target: "files" }, async (title) => { asked.push(title); return true; });
    expect(verdict).toMatchObject({ block: true, reason: expect.stringContaining("files is an FTP server: it runs no commands") });
    expect(asked).toEqual([]);
    await expect(exec.execute("c", { command: "ls", target: "files" }, undefined, undefined, undefined as never)).rejects.toThrow("runs no commands");
  });
});
