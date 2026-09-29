import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtension, HostRuntimeBackendProvider, RuntimeSessionInfo } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import createClaudeCodeHostExtension from "./host.js";
import { createClaudeCodeRuntimeAdapter, type ClaudeCodeRuntimeOptions, type ClaudeSessionInput } from "./runtime-adapter.js";
import { ClaudeRuntimeSessionStore } from "./session-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const offline = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof globalThis.fetch;

async function harness(findCommand: (name: string) => string | undefined, fetch: typeof globalThis.fetch = offline, env: (agentDir: string) => NodeJS.ProcessEnv = () => ({})) {
  const agentDir = await mkdtemp(join(tmpdir(), "tau-claude-host-"));
  directories.push(agentDir);
  const backends: HostRuntimeBackendProvider[] = [];
  const registry = await activateHostKit(createClaudeCodeHostExtension({ fetch, env: env(agentDir) }), {
    stateDir: join(agentDir, "state"),
    findCommand,
    noteSubprocess: () => undefined,
    agentDir,
    sessionsDir: join(agentDir, "sessions"),
    skills: () => [{ name: "tdd", description: "Test first" }, { name: "not a skill name", description: "ignored" }],
    registerRuntimeBackend: (provider) => { backends.push(provider); return () => undefined; },
  });
  return { registry, backends, agentDir };
}

