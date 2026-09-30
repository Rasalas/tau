import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnActivityStore, findExecutable, type HostExtension, type HostMcpConnection, type HostRuntimeBackendProvider, type RuntimeSessionInfo } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { CodexAppServer, spawnInput } from "./app-server.js";
import createCodexHostExtension, { codexNewThreadCatalog } from "./host.js";
import { codexMcpLaunch, TAU_MCP_TOKEN_VARIABLE } from "./mcp.js";
import { codexToolArgs } from "./tools.js";
import { spawnRpcProcess } from "./rpc.js";
import { ChatGPTPlanStore } from "./chatgpt-plan-store.js";
import { CHATGPT_PLAN_ARGS } from "./chatgpt-plan.js";
import { CodexSessionStore } from "./session-store.js";
import { MANAGED_CODEX_VERSION } from "./managed-install.js";
import type { ManagedCodexAsset } from "./managed-release.js";
import { MANAGED_CODEX_EVENT, type CodexStatusReport, type ManagedCodexState } from "./protocol.js";
import { createHash } from "node:crypto";
import { create } from "tar";

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

/** A package shaped like the pinned release, served in place of GitHub's. */
async function managedFixture(): Promise<{ asset: ManagedCodexAsset; archive: Uint8Array }> {
  const root = await mkdtemp(join(tmpdir(), "tau-codex-package-"));
  directories.push(root);
  const entrypoint = `bin/codex${process.platform === "win32" ? ".exe" : ""}`;
  await mkdir(join(root, "source", "bin"), { recursive: true });
  await writeFile(join(root, "source", entrypoint), "fixture codex");
  await chmod(join(root, "source", entrypoint), 0o755);
  await writeFile(join(root, "source", "codex-package.json"), JSON.stringify({ version: MANAGED_CODEX_VERSION, target: "fixture-target", entrypoint }));
  await create({ file: join(root, "package.tar.gz"), cwd: join(root, "source"), gzip: true, portable: true }, ["bin", "codex-package.json"]);
  const archive = await readFile(join(root, "package.tar.gz"));
  return { archive, asset: { target: "fixture-target", bytes: archive.length, sha256: createHash("sha256").update(archive).digest("hex") } };
}

const TAU_SERVER: HostMcpConnection = { name: "tau", url: "http://127.0.0.1:4100/mcp", token: "secret", headers: { Authorization: "Bearer secret" } };

