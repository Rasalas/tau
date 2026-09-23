import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostExtension, HostRuntimeBackendProvider, RuntimeSessionInfo } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import createClaudeCodeHostExtension from "./host.js";
import { createClaudeCodeRuntimeAdapter, type ClaudeSessionInput } from "./runtime-adapter.js";
import { ClaudeRuntimeSessionStore } from "./session-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const offline = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof globalThis.fetch;

async function harness(findCommand: (name: string) => string | undefined, fetch: typeof globalThis.fetch = offline) {
  const agentDir = await mkdtemp(join(tmpdir(), "tau-claude-host-"));
  directories.push(agentDir);
  const backends: HostRuntimeBackendProvider[] = [];
  const registry = await activateHostKit(createClaudeCodeHostExtension({ fetch, env: {} }), {
    stateDir: join(agentDir, "state"),
    findCommand,
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
    expect(provider?.modelProvider).toBe("anthropic");
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
    await expect(registry.invoke("tau.claude-code", "status")).resolves.toEqual({ kind: "claude-code", command: cli, path: cli, commandSource: "setting" });
  });

  it("hands each thread's running total to the Usage kit and to no other kit", async () => {
    const { registry, agentDir } = await harness(() => "/usr/local/bin/claude");
    const store = new ClaudeRuntimeSessionStore({ filePath: ClaudeRuntimeSessionStore.defaultPath(join(agentDir, "sessions")) });
    await store.recordUsage("thread-1", "/repo", { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 12, costUsd: 0.3, turns: 1 });
    await store.setObservedModel("thread-1", "/repo", "claude-haiku-4-5");
    await store.ensure("thread-2", "/repo");
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
    expect(answer.threads.find((thread) => thread.threadId === "thread-2")?.usage).toBeUndefined();
    await expect(stranger.read!()).rejects.toThrow("Caller acme.stranger is not allowed to invoke tau.claude-code/usage.");
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
      registerRuntimeBackend: () => () => undefined,
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(registry.invoke("tau.claude-code", "probe")).rejects.toThrow("exited with code 1");
    }
    await expect(registry.invoke("tau.claude-code", "status")).resolves.toMatchObject({ kind: "claude-code" });
  });
});
