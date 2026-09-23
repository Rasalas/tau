import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findExecutable, type HostExtension, type HostMcpConnection, type HostRuntimeBackendProvider, type RuntimeSessionInfo } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { CodexAppServer, spawnInput } from "./app-server.js";
import createCodexHostExtension from "./host.js";
import { codexMcpLaunch, TAU_MCP_TOKEN_VARIABLE } from "./mcp.js";
import { codexToolArgs } from "./tools.js";
import { spawnRpcProcess } from "./rpc.js";
import { CodexSessionStore } from "./session-store.js";

const STUB = fileURLToPath(new URL("./fixtures/stub-app-server.mjs", import.meta.url));
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

/** A `codex` on the PATH that resolves into a Homebrew cask, as the real install does. */
async function caskInstall(root: string): Promise<string> {
  const real = join(root, "Caskroom", "codex", "0.154.0", "bin", "codex");
  await mkdir(join(root, "Caskroom", "codex", "0.154.0", "bin"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(real, "");
  await symlink(real, join(root, "bin", "codex"));
  return join(root, "bin", "codex");
}

const TAU_SERVER: HostMcpConnection = { name: "tau", url: "http://127.0.0.1:4100/mcp", token: "secret", headers: { Authorization: "Bearer secret" } };

async function harness(options: { installed?: string | undefined; found?: boolean; env?: NodeJS.ProcessEnv; settings?: unknown; install?: (root: string) => Promise<string> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tau-codex-host-"));
  directories.push(root);
  const path = await (options.install ?? caskInstall)(root);
  if (options.settings) {
    await mkdir(join(root, "state", "tau.codex"), { recursive: true });
    await writeFile(join(root, "state", "tau.codex", "settings.json"), JSON.stringify(options.settings));
  }
  const backends: HostRuntimeBackendProvider[] = [];
  const events: PublishedKitEvent[] = [];
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ version: "0.155.1" }) }) as Response);
  const launches: Array<{ threadId?: string; args: readonly string[]; env: NodeJS.ProcessEnv; instance: string }> = [];
  const connected: RuntimeSessionInfo[] = [];
  const connectOptions: unknown[] = [];
  const extension = createCodexHostExtension({
    env: options.env ?? {},
    fetch,
    readVersion: async () => "installed" in options ? options.installed : "0.154.0",
    openSession: (input) => (launches.push({ ...(input.threadId ? { threadId: input.threadId } : {}), args: input.args, env: input.env, instance: input.instance }), CodexAppServer.open({
      command: process.execPath,
      cwd: input.cwd,
      env: { ...process.env, CODEX_HOME: join(root, "home") },
      clientVersion: "test",
      spawn: (spawn) => spawnRpcProcess({ ...spawn, args: [STUB, ...spawn.args] }),
      onNotification: input.onNotification,
      onRequest: input.onRequest,
      onExit: input.onExit,
    })),
  });
  const registry = await activateHostKit(extension, {
    mcp: { registerTools: () => () => undefined, gate: () => () => undefined, connect: async (thread, narrowed) => { connected.push(thread); connectOptions.push(narrowed); return TAU_SERVER; } },
    findCommand: (name) => name === "codex" ? (options.found !== false ? path : undefined) : findExecutable(name),
    sessionsDir: join(root, "agent", "sessions"),
    stateDir: join(root, "state"),
    noteSubprocess: () => undefined,
    registerRuntimeBackend: (provider) => {
      backends.push(provider);
      return () => { backends.splice(backends.indexOf(provider), 1); };
    },
  }, (event) => events.push(event));
  const backend = (kind: string) => backends.find((entry) => entry.kind === kind);
  return { registry, provider: backends[0]!, backend, backends, events, root, fetch, launches, connected, connectOptions };
}

const context = { projectName: "repo", permissionLevel: () => "full", onMessage: () => undefined, onEvent: () => undefined, ask: async () => ({ cancelled: true }) } as never;