describe("Claude Code host half", () => {
  it("opens a thread's session with Tau's MCP server for that thread", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "tau-claude-host-"));
    directories.push(agentDir);
    const adapter = createClaudeCodeRuntimeAdapter({ command: "unused", storePath: join(agentDir, "store.json") });
    let opened!: (input: ClaudeSessionInput) => void;
    const openedInput = new Promise<ClaudeSessionInput>((resolve) => { opened = resolve; });
    adapter.openSession = (input) => {
      opened(input);
      // A session that never answers; the test only reads what it was opened with.
      return { closed: false, busy: false, send: () => new Promise(() => undefined), close: async () => undefined, interrupt: async () => undefined, setPermissionMode: async () => undefined } as never;
    };
    const connected: RuntimeSessionInfo[] = [];
    const mcpServer = { name: "tau", url: "http://127.0.0.1:4100/mcp", token: "secret", headers: { Authorization: "Bearer secret" } };
    const backends: HostRuntimeBackendProvider[] = [];
    await activateHostKit(createClaudeCodeHostExtension({ fetch: offline, env: {}, adapter }), {
      stateDir: join(agentDir, "state"),
      findCommand: () => "/usr/local/bin/claude",
      noteSubprocess: () => undefined,
      agentDir,
      sessionsDir: join(agentDir, "sessions"),
      skills: () => [],
      registerRuntimeBackend: (provider) => { backends.push(provider); return () => undefined; },
      mcp: { registerTools: () => () => undefined, gate: () => () => undefined, connect: async (thread) => { connected.push(thread); return mcpServer; } },
    });
    const backend = await backends[0]!.open("tau-thread", "/repo", { resume: false }, {
      projectName: "repo", permissionLevel: () => "full", onMessage: () => undefined, onEvent: () => undefined, ask: async () => ({ cancelled: true }),
    });
    void backend.prompt({ text: "hi", delivery: "prompt" }).catch(() => undefined);
    expect((await openedInput).mcpServer).toEqual(mcpServer);
    expect(connected).toEqual([{ sessionId: "tau-thread", cwd: "/repo" }]);
    await backend.dispose();
  });

  it("registers its backend through the seam and publishes the skills as Claude commands", async () => {
    const { backends } = await harness(() => "/usr/local/bin/claude");
    const [provider] = backends;
    expect(provider?.kind).toBe("claude-code");
    expect(provider?.adapter.id).toBe("claude-code");
    expect(provider).toMatchObject({ modelProvider: "anthropic", homeProviders: ["anthropic"] });
    expect(provider?.label).toBe("Claude Code");
    // Only names Claude can be asked to run; the dialect is the adapter's.
    expect(provider?.composerCommands("/repo")).toEqual([
      { name: "skill:tdd", description: "Test first", source: "skill", skillCommand: "/tdd" },
    ]);
    // Claude's questions reach the workbench through the open context's `ask`; no access level is refused up front.
    expect(provider?.assertPromptAllowed).toBeUndefined();
    expect(provider?.adapter.capabilities.interactiveApprovals).toBe(true);
  });

  it("reports where the CLI is, and refuses to open a thread when it is missing", async () => {
    const found = await harness((name) => name === "claude" ? "/usr/local/bin/claude" : undefined);
    await expect(found.registry.invoke("tau.claude-code", "status"))
      .resolves.toEqual({ kind: "claude-code", command: "claude", path: "/usr/local/bin/claude" });

    const missing = await harness(() => undefined);
    await expect(missing.registry.invoke("tau.claude-code", "status"))
      .resolves.toEqual({ kind: "claude-code", command: "claude", path: undefined });
    await expect(missing.backends[0]!.open("thread", "/repo", { resume: false }, {
      projectName: "repo",
      permissionLevel: () => "full",
    } as never)).rejects.toThrow("was not found on the PATH");
    // A draft's picker says so instead of listing nothing.
    await expect(missing.backends[0]!.newThreadCatalog!()).resolves.toMatchObject({ models: [], status: "not-installed" });
  });

  it("reports the installed CLI's version, the newest release and how the native install updates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-claude-cli-"));
    directories.push(directory);
    const cli = join(directory, "claude");
    await writeFile(cli, "#!/bin/sh\necho '2.1.280 (Claude Code)'\n", { mode: 0o755 });
    const fetch = async () => ({ ok: true, json: async () => ({ version: "2.1.300" }) }) as Response;
    const { backends } = await harness((name) => name === "claude" ? cli : undefined, fetch);
    await expect(backends[0]!.version!()).resolves.toEqual({ tool: "claude", installed: "2.1.280", latest: "2.1.300", updateCommand: "claude update" });
    const { backends: none } = await harness(() => undefined, fetch);
    await expect(none[0]!.version!()).resolves.toBeUndefined();
  });

  it("keeps a path set on the Providers card and refuses one that is no executable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-claude-cli-"));
    directories.push(directory);
    const cli = join(directory, "claude");
    await writeFile(cli, "#!/bin/sh\necho '2.1.280 (Claude Code)'\n", { mode: 0o755 });
    const { registry } = await harness((name) => name === cli ? cli : undefined);
    await expect(registry.invoke("tau.claude-code", "set-command", { command: join(directory, "nothing") })).rejects.toThrow("No executable");
    await expect(registry.invoke("tau.claude-code", "set-command", { command: cli })).resolves.toEqual({ command: cli });
    await expect(registry.invoke("tau.claude-code", "status")).resolves.toEqual({ kind: "claude-code", command: cli, path: cli, commandSource: "setting", version: "2.1.280" });
  });

  it("hands each thread's running total to the Usage kit and to no other kit", async () => {
    const { registry, agentDir } = await harness(() => "/usr/local/bin/claude");
    const store = new ClaudeRuntimeSessionStore({ filePath: ClaudeRuntimeSessionStore.defaultPath(join(agentDir, "sessions")) });
    await store.recordUsage("thread-1", "/repo", { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 12, costUsd: 0.3, turns: 1 });
    await store.setObservedModel("thread-1", "/repo", "claude-haiku-4-5");
    const started = await store.ensure("thread-2", "/repo");
    const reader = (id: string): HostExtension & { read?: () => Promise<unknown> } => {
      const extension: HostExtension & { read?: () => Promise<unknown> } = {
        id,
        name: id,
        activate(context) { extension.read = () => context.invokeHostExtension("tau.claude-code", "usage"); },
      };
      return extension;
    };
    const usageKit = reader("tau.usage");
    const stranger = reader("acme.stranger");
    await registry.activate(usageKit);
    await registry.activate(stranger);
    const answer = await usageKit.read!() as { threads: Array<Record<string, unknown>> };
    expect(answer.threads.find((thread) => thread.threadId === "thread-1")).toMatchObject({
      cwd: "/repo", model: "claude-haiku-4-5", usage: { totalTokens: 12, costUsd: 0.3, turns: 1 },
    });
    expect(answer.threads.find((thread) => thread.threadId === "thread-2")).toMatchObject({ sessionId: started.claudeSessionId });
    expect(answer.threads.find((thread) => thread.threadId === "thread-2")?.usage).toBeUndefined();
    await expect(stranger.read!()).rejects.toThrow("Caller acme.stranger is not allowed to invoke tau.claude-code/usage.");
  });

  it("names each instance's projects folder for the Usage kit, from the instance's own config folder", async () => {
    const { registry, agentDir } = await harness(() => "/usr/local/bin/claude", offline, (dir) => ({ CLAUDE_CONFIG_DIR: join(dir, "claude-home") }));
    await registry.invoke("tau.claude-code", "save-instance", { instance: { id: "work", home: join(agentDir, "work-home") } });
    let read: (() => Promise<unknown>) | undefined;
    await registry.activate({ id: "tau.usage", name: "Usage", activate(context) { read = () => context.invokeHostExtension("tau.claude-code", "usage-logs"); } });
    await expect(read!()).resolves.toEqual({ folders: [
      { format: "agent-sdk", path: join(agentDir, "claude-home", "projects"), instance: "claude-code" },
      { format: "agent-sdk", path: join(agentDir, "work-home", "projects"), instance: "claude-code@work" },
    ] });
  });

  it("names a plan login's account for the Usage kit by a hash of its organization, read from the instance's config directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-claude-identity-"));
    directories.push(root);
    await writeFile(join(root, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "user-fixture-1", organizationUuid: "org-fixture-1", emailAddress: "fixture@example.invalid" } }));
    const real = createClaudeCodeRuntimeAdapter({ storePath: join(root, "store.json"), command: "claude" });
    const probe = { models: [], modelInfos: [], probedAt: 1, account: { subscriptionType: "max", tokenSource: "claude.ai" }, usage: { rate_limits_available: true, rate_limits: { five_hour: { utilization: 40, resets_at: null } } } };
    const adapter = { ...real, probe: async () => probe };
    const registry = await activateHostKit(createClaudeCodeHostExtension({ adapter, fetch: offline, env: { CLAUDE_CONFIG_DIR: root } }), {
      stateDir: join(root, "state"),
      sessionsDir: join(root, "sessions"),
      findCommand: () => "/usr/local/bin/claude",
      noteSubprocess: () => undefined,
      registerRuntimeBackend: () => () => undefined,
    });
    let read: (() => Promise<unknown>) | undefined;
    await registry.activate({ id: "tau.usage", name: "Usage", activate(activation) { read = () => activation.invokeHostExtension("tau.claude-code", "usage-limits"); } });
    const answer = await read!();
    expect(answer).toEqual({ accounts: [expect.objectContaining({
      runtime: "claude-code",
      plan: "max",
      windows: [expect.objectContaining({ id: "five_hour", usedPercent: 40 })],
      identity: { provider: "anthropic", key: "afc3cb12c42d1e5bc2bdc82626464d958a551fd461eb8a992861f720f57d0ef5" },
    })] });
    expect(JSON.stringify(answer)).not.toMatch(/fixture/u);
  });

  it("stays on when the CLI cannot be probed: that is a missing prerequisite, not a broken kit", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-claude-probe-"));
    directories.push(root);
    const real = createClaudeCodeRuntimeAdapter({ storePath: join(root, "store.json"), command: "claude" });
    const adapter = { ...real, probe: async () => { throw new Error("Claude Code process exited with code 1."); } };
    const registry = await activateHostKit(createClaudeCodeHostExtension({ adapter, fetch: offline, env: {} }), {
      stateDir: join(root, "state"),
      sessionsDir: join(root, "sessions"),
      findCommand: () => undefined,
      noteSubprocess: () => undefined,
      registerRuntimeBackend: () => () => undefined,
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(registry.invoke("tau.claude-code", "probe")).rejects.toThrow("exited with code 1");
    }
    await expect(registry.invoke("tau.claude-code", "status")).resolves.toMatchObject({ kind: "claude-code" });
  });

  it("registers a backend per instance with its own home, variables and launch options", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-claude-instances-"));
    directories.push(root);
    const built: ClaudeCodeRuntimeOptions[] = [];
    const backends: HostRuntimeBackendProvider[] = [];
    const registry = await activateHostKit(createClaudeCodeHostExtension({
      fetch: offline,
      env: { PATH: "/bin" },
      readVersion: async () => "2.1.280",
      createAdapter: (options) => { built.push(options); return createClaudeCodeRuntimeAdapter(options); },
    }), {
      stateDir: join(root, "state"),
      sessionsDir: join(root, "sessions"),
      findCommand: () => "/usr/local/bin/claude",
      noteSubprocess: () => undefined,
      skills: () => [],
      registerRuntimeBackend: (provider) => { backends.push(provider); return () => { backends.splice(backends.indexOf(provider), 1); }; },
    });
    await expect(registry.invoke("tau.claude-code", "save-instance", { instance: { id: "second", args: "-p" } })).rejects.toThrow("not a long option");
    await registry.invoke("tau.claude-code", "save-instance", { instance: { id: "second", name: "Second", home: join(root, "claude-second"), env: { ANTHROPIC_LOG: "debug" }, args: "--chrome --settings /tmp/s.json" } });
    const second = backends.find((provider) => provider.kind === "claude-code@second")!;
    expect(second).toMatchObject({ label: "Claude Code · Second" });
    expect(second.adapter.id).toBe("claude-code@second");
    const options = built.at(-1)!;
    expect(options.env).toEqual({ PATH: "/bin", ANTHROPIC_LOG: "debug", CLAUDE_CONFIG_DIR: join(root, "claude-second") });
    expect(options.extraArgs).toEqual({ chrome: null, settings: "/tmp/s.json" });
    expect(typeof options.command === "function" ? options.command() : options.command).toBe("claude");

    const thread = await second.open("second-thread", "/repo", { resume: false }, { projectName: "repo", permissionLevel: () => "full" } as never);
    expect(thread.kind).toBe("claude-code@second");
    await thread.dispose();
    await expect(second.listThreads()).resolves.toEqual([expect.objectContaining({ threadId: "second-thread" })]);
    await expect(backends.find((provider) => provider.kind === "claude-code")!.listThreads()).resolves.toEqual([]);
    await expect(registry.invoke("tau.claude-code", "status", { instance: "second" })).resolves.toMatchObject({ kind: "claude-code@second", instance: "second", command: "claude" });
    await registry.invoke("tau.claude-code", "remove-instance", { instance: "second" });
    expect(backends.map((provider) => provider.kind)).toEqual(["claude-code"]);
  });

  it("registers its backend anew on recheck, answers the fresh version, and takes a test instance's update command", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-claude-recheck-"));
    directories.push(root);
    const backends: HostRuntimeBackendProvider[] = [];
    let installed = "2.1.280";
    const registry = await activateHostKit(createClaudeCodeHostExtension({
      fetch: async () => ({ ok: true, json: async () => ({ version: "2.1.300" }) }) as Response,
      env: { TAU_RUNTIME_UPDATE_COMMAND: JSON.stringify({ "claude-code": "/tmp/stub-update.sh" }) },
      readVersion: async () => installed,
    }), {
      stateDir: join(root, "state"),
      sessionsDir: join(root, "sessions"),
      findCommand: () => "/usr/local/bin/claude",
      noteSubprocess: () => undefined,
      skills: () => [],
      registerRuntimeBackend: (provider) => { backends.push(provider); return () => { backends.splice(backends.indexOf(provider), 1); }; },
    });
    const first = backends[0]!;
    await expect(first.version!()).resolves.toMatchObject({ installed: "2.1.280", latest: "2.1.300", updateCommand: "/tmp/stub-update.sh" });
    installed = "2.1.300";
    await expect(registry.invoke("tau.claude-code", "recheck")).resolves.toMatchObject({ installed: "2.1.300", latest: "2.1.300" });
    expect(backends).toHaveLength(1);
    expect(backends[0]).not.toBe(first);
  });

  it("carries a version policy's verdict and refuses a broken release", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-claude-policy-"));
    directories.push(root);
    const backends: HostRuntimeBackendProvider[] = [];
    const policy = { "claude-code": { ranges: [{ range: "<2.2.0", status: "broken", message: "It drops tool results." }], recommendedVersion: "2.2.1" } };
    await activateHostKit(createClaudeCodeHostExtension({ fetch: offline, env: { TAU_VERSION_POLICY: JSON.stringify(policy) }, readVersion: async () => "2.1.280" }), {
      stateDir: join(root, "state"),
      sessionsDir: join(root, "sessions"),
      findCommand: () => "/usr/local/bin/claude",
      noteSubprocess: () => undefined,
      skills: () => [],
      registerRuntimeBackend: (provider) => { backends.push(provider); return () => undefined; },
    });
    await expect(backends[0]!.version!()).resolves.toMatchObject({ installed: "2.1.280", compatibility: { status: "broken", message: "It drops tool results.", recommendedVersion: "2.2.1" } });
    await expect(backends[0]!.open("t", "/repo", { resume: false }, { projectName: "repo", permissionLevel: () => "full" } as never)).rejects.toThrow("It drops tool results. Install 2.2.1.");
  });

  describe("signing in from the window", () => {
    const STUB = fileURLToPath(new URL("./fixtures/stub-cli.mjs", import.meta.url));
    type Flow = { flowId: string; phase: string; terminal?: { command: string }; prompt?: { id: string }; message?: string };
    type Report = { methods: Array<{ id: string; unavailable?: string }>; account?: { signedIn: boolean; label?: string; detail?: string; canSignOut?: boolean }; flow?: Flow; note?: string };

    async function signInHarness(extraEnv: NodeJS.ProcessEnv = {}) {
      const root = await mkdtemp(join(tmpdir(), "tau-claude-sign-in-"));
      directories.push(root);
      const home = join(root, "home");
      const events: PublishedKitEvent[] = [];
      const backends: HostRuntimeBackendProvider[] = [];
      const registry = await activateHostKit(createClaudeCodeHostExtension({ fetch: offline, env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: home, ...extraEnv }, readVersion: async () => "2.1.280" }), {
        stateDir: join(root, "state"),
        findCommand: (name) => name === "claude" ? STUB : undefined,
        noteSubprocess: () => undefined,
        agentDir: root,
        sessionsDir: join(root, "sessions"),
        skills: () => [],
        registerRuntimeBackend: (provider) => { backends.push(provider); return () => { backends.splice(backends.indexOf(provider), 1); }; },
      }, (event) => events.push(event));
      const finalReport = async (flowId: string) => {
        let found: Report | undefined;
        await vi.waitFor(() => {
          found = events.filter((event) => event.name === "sign-in").map((event) => (event.payload as { report?: Report }).report).find((report) => report?.flow?.flowId === flowId);
          expect(found).toBeDefined();
        });
        return found!;
      };
      const waitingFlow = async (flowId: string) => {
        let found: Flow | undefined;
        await vi.waitFor(() => {
          found = events.filter((event) => event.name === "sign-in").map((event) => (event.payload as { flow?: Flow }).flow).find((flow) => flow?.flowId === flowId && flow.prompt !== undefined);
          expect(found).toBeDefined();
        });
        return found!;
      };
      return { registry, backends, home, events, finalReport, waitingFlow };
    }

    it("says the CLI is signed out, so a draft offers no models, and offers its two logins", async () => {
      const { registry, backends, home } = await signInHarness();
      await expect(registry.invoke("tau.claude-code", "status")).resolves.toMatchObject({ signedIn: false, path: STUB });
      await expect(backends[0]!.newThreadCatalog!()).resolves.toMatchObject({ models: [], status: "sign-in-required" });
      const report = await registry.invoke("tau.claude-code", "sign-in-state") as Report;
      expect(report.methods.map((method) => method.id)).toEqual(["plan", "console"]);
      expect(report.account).toEqual({ signedIn: false });
      expect(report.note).toContain(home);
    });

    it("runs the CLI's login for the instance's home in a terminal and checks it when the terminal ends", async () => {
      const { registry, home, finalReport, waitingFlow } = await signInHarness();
      const early = await registry.invoke("tau.claude-code", "sign-in", { method: "plan" }) as Flow;
      await waitingFlow(early.flowId);
      await registry.invoke("tau.claude-code", "sign-in-respond", { flowId: early.flowId, value: "0" });
      expect((await finalReport(early.flowId)).flow).toMatchObject({ phase: "failed", message: "The CLI still reports no login." });

      const started = await registry.invoke("tau.claude-code", "sign-in", { method: "plan" }) as Flow;
      const waiting = await waitingFlow(started.flowId);
      expect(waiting.terminal?.command).toBe(`CLAUDE_CONFIG_DIR=${home} ${STUB} auth login --claudeai`);
      // The user's terminal: the same command, run by hand.
      await promisify(execFile)(STUB, ["auth", "login", "--claudeai"], { env: { ...process.env, CLAUDE_CONFIG_DIR: home } });
      await registry.invoke("tau.claude-code", "sign-in-respond", { flowId: started.flowId, value: "0" });
      const report = await finalReport(started.flowId);
      expect(report.flow).toMatchObject({ phase: "succeeded", message: "Signed in as stub@example.com." });
      expect(report.account).toEqual({ signedIn: true, label: "stub@example.com", detail: "Claude Max · Stub Org", canSignOut: true });
      await expect(registry.invoke("tau.claude-code", "status")).resolves.toMatchObject({ signedIn: true, account: "stub@example.com" });

      const after = await registry.invoke("tau.claude-code", "sign-out") as Report;
      expect(after).toMatchObject({ account: { signedIn: false }, note: "Signed out of Claude Code." });
    });

    it("treats a key from the environment as signed in that a sign-out cannot remove", async () => {
      const { registry } = await signInHarness({ ANTHROPIC_API_KEY: "sk-ant-fake" });
      const report = await registry.invoke("tau.claude-code", "sign-in-state") as Report;
      expect(report.account).toEqual({ signedIn: true, label: "API key", detail: "API key · ANTHROPIC_API_KEY", canSignOut: false });
    });
  });

  it("lists what each thread cost from its store, without opening it", async () => {
    const { backends, agentDir } = await harness(() => "/usr/local/bin/claude");
    const turn = (model: string, at: number, costUsd: number) => ({ provider: "anthropic", model, billing: "api-key", inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0, totalTokens: 160, costUsd, turns: 1, at });
    const total = { inputTokens: 300, outputTokens: 30, cacheReadTokens: 150, cacheWriteTokens: 0, totalTokens: 480, costUsd: 0.6, turns: 3 };
    const thread = (tauThreadId: string, claudeSessionId: string, extra: Record<string, unknown>) => ({
      tauThreadId, claudeSessionId, cwd: "/repo", started: true, updatedAt: 9, messages: [{ role: "user", text: "Say hi.", timestamp: 1 }], ...extra,
    });
    // A synthetic store: never the user's own.
    await mkdir(join(agentDir, "tau"), { recursive: true });
    await writeFile(join(agentDir, "tau", "claude-runtime-sessions.json"), JSON.stringify({ version: 1, sessions: [
      thread("turns", "11111111-1111-4111-8111-111111111111", { usage: total, usageTurns: [turn("claude-haiku-4-5", 2, 0.1), turn("claude-haiku-4-5", 3, 0.2), turn("claude-sonnet-4-5", 4, 0.3)] }),
      thread("legacy", "22222222-2222-4222-8222-222222222222", { usage: total, observedModel: "claude-haiku-4-5" }),
      thread("unused", "33333333-3333-4333-8333-333333333333", {}),
    ] }));
    const listed = new Map((await backends[0]!.listThreads()).map((record) => [record.threadId, record.usage]));
    expect(listed.get("turns")).toEqual([
      { provider: "anthropic", model: "claude-haiku-4-5", billing: "api-key", inputTokens: 200, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 0, totalTokens: 320, costUsd: expect.closeTo(0.3), turns: 2 },
      { provider: "anthropic", model: "claude-sonnet-4-5", billing: "api-key", inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0, totalTokens: 160, costUsd: 0.3, turns: 1 },
    ]);
    expect(listed.get("legacy")).toEqual([{ provider: "anthropic", model: "claude-haiku-4-5", ...total }]);
    expect(listed.has("unused")).toBe(true);
    expect(listed.get("unused")).toBeUndefined();
  });
});