async function harness(options: { installed?: string | undefined; found?: boolean; env?: NodeJS.ProcessEnv; settings?: unknown; install?: (root: string) => Promise<string>; before?: (root: string) => Promise<void>; managed?: { asset: ManagedCodexAsset; archive: Uint8Array } } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tau-codex-host-"));
  directories.push(root);
  const path = await (options.install ?? caskInstall)(root);
  if (options.settings) {
    await mkdir(join(root, "state", "tau.codex"), { recursive: true });
    await writeFile(join(root, "state", "tau.codex", "settings.json"), JSON.stringify(options.settings));
  }
  await options.before?.(root);
  const backends: HostRuntimeBackendProvider[] = [];
  const events: PublishedKitEvent[] = [];
  const fetch = vi.fn(async (url?: string | URL | Request) => String(url).startsWith("https://github.com/openai/codex/releases/") && options.managed
    ? new Response(new Uint8Array(options.managed.archive))
    : ({ ok: true, json: async () => ({ version: "0.155.1" }) }) as Response);
  const launches: Array<{ threadId?: string; args: readonly string[]; env: NodeJS.ProcessEnv; instance: string }> = [];
  const connected: RuntimeSessionInfo[] = [];
  const connectOptions: unknown[] = [];
  // Never the user's own ~/.codex: the default instance's home is the scratch folder's.
  const extension = createCodexHostExtension({
    env: options.env ?? { CODEX_HOME: join(root, "home") },
    fetch: fetch as typeof globalThis.fetch,
    ...(options.managed ? { managedAsset: options.managed.asset } : {}),
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
    expect(provider).toMatchObject({ kind: "codex", label: "Codex", modelProvider: "openai", homeProviders: ["openai"] });
    expect(provider.adapter.capabilities).toMatchObject({ skillInvocationDialect: "codex", interactiveApprovals: true, fileAttachments: true });
    expect(provider.composerCommands("/repo")).toEqual([]);
  });

  it("moves a thread's tool cards to the trash with its record and back", async () => {
    const { provider, root } = await harness();
    const dir = join(root, "agent", "tau");
    await new CodexSessionStore({ filePath: join(dir, "codex-runtime-sessions.json") }).ensure("tau-9", "/repo");
    await new TurnActivityStore({ directory: join(dir, "codex-activity") }).save("tau-9", { id: "activity-1", status: "completed", tools: [{ id: "a", name: "bash", args: {}, status: "done", startedAt: 1 }] });
    const taken = await provider.removeThread!("tau-9") as { tauThreadId: string; activity?: string };
    expect(taken).toMatchObject({ tauThreadId: "tau-9", activity: expect.stringContaining("\"a\"") });
    expect(await new TurnActivityStore({ directory: join(dir, "codex-activity") }).load("tau-9")).toEqual([]);
    await provider.restoreThread!("tau-9", JSON.parse(JSON.stringify(taken)));
    expect((await new TurnActivityStore({ directory: join(dir, "codex-activity") }).load("tau-9")).map((entry) => entry.tools[0]!.id)).toEqual(["a"]);
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
    // npm and, for a cask, Homebrew are each asked once a day, not once per question.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map((call: unknown[]) => String(call[0]))).toEqual(["https://registry.npmjs.org/@openai/codex/latest", "https://formulae.brew.sh/api/cask/codex.json"]);
  });

  it("reads the CLI again on recheck and registers its backend anew, so core asks the version too", async () => {
    const options: { installed?: string } = { installed: "0.154.0" };
    const { registry, backends, provider } = await harness(options);
    await expect(provider.version!()).resolves.toMatchObject({ installed: "0.154.0" });
    options.installed = "0.155.1";
    // Read once per path until something says the CLI changed.
    await expect(provider.version!()).resolves.toMatchObject({ installed: "0.154.0" });
    await expect(registry.invoke("tau.codex", "recheck", { instance: "default" })).resolves.toMatchObject({ installed: "0.155.1", latest: "0.155.1" });
    expect(backends).toHaveLength(1);
    expect(backends[0]).not.toBe(provider);
    await expect(registry.invoke("tau.codex", "recheck", { instance: "nope" })).rejects.toThrow("no instance");
  });

  it("reads a CLI replaced in place again, and says how it is installed and what updates it", async () => {
    const options: { installed?: string } = { installed: "0.154.0" };
    const { provider, root } = await harness(options);
    const key = await provider.programKey!();
    await expect(provider.version!()).resolves.toMatchObject({ installed: "0.154.0" });
    options.installed = "0.155.1";
    // An update rewrites the file: same path, another fingerprint.
    const real = join(root, "Caskroom", "codex", "0.154.0", "bin", "codex");
    await writeFile(real, "a newer codex");
    await utimes(real, new Date(), new Date(Date.now() + 5_000));
    expect(await provider.programKey!()).not.toBe(key);
    await expect(provider.version!()).resolves.toMatchObject({ installed: "0.155.1" });
    await expect(provider.maintenance!()).resolves.toMatchObject({ tool: "codex", installed: "0.155.1", install: { method: "homebrew-cask", label: "Homebrew cask codex" } });
  });

  it("names the update command TAU_RUNTIME_UPDATE_COMMAND gives, for a test instance", async () => {
    const { provider } = await harness({ env: { CODEX_HOME: "/nonexistent", TAU_RUNTIME_UPDATE_COMMAND: JSON.stringify({ codex: "/tmp/stub-update.sh" }) } });
    await expect(provider.version!()).resolves.toMatchObject({ updateCommand: "/tmp/stub-update.sh" });
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
      account: { kind: "chatgpt", plan: "pro", email: "stub@example.com" },
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
    await store.setCodexThread("thread-1", "/repo", "codex-thread-1");
    const reader = (id: string): HostExtension & { read?: () => Promise<unknown> } => {
      const extension: HostExtension & { read?: () => Promise<unknown> } = { id, name: id, activate(activation) { extension.read = () => activation.invokeHostExtension("tau.codex", "usage"); } };
      return extension;
    };
    const usageKit = reader("tau.usage");
    const stranger = reader("acme.stranger");
    await registry.activate(usageKit);
    await registry.activate(stranger);
    await expect(usageKit.read!()).resolves.toMatchObject({ threads: [{ threadId: "thread-1", sessionId: "codex-thread-1", cwd: "/repo", model: "gpt-5.6-luna", usage: { totalTokens: 17, turns: 1 } }] });
    await expect(stranger.read!()).rejects.toThrow("Caller acme.stranger is not allowed to invoke tau.codex/usage.");
  });

  it("names each instance's log folders for the Usage kit, from the instance's own home", async () => {
    const { registry, root } = await harness();
    await registry.invoke("tau.codex", "save-instance", { instance: { id: "work", home: join(root, "work-home") } });
    let read: (() => Promise<unknown>) | undefined;
    await registry.activate({ id: "tau.usage", name: "Usage", activate(activation) { read = () => activation.invokeHostExtension("tau.codex", "usage-logs"); } });
    await expect(read!()).resolves.toEqual({ folders: [
      { format: "codex", path: join(root, "home", "sessions"), instance: "codex" },
      { format: "codex", path: join(root, "home", "archived_sessions"), instance: "codex" },
      { format: "codex", path: join(root, "work-home", "sessions"), instance: "codex@work" },
      { format: "codex", path: join(root, "work-home", "archived_sessions"), instance: "codex@work" },
    ] });
  });

  it("hands what each thread said to Search Kit, only what it does not hold, and to no other kit", async () => {
    const { registry, root } = await harness();
    const store = new CodexSessionStore({ filePath: CodexSessionStore.defaultPath(join(root, "agent", "sessions")) });
    await store.appendMessages("thread-1", "/repo", [{ id: "m1", role: "user", text: "Where is the luna launch?", timestamp: 1 }, { id: "m2", role: "assistant", text: "On Friday.", timestamp: 2 }]);
    const reader = (id: string): HostExtension & { read?: (input: unknown) => Promise<unknown> } => {
      const extension: HostExtension & { read?: (input: unknown) => Promise<unknown> } = { id, name: id, activate(activation) { extension.read = (input) => activation.invokeHostExtension("tau.codex", "thread-texts", input); } };
      return extension;
    };
    const search = reader("tau.search");
    const stranger = reader("acme.stranger");
    await registry.activate(search);
    await registry.activate(stranger);
    const answer = await search.read!({}) as { threads: Array<{ threadId: string; updatedAt: number; messages: unknown[] }> };
    expect(answer).toMatchObject({ threads: [{ threadId: "thread-1", messages: [{ role: "user", text: "Where is the luna launch?" }, { role: "assistant", text: "On Friday." }] }], removed: [], more: false });
    await expect(search.read!({ known: { "thread-1": answer.threads[0]!.updatedAt, gone: 1 } })).resolves.toEqual({ threads: [], removed: ["gone"], more: false });
    await expect(stranger.read!({})).rejects.toThrow("Caller acme.stranger is not allowed to invoke tau.codex/thread-texts.");
  });

  it("reads the account's quota windows for the Usage kit without changing the account, and keeps them a while", async () => {
    const { registry, root } = await harness();
    // A made-up ChatGPT login in the stub's CODEX_HOME: the account shows as a hash only.
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(join(root, "home", "auth.json"), JSON.stringify({ tokens: { access_token: `${part({ alg: "none" })}.${part({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-fixture-1", chatgpt_user_id: "user-fixture-1" } })}.fixture`, account_id: "acct-fixture-1" } }));
    let read: (() => Promise<unknown>) | undefined;
    await registry.activate({ id: "tau.usage", name: "Usage", activate(activation) { read = () => activation.invokeHostExtension("tau.codex", "usage-limits"); } });
    const answer = await read!() as { accounts: Array<Record<string, unknown>> };
    expect(answer.accounts).toEqual([expect.objectContaining({
      runtime: "codex",
      label: "Codex",
      plan: "pro",
      windows: [expect.objectContaining({ id: "primary", usedPercent: 34 }), expect.objectContaining({ id: "secondary", usedPercent: 12.5 })],
      identity: { provider: "openai", key: "6aebdfd5da11cc4ac9092578eb4af5ffb0b9d3a3dee6976ae83ed5354ce94131" },
    })]);
    expect(JSON.stringify(answer)).not.toMatch(/fixture/u);
    const again = await read!() as { accounts: Array<{ checkedAt: number }> };
    expect(again.accounts[0]?.checkedAt).toBe(answer.accounts[0]?.checkedAt);
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

  it("offers a draft the account's models, starting on the home's config.toml model and effort", async () => {
    const { provider, root } = await harness();
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(join(root, "home", "config.toml"), 'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"\n');
    const catalog = await provider.newThreadCatalog!();
    // A ChatGPT login is the subscription; price and context are the host's to fill in.
    expect(catalog?.model).toEqual({ provider: "openai", id: "gpt-5.6-luna", name: expect.any(String), billing: "subscription", images: true, reasoning: true });
    expect(catalog?.models.map((model) => model.id)).toContain("gpt-6-astra");
    expect(catalog?.thinkingLevels["gpt-5.6-luna"]?.[0]).toBe("default (low)");
    expect(catalog?.thinkingLevels["gpt-6-astra"]).toEqual(["default (low)", "low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  it("says the CLI is missing or signed out instead of listing nothing", async () => {
    const missing = await harness({ found: false });
    await expect(missing.provider.newThreadCatalog!()).resolves.toMatchObject({ models: [], status: "not-installed" });
    const { provider, root } = await harness();
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(join(root, "home", "signed-out"), "");
    await expect(provider.newThreadCatalog!()).resolves.toMatchObject({ models: [], status: "sign-in-required" });
  });

  it("starts a draft's thread on the model and effort it chose", async () => {
    const { provider, root } = await harness();
    const backend = await provider.open("draft-thread", root, { resume: false }, context);
    try {
      await backend.capabilities.catalogWrite!.setModel("openai", "gpt-5.6-luna");
      await backend.capabilities.catalogWrite!.setThinkingLevel("low");
      expect(backend.catalogView()).toMatchObject({ model: { id: "gpt-5.6-luna" }, thinkingLevel: "low" });
    } finally {
      await backend.dispose();
    }
  });

  it("names the account's default model when config.toml names none or one the account lacks", () => {
    const models = [{ id: "a", name: "A", efforts: ["low"], defaultEffort: "low" }, { id: "b", name: "B", efforts: ["high"], isDefault: true }];
    expect(codexNewThreadCatalog(models, {})).toEqual({
      models: [{ provider: "openai", id: "a", name: "A", reasoning: true }, { provider: "openai", id: "b", name: "B", reasoning: true }],
      model: { provider: "openai", id: "b", name: "B", reasoning: true },
      thinkingLevels: { a: ["default (low)", "low"], b: ["default", "high"] },
    });
    expect(codexNewThreadCatalog(models, { model: "gone" }).model?.id).toBe("b");
    expect(codexNewThreadCatalog([], {})).toEqual({ models: [], thinkingLevels: {} });
    expect(codexNewThreadCatalog(models, {}, "api-key").models[0]).toMatchObject({ billing: "api-key" });
  });

  describe("signing in from the window", () => {
    type Flow = { flowId: string; phase: string; browser?: { url: string }; deviceCode?: { url: string; code: string }; terminal?: { command: string }; prompt?: { id: string; kind: string }; message?: string };
    type Report = { methods: Array<{ id: string; unavailable?: string }>; account?: { signedIn: boolean; label?: string; detail?: string }; flow?: Flow };
    const signInEvents = (events: PublishedKitEvent[]) => events.filter((event) => event.name === "sign-in").map((event) => event.payload as { target: string; flow?: Flow; report?: Report });
    const flowEvent = async (events: PublishedKitEvent[], test: (flow: Flow) => boolean) => {
      let found: Flow | undefined;
      await vi.waitFor(() => {
        found = signInEvents(events).map((event) => event.flow ?? event.report?.flow).find((flow) => flow !== undefined && test(flow));
        expect(found).toBeDefined();
      }, { timeout: 10_000 });
      return found!;
    };
    const finalReport = async (events: PublishedKitEvent[], flowId: string) => {
      let found: Report | undefined;
      await vi.waitFor(() => {
        found = signInEvents(events).map((event) => event.report).find((report) => report?.flow?.flowId === flowId);
        expect(found).toBeDefined();
      }, { timeout: 10_000 });
      return found!;
    };

    it("reports the account and the plan and CLI ways to sign in, and signs out through the CLI", async () => {
      const { registry, provider, root, events } = await harness();
      const report = await registry.invoke("tau.codex", "sign-in-state") as Report;
      expect(report.methods.map((method) => method.id)).toEqual(["chatgpt-plan", "chatgpt", "device", "api-key", "terminal"]);
      expect(report.account).toMatchObject({ signedIn: true, label: "stub@example.com", detail: "ChatGPT Pro" });

      const after = await registry.invoke("tau.codex", "sign-out") as Report & { note?: string };
      expect(after).toMatchObject({ account: { signedIn: false }, note: "Signed out of Codex." });
      await expect(readFile(join(root, "home", "signed-out"), "utf8")).resolves.toBe("");
      expect(signInEvents(events).at(-1)?.report?.account?.signedIn).toBe(false);
      // The backend was registered anew, so the catalog asks the signed-out CLI.
      await expect(provider.newThreadCatalog!()).resolves.toMatchObject({ status: "sign-in-required" });
    });

    it("signs in with ChatGPT through the page Codex serves and finishes when the browser comes back", async () => {
      const { registry, root, events } = await harness();
      await mkdir(join(root, "home"), { recursive: true });
      await writeFile(join(root, "home", "signed-out"), "");
      const started = await registry.invoke("tau.codex", "sign-in", { method: "chatgpt" }) as Flow;
      const waiting = await flowEvent(events, (flow) => flow.flowId === started.flowId && flow.browser !== undefined);
      expect(waiting.browser!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize/u);
      await fetch(waiting.browser!.url).then((response) => response.text());
      const report = await finalReport(events, started.flowId);
      expect(report.flow).toMatchObject({ phase: "succeeded", message: "Signed in as stub@example.com." });
      expect(report.account).toMatchObject({ signedIn: true });
    });

    it("shows a device code, and cancels a login the user abandons", async () => {
      const { registry, root, events } = await harness();
      await mkdir(join(root, "home"), { recursive: true });
      await writeFile(join(root, "home", "signed-out"), "");
      const started = await registry.invoke("tau.codex", "sign-in", { method: "device" }) as Flow;
      const waiting = await flowEvent(events, (flow) => flow.flowId === started.flowId && flow.deviceCode !== undefined);
      expect(waiting.deviceCode).toMatchObject({ code: "STUB-CODE", url: expect.stringMatching(/\/device$/u) });
      const cancelled = await registry.invoke("tau.codex", "sign-in-cancel", { flowId: started.flowId }) as Flow;
      expect(cancelled.phase).toBe("cancelled");
      await expect(readFile(join(root, "home", "signed-out"), "utf8")).resolves.toBe("");

      const again = await registry.invoke("tau.codex", "sign-in", { method: "device" }) as Flow;
      const code = await flowEvent(events, (flow) => flow.flowId === again.flowId && flow.deviceCode !== undefined);
      await fetch(code.deviceCode!.url).then((response) => response.text());
      expect((await finalReport(events, again.flowId)).account).toMatchObject({ signedIn: true });
    });

    it("hands a typed key to Codex and says when Codex refuses it", async () => {
      const { registry, root, events } = await harness();
      await mkdir(join(root, "home"), { recursive: true });
      await writeFile(join(root, "home", "signed-out"), "");
      const refused = await registry.invoke("tau.codex", "sign-in", { method: "api-key" }) as Flow;
      const asked = await flowEvent(events, (flow) => flow.flowId === refused.flowId && flow.prompt !== undefined);
      expect(asked.prompt).toMatchObject({ kind: "secret" });
      await registry.invoke("tau.codex", "sign-in-respond", { flowId: refused.flowId, value: "sk-wrong" });
      expect((await finalReport(events, refused.flowId)).flow).toMatchObject({ phase: "failed", message: expect.stringContaining("The API key was refused.") });

      const taken = await registry.invoke("tau.codex", "sign-in", { method: "api-key" }) as Flow;
      await flowEvent(events, (flow) => flow.flowId === taken.flowId && flow.prompt !== undefined);
      await registry.invoke("tau.codex", "sign-in-respond", { flowId: taken.flowId, value: "sk-stub-good" });
      expect((await finalReport(events, taken.flowId)).account).toMatchObject({ signedIn: true, label: "API key" });
    });

    it("gives the terminal codex login for the instance's home and checks the account when it ends", async () => {
      const { registry, root, events } = await harness();
      await mkdir(join(root, "home"), { recursive: true });
      await writeFile(join(root, "home", "signed-out"), "");
      const started = await registry.invoke("tau.codex", "sign-in", { method: "terminal" }) as Flow;
      const waiting = await flowEvent(events, (flow) => flow.flowId === started.flowId && flow.prompt !== undefined);
      expect(waiting.terminal?.command).toMatch(new RegExp(`^CODEX_HOME=${join(root, "home").replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")} \\S+/bin/codex login$`, "u"));
      await registry.invoke("tau.codex", "sign-in-respond", { flowId: started.flowId, value: "0" });
      expect((await finalReport(events, started.flowId)).flow).toMatchObject({ phase: "failed", message: "Codex still reports no account." });

      const again = await registry.invoke("tau.codex", "sign-in", { method: "terminal" }) as Flow;
      await flowEvent(events, (flow) => flow.flowId === again.flowId && flow.prompt !== undefined);
      await rm(join(root, "home", "signed-out"));
      await registry.invoke("tau.codex", "sign-in-respond", { flowId: again.flowId, value: "0" });
      expect((await finalReport(events, again.flowId)).flow).toMatchObject({ phase: "succeeded" });
    });

    it("offers managed ChatGPT sign-in while the CLI is missing", async () => {
      const { registry } = await harness({ found: false });
      const report = await registry.invoke("tau.codex", "sign-in-state") as Report;
      expect(report.methods[0]).toMatchObject({ id: "chatgpt-plan" });
      expect(report.methods[0]!.unavailable).toBeUndefined();
      expect(report.methods.slice(1).every((method) => method.unavailable?.startsWith("Install Codex first"))).toBe(true);
      await expect(registry.invoke("tau.codex", "sign-in", { method: "chatgpt" })).rejects.toThrow(/Install Codex first/u);
    });
  });

  it("lists what each thread cost from its store, without opening it", async () => {
    const { provider, root } = await harness();
    const turn = (model: string, at: number) => ({ provider: "openai", model, billing: "subscription", inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 4_000, cacheWriteTokens: 0, totalTokens: 5_100, costUsd: 0, turns: 1, at });
    const total = { inputTokens: 2_000, outputTokens: 200, cacheReadTokens: 8_000, cacheWriteTokens: 0, totalTokens: 10_200, costUsd: 0, turns: 2 };
    const thread = (tauThreadId: string, extra: Record<string, unknown>) => ({ tauThreadId, cwd: "/repo", updatedAt: 9, messages: [{ role: "user", text: "Say hi.", timestamp: 1 }], ...extra });
    // A synthetic store: never the user's own.
    await mkdir(join(root, "agent", "tau"), { recursive: true });
    await writeFile(join(root, "agent", "tau", "codex-runtime-sessions.json"), JSON.stringify({ version: 1, models: [], sessions: [
      thread("turns", { codexThreadId: "codex-1", usage: total, usageTurns: [turn("gpt-5.6-luna", 2), turn("gpt-5.6-luna", 3)] }),
      thread("legacy", { codexThreadId: "codex-2", usage: total, model: "gpt-5.6-sol" }),
      thread("unused", {}),
    ] }));
    const listed = new Map((await provider.listThreads()).map((record) => [record.threadId, record.usage]));
    expect(listed.get("turns")).toEqual([{ provider: "openai", model: "gpt-5.6-luna", billing: "subscription", ...total }]);
    expect(listed.get("legacy")).toEqual([{ provider: "openai", model: "gpt-5.6-sol", ...total }]);
    expect(listed.has("unused")).toBe(true);
    expect(listed.get("unused")).toBeUndefined();
  });
});

describe("Codex ChatGPT plan instances", () => {
  it("blocks new CLI threads during the first plan registration and releases the gate on cancellation", async () => {
    const { registry, provider, events, root } = await harness({ installed: "0.159.2", env: { TAU_CODEX_COMMAND: "codex", CODEX_HOME: join(tmpdir(), "unused-fixture-home") } });
    const flow = await registry.invoke("tau.codex", "sign-in", { method: "chatgpt-plan" }) as { flowId: string };
    await vi.waitFor(() => expect(events.some((event) => event.name === "sign-in" && Boolean((event.payload as { flow?: { browser?: unknown } }).flow?.browser))).toBe(true));
    await expect(provider.open("during-sign-in", root, { resume: false }, context)).rejects.toThrow("Finish or cancel");
    await registry.invoke("tau.codex", "sign-in-cancel", { flowId: flow.flowId });
    await vi.waitFor(() => expect(events.some((event) => event.name === "sign-in" && (event.payload as { report?: { flow?: { phase?: string } } }).report?.flow?.phase === "cancelled")).toBe(true));
    const backend = await provider.open("after-cancel", root, { resume: false }, context);
    await backend.dispose();
  });

  it("uses protected instance credentials and an isolated home with an account-specific model catalog", async () => {
    const { registry, provider, root, launches, fetch } = await harness({ installed: "0.159.2", env: { TAU_CODEX_COMMAND: "codex", CODEX_HOME: "/never-read-user-home" } });
    const credentials = new ChatGPTPlanStore(join(root, "state", "tau.codex", "chatgpt-plan"));
    await credentials.write("default", { issuer: "https://auth.openai.com", subject: "fixture-subject", clientId: "oaiapp_fixture", email: "fixture@example.test", tokens: { accessToken: "fixture-access", refreshToken: "fixture-refresh", idToken: "fixture-id", scopes: ["chatgpt.tokens.use.direct"], expiresAt: Date.now() + 3600_000 } });
    fetch.mockImplementation(async () => Response.json({ models: [
      { slug: "gpt-5.6-sol", display_name: "Account Sol", visibility: "list" },
      { slug: "gpt-6-astra", display_name: "Account Astra", visibility: "list" },
      { slug: "gpt-7-unknown", display_name: "Not in Codex's catalog", visibility: "list" },
    ] }));
    const catalog = await provider.newThreadCatalog!();
    // The account's models Codex knows, starting on Codex's default, with Codex's efforts.
    expect(catalog!.models).toEqual([
      expect.objectContaining({ id: "gpt-5.6-sol", name: "Account Sol", billing: "subscription", reasoning: true }),
      expect.objectContaining({ id: "gpt-6-astra", name: "Account Astra", reasoning: true }),
    ]);
    expect(catalog!.model).toMatchObject({ id: "gpt-6-astra" });
    expect(catalog!.thinkingLevels["gpt-6-astra"]).toContain("high");
    expect(launches[0]!.env.ACCESS_TOKEN).toBe("fixture-access");
    expect(launches[0]!.env.CODEX_HOME).toBe(join(root, "state", "tau.codex", "chatgpt-plan-homes", "default"));
    expect(launches[0]!.args).toEqual(CHATGPT_PLAN_ARGS);
    expect(await registry.invoke("tau.codex", "chatgpt-plan-account")).toMatchObject({ signedIn: true, label: "fixture@example.test" });
    expect((await registry.invoke("tau.codex", "sign-in-state") as { methods: unknown[] }).methods).toHaveLength(1);
  });

  it("links usage to ChatGPT Settings without probing the CLI quota endpoint", async () => {
    const { registry, root, launches } = await harness({ found: false });
    const credentials = new ChatGPTPlanStore(join(root, "state", "tau.codex", "chatgpt-plan"));
    await credentials.write("default", { issuer: "https://auth.openai.com", subject: "fixture-subject", clientId: "oaiapp_fixture", tokens: { accessToken: "fixture-access", idToken: "fixture-id", scopes: ["chatgpt.tokens.use.direct"], expiresAt: Date.now() + 3600_000 } });
    let read: (() => Promise<unknown>) | undefined;
    await registry.activate({ id: "tau.usage", name: "Usage", activate(activation) { read = () => activation.invokeHostExtension("tau.codex", "usage-limits"); } });
    expect(await read!()).toMatchObject({ accounts: [{ managementUrl: "https://chatgpt.com/settings/usage", windows: [], unavailable: { reason: "unsupported" } }] });
    expect(launches).toHaveLength(0);
  });

  it("fetches the newly pinned Codex by itself after a Tau update, with progress, and removes the old release", async () => {
    const managed = await managedFixture();
    const earlier = join(`0.100.0-${process.platform}-${process.arch}`, "bin");
    const { registry, root, events, fetch } = await harness({
      found: false, installed: MANAGED_CODEX_VERSION, managed,
      before: async (at) => {
        await mkdir(join(at, "state", "tau.codex", "managed-codex", earlier), { recursive: true });
        await new ChatGPTPlanStore(join(at, "state", "tau.codex", "chatgpt-plan")).write("default", { issuer: "https://auth.openai.com", subject: "fixture-subject", clientId: "oaiapp_fixture", tokens: { accessToken: "fixture-access", idToken: "fixture-id", scopes: ["chatgpt.tokens.use.direct"], expiresAt: Date.now() + 3600_000 } });
      },
    });
    const states = () => events.filter((event) => event.name === MANAGED_CODEX_EVENT).map((event) => event.payload as ManagedCodexState);
    await vi.waitFor(() => expect(states().at(-1)?.phase).toBe("installed"));
    expect(states().some((state) => state.phase === "downloading" && state.totalBytes === managed.asset.bytes)).toBe(true);
    expect(fetch.mock.calls.filter(([url]) => String(url).includes(`/rust-v${MANAGED_CODEX_VERSION}/`))).toHaveLength(1);
    await expect(readdir(join(root, "state", "tau.codex", "managed-codex"))).resolves.toEqual([`${MANAGED_CODEX_VERSION}-${process.platform}-${process.arch}`]);
    const status = await registry.invoke("tau.codex", "status") as CodexStatusReport;
    expect(status.path).toBe(join(root, "state", "tau.codex", "managed-codex", `${MANAGED_CODEX_VERSION}-${process.platform}-${process.arch}`, "bin", `codex${process.platform === "win32" ? ".exe" : ""}`));
    expect(status.chatgptPlan?.needsInstall).toBeUndefined();
    expect(status.managedInstall).toBeUndefined();
  });

  it("fetches nothing for a CLI instance that never ran Tau's Codex", async () => {
    const { registry, fetch } = await harness({ found: false, managed: await managedFixture() });
    const status = await registry.invoke("tau.codex", "status") as CodexStatusReport;
    expect(status.message).toMatch(/Continue with ChatGPT/u);
    expect(fetch.mock.calls.some(([url]) => String(url).startsWith("https://github.com/"))).toBe(false);
  });

  it("removes a plan instance only when ChatGPT confirmed the revocation", async () => {
    const { registry, root, fetch } = await harness();
    await registry.invoke("tau.codex", "save-instance", { instance: { id: "work" } });
    await new ChatGPTPlanStore(join(root, "state", "tau.codex", "chatgpt-plan")).write("work", { issuer: "https://auth.openai.com", subject: "fixture-subject", clientId: "oaiapp_fixture", tokens: { accessToken: "fixture-access", refreshToken: "fixture-refresh", idToken: "fixture-id", scopes: ["chatgpt.tokens.use.direct"], expiresAt: Date.now() + 3600_000 } });
    let revocation = 400;
    fetch.mockImplementation(async (url) => String(url).endsWith("openid-configuration")
      ? Response.json({ issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/jwks", revocation_endpoint: "https://auth.openai.com/revoke" })
      : new Response(null, { status: revocation }));
    await expect(registry.invoke("tau.codex", "remove-instance", { instance: "work" })).rejects.toThrow("Remote revocation was not confirmed");
    expect((await registry.invoke("tau.codex", "instances") as { instances: Array<{ id: string }> }).instances.map((entry) => entry.id)).toContain("work");
    revocation = 200;
    await registry.invoke("tau.codex", "remove-instance", { instance: "work" });
    expect((await registry.invoke("tau.codex", "instances") as { instances: Array<{ id: string }> }).instances.map((entry) => entry.id)).not.toContain("work");
  });

  it("refuses to let a plan instance's commands see variables named *TOKEN*", async () => {
    const { registry, root } = await harness();
    await registry.invoke("tau.codex", "save-instance", { instance: { id: "work" } });
    await new ChatGPTPlanStore(join(root, "state", "tau.codex", "chatgpt-plan")).write("work", { issuer: "https://auth.openai.com", subject: "fixture-subject", clientId: "oaiapp_fixture" });
    await expect(registry.invoke("tau.codex", "save-instance", { instance: { id: "work", args: "-c shell_environment_policy.ignore_default_excludes=true" } })).rejects.toThrow("*TOKEN*");
    await registry.invoke("tau.codex", "save-instance", { instance: { id: "work", args: "-c model_verbosity=low" } });
  });

  it("shows plan permission accurately and retains the bound registration after logout", async () => {
    const { registry, root } = await harness();
    const credentials = new ChatGPTPlanStore(join(root, "state", "tau.codex", "chatgpt-plan"));
    await credentials.write("default", { issuer: "https://auth.openai.com", subject: "fixture-subject", clientId: "oaiapp_fixture", tokens: { accessToken: "fixture-access", idToken: "fixture-id", scopes: ["openid"], expiresAt: Date.now() + 3600_000 } });
    expect(await registry.invoke("tau.codex", "chatgpt-plan-account")).toMatchObject({ signedIn: false });
    await registry.invoke("tau.codex", "sign-out");
    expect((await credentials.read("default"))!.tokens).toBeUndefined();
    expect((await credentials.read("default"))!.subject).toBe("fixture-subject");
    expect((await registry.invoke("tau.codex", "sign-in-state") as { methods: unknown[] }).methods).toHaveLength(1);
  });
});