describe("Codex host half", () => {
  it("registers a Codex backend that asks for approvals and takes files", async () => {
    const { provider } = await harness();
    expect(provider).toMatchObject({ kind: "codex", label: "Codex", modelProvider: "openai" });
    expect(provider.adapter.capabilities).toMatchObject({ skillInvocationDialect: "codex", interactiveApprovals: true, fileAttachments: true });
    expect(provider.composerCommands("/repo")).toEqual([]);
  });

  it("starts a thread's app-server with Tau's MCP server and its credential, and a probe without", async () => {
    const { provider, registry, launches, connected, root } = await harness();
    await registry.invoke("tau.codex", "status");
    expect(launches).toEqual([expect.objectContaining({ args: [] })]);
    expect(launches[0]!.env[TAU_MCP_TOKEN_VARIABLE]).toBeUndefined();

    const backend = await provider.open("tau-thread", root, { resume: false }, context);
    try {
      await backend.prompt({ text: "Reply with one word.", delivery: "prompt", identity: { clientMessageId: "m1", clientTurnId: "t1" } });
    } finally {
      await backend.dispose();
    }
    expect(connected).toEqual([{ sessionId: "tau-thread", cwd: root }]);
    const thread = launches[1]!;
    expect(thread.threadId).toBe("tau-thread");
    expect(thread.args).toEqual(codexMcpLaunch(TAU_SERVER).args);
    expect(thread.args).toContain('mcp_servers.tau.url="http://127.0.0.1:4100/mcp"');
    // The token travels in the environment, never on the command line.
    expect(thread.args.join(" ")).not.toContain("secret");
    expect(thread.env[TAU_MCP_TOKEN_VARIABLE]).toBe("secret");
  });

  it("starts a thread created with a tool list without the Codex tools it leaves out, also after a resume", async () => {
    const { provider, launches, connectOptions, root } = await harness();
    expect(provider.restrictsTools).toBe(true);
    const tools = ["read", "tau_spawn_thread"];
    const created = await provider.open("tau-thread", root, { resume: false, tools }, context);
    await created.prompt({ text: "Reply with one word.", delivery: "prompt" });
    await created.dispose();
    const resumed = await provider.open("tau-thread", root, { resume: true }, context);
    await resumed.prompt({ text: "Again.", delivery: "prompt" });
    await resumed.dispose();

    for (const launch of launches) {
      expect(launch.args).toEqual([...codexMcpLaunch(TAU_SERVER).args, ...codexToolArgs(tools)]);
      // Reading keeps Codex's shell; what the list leaves out is switched off.
      expect(launch.args).not.toContain("features.shell_tool=false");
      expect(launch.args).toContain('web_search="disabled"');
    }
    expect(launches).toHaveLength(2);
    expect(connectOptions).toEqual([{ tools }, { tools }]);
    expect(codexToolArgs(["tau_list_threads"])).toContain("features.shell_tool=false");
  });

  it("puts the overrides after app-server, where the CLI reads them", () => {
    const { args } = codexMcpLaunch(TAU_SERVER);
    expect(spawnInput("codex", "/repo", {}, args).args).toEqual(["app-server", ...args]);
    expect(spawnInput("codex", "/repo", {}).args).toEqual(["app-server"]);
  });

  it("reports the installed and newest version and the command of the package manager that owns the CLI", async () => {
    const { provider, fetch } = await harness();
    await expect(provider.version!()).resolves.toEqual({ tool: "codex", installed: "0.154.0", latest: "0.155.1", updateCommand: "brew upgrade --cask codex" });
    await provider.version!();
    // The registry is asked once a day, not once per question.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses to open a thread on a CLI older than the protocol it speaks, or on none", async () => {
    const old = await harness({ installed: "0.150.0" });
    await expect(old.provider.open("t", "/repo", { resume: false }, context)).rejects.toThrow("Codex 0.150.0 is older than 0.154.0, the oldest release Tau speaks to. Update it with: brew upgrade --cask codex");
    const missing = await harness({ found: false });
    await expect(missing.provider.open("t", "/repo", { resume: false }, context)).rejects.toThrow("was not found on the PATH");
    await expect(missing.registry.invoke("tau.codex", "status")).resolves.toMatchObject({ command: "codex", message: expect.stringContaining("Settings → Providers") });
  });

  it("reports the CLI, its update and the account it is signed in as", async () => {
    const { registry, root } = await harness();
    await expect(registry.invoke("tau.codex", "status")).resolves.toEqual({
      instance: "default",
      command: "codex",
      path: join(root, "bin", "codex"),
      version: "0.154.0",
      latest: "0.155.1",
      updateCommand: "brew upgrade --cask codex",
      updateAvailable: true,
      account: { kind: "chatgpt", plan: "pro" },
      signedIn: true,
      models: 5,
      codexHome: join(root, "home"),
    });
  });

  it("keeps a path set on the Providers card, refuses one that is no executable, and lets the environment win", async () => {
    const { registry, root } = await harness({ found: false });
    const path = join(root, "bin", "codex");
    await expect(registry.invoke("tau.codex", "set-command", { command: join(root, "nothing") })).rejects.toThrow("No executable");
    await expect(registry.invoke("tau.codex", "status")).resolves.toMatchObject({ command: "codex", message: expect.stringContaining("not found") });
    await chmod(path, 0o755);
    await expect(registry.invoke("tau.codex", "set-command", { command: path })).resolves.toEqual({ command: path });
    await expect(registry.invoke("tau.codex", "status")).resolves.toMatchObject({ command: path, commandSource: "setting", version: "0.154.0" });
    expect(JSON.parse(await readFile(join(root, "state", "tau.codex", "settings.json"), "utf8"))).toEqual({ command: path });
    await registry.invoke("tau.codex", "set-command", { command: "" });
    await expect(registry.invoke("tau.codex", "status")).resolves.toMatchObject({ command: "codex" });

    const pinned = await harness({ env: { TAU_CODEX_COMMAND: path } });
    await expect(pinned.registry.invoke("tau.codex", "status")).resolves.toMatchObject({ command: path, commandSource: "env" });
    await expect(pinned.registry.invoke("tau.codex", "set-command", { command: "" })).rejects.toThrow("TAU_CODEX_COMMAND is set");
  });

  it("hands each thread's running total to the Usage kit and to no other kit", async () => {
    const { registry, root } = await harness();
    const store = new CodexSessionStore({ filePath: CodexSessionStore.defaultPath(join(root, "agent", "sessions")) });
    await store.recordUsage("thread-1", "/repo", { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 0, totalTokens: 17, costUsd: 0, turns: 1 });
    await store.setObservedModel("thread-1", "/repo", "gpt-5.6-luna");
    const reader = (id: string): HostExtension & { read?: () => Promise<unknown> } => {
      const extension: HostExtension & { read?: () => Promise<unknown> } = { id, name: id, activate(activation) { extension.read = () => activation.invokeHostExtension("tau.codex", "usage"); } };
      return extension;
    };
    const usageKit = reader("tau.usage");
    const stranger = reader("acme.stranger");
    await registry.activate(usageKit);
    await registry.activate(stranger);
    await expect(usageKit.read!()).resolves.toMatchObject({ threads: [{ threadId: "thread-1", cwd: "/repo", model: "gpt-5.6-luna", usage: { totalTokens: 17, turns: 1 } }] });
    await expect(stranger.read!()).rejects.toThrow("Caller acme.stranger is not allowed to invoke tau.codex/usage.");
  });

  it("registers a backend per instance that runs its own home, variables and arguments, and keeps each thread on its instance", async () => {
    const { registry, backend, backends, events, launches, root } = await harness();
    const home = join(root, "work-home");
    const saved = await registry.invoke("tau.codex", "save-instance", { instance: { id: "work", name: "Work", home, env: { CODEX_EXTRA: "1" }, args: "-c 'model_verbosity=\"low\"'" } });
    expect(saved).toMatchObject({ instances: [{ id: "default", kind: "codex", label: "Codex" }, { id: "work", kind: "codex@work", label: "Codex · Work", home, threads: 0 }] });
    expect(events.map((event) => event.name)).toEqual(["instances"]);
    const work = backend("codex@work")!;
    expect(work).toMatchObject({ label: "Codex · Work", modelProvider: "openai" });
    expect(work.adapter.id).toBe("codex@work");

    const thread = await work.open("work-thread", root, { resume: false }, context);
    try {
      await thread.prompt({ text: "Reply with one word.", delivery: "prompt" });
    } finally {
      await thread.dispose();
    }
    const launch = launches.find((entry) => entry.threadId === "work-thread")!;
    expect(launch.instance).toBe("work");
    expect(launch.env.CODEX_HOME).toBe(home);
    expect(launch.env.CODEX_EXTRA).toBe("1");
    expect(launch.args.slice(-2)).toEqual(["-c", 'model_verbosity="low"']);
    expect(thread.kind).toBe("codex@work");
    await expect(work.listThreads()).resolves.toEqual([expect.objectContaining({ threadId: "work-thread" })]);
    await expect(backend("codex")!.listThreads()).resolves.toEqual([]);
    await expect(backend("codex")!.lookup("work-thread")).resolves.toBeUndefined();
    await expect(registry.invoke("tau.codex", "instances")).resolves.toMatchObject({ instances: [{ id: "default", threads: 0 }, { id: "work", threads: 1 }] });

    await registry.invoke("tau.codex", "remove-instance", { instance: "work" });
    expect(backends.map((entry) => entry.kind)).toEqual(["codex"]);
    // The thread is only out of the list: an instance with the same id brings it back.
    await registry.invoke("tau.codex", "save-instance", { instance: { id: "work", home } });
    await expect(backend("codex@work")!.listThreads()).resolves.toEqual([expect.objectContaining({ threadId: "work-thread" })]);
    await expect(registry.invoke("tau.codex", "remove-instance", { instance: "default" })).rejects.toThrow("cannot be removed");
    await expect(registry.invoke("tau.codex", "save-instance", { instance: { id: "Bad Id" } })).rejects.toThrow("starts with a letter");
  });

  it("reads a settings file from before instances as the default instance and keeps its shape", async () => {
    const found = await harness();
    const path = join(found.root, "bin", "codex");
    await chmod(path, 0o755);
    const { registry, root } = await harness({ settings: { command: path } });
    await expect(registry.invoke("tau.codex", "status")).resolves.toMatchObject({ instance: "default", command: path, commandSource: "setting" });
    await registry.invoke("tau.codex", "save-instance", { instance: { id: "second", name: "Second" } });
    expect(JSON.parse(await readFile(join(root, "state", "tau.codex", "settings.json"), "utf8"))).toEqual({ command: path, instances: [{ id: "second", name: "Second" }] });
  });

  it("judges the CLI by its version policy, names the release to install and refuses a broken one", async () => {
    const policy = { codex: { ranges: [{ range: ">=0.154.0 <0.156.0", status: "unsafe" }, { range: "~0.157.0 || =0.158.0", status: "broken" }], recommendedVersion: "0.160.0" } };
    const npmInstall = async (root: string) => {
      const real = join(root, "lib", "node_modules", "@openai", "codex", "bin", "codex.js");
      await mkdir(join(root, "lib", "node_modules", "@openai", "codex", "bin"), { recursive: true });
      await mkdir(join(root, "bin"), { recursive: true });
      await writeFile(real, "");
      await symlink(real, join(root, "bin", "codex"));
      return join(root, "bin", "codex");
    };
    const unsafe = await harness({ env: { TAU_VERSION_POLICY: JSON.stringify(policy) }, install: npmInstall });
    await expect(unsafe.provider.version!()).resolves.toMatchObject({
      installed: "0.154.0",
      compatibility: { status: "unsafe", recommendedVersion: "0.160.0", installCommand: "npm install -g @openai/codex@0.160.0" },
    });
    await expect(unsafe.registry.invoke("tau.codex", "status")).resolves.toMatchObject({ compatibility: { status: "unsafe" } });
    // Unsafe warns; a thread still starts.
    const thread = await unsafe.provider.open("t", unsafe.root, { resume: false }, context);
    await thread.dispose();

    // Homebrew cannot pin a release, so there is no install command, only the update.
    const cask = await harness({ env: { TAU_VERSION_POLICY: JSON.stringify(policy) } });
    await expect(cask.provider.version!()).resolves.toMatchObject({ compatibility: { status: "unsafe", recommendedVersion: "0.160.0" }, updateCommand: "brew upgrade --cask codex" });
    expect((await cask.provider.version!())?.compatibility?.installCommand).toBeUndefined();

    const broken = await harness({ installed: "0.157.2", env: { TAU_VERSION_POLICY: JSON.stringify(policy) }, install: npmInstall });
    await expect(broken.provider.open("t", "/repo", { resume: false }, context)).rejects.toThrow("Codex 0.157.2 does not work with Tau. Install 0.160.0 with: npm install -g @openai/codex@0.160.0");
    await expect(broken.registry.invoke("tau.codex", "status")).resolves.toMatchObject({ unsupported: true, compatibility: { status: "broken" } });

    // Without an override the bundled policy only calls a CLI older than the protocol broken.
    const current = await harness({ installed: "0.155.1" });
    expect((await current.provider.version!())?.compatibility).toBeUndefined();
    const old = await harness({ installed: "0.150.0" });
    await expect(old.provider.version!()).resolves.toMatchObject({ compatibility: { status: "broken", recommendedVersion: "0.154.0" } });
  });
});
