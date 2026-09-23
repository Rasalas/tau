import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtension, HostMcpConnection, HostRuntimeBackendProvider } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import createGrokHostExtension from "./host.js";
import { GrokSessionStore } from "./session-store.js";

const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-grok.mjs", import.meta.url));
const TAU_SERVER: HostMcpConnection = { name: "tau", url: "http://127.0.0.1:4100/mcp", token: "secret", headers: { Authorization: "Bearer secret" } };
const directories: string[] = [];

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function harness(options: { found?: boolean; env?: Record<string, string>; fetch?: typeof globalThis.fetch } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tau-grok-host-"));
  directories.push(root);
  const log = join(root, "agent.log");
  const backends: HostRuntimeBackendProvider[] = [];
  const connects: unknown[] = [];
  const extension = createGrokHostExtension({
    env: { PATH: process.env.PATH ?? "", TAU_GROK_HOME: join(root, "grok-home"), FAKE_GROK_LOG: log, ...options.env },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const registry = await activateHostKit(extension, {
    mcp: { registerTools: () => () => undefined, gate: () => () => undefined, connect: async (scope) => { connects.push(scope); return TAU_SERVER; } },
    findCommand: (name) => (name === "grok" || name === FAKE_CLI) && options.found !== false ? FAKE_CLI : undefined,
    sessionsDir: join(root, "agent", "sessions"),
    stateDir: join(root, "state"),
    noteSubprocess: () => undefined,
    registerRuntimeBackend: (provider) => {
      backends.push(provider);
      return () => { backends.splice(backends.indexOf(provider), 1); };
    },
  });
  const sent = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
  return { registry, provider: backends[0]!, backend: (kind: string) => backends.find((entry) => entry.kind === kind), root, sent, connects };
}

const context = (level = "full") => ({ projectName: "repo", permissionLevel: () => level, onMessage: () => undefined, onEvent: () => undefined, ask: async () => ({ cancelled: true }) }) as never;

function caller(id: string): HostExtension & { call?: (command: string, input?: unknown) => Promise<unknown> } {
  const extension: HostExtension & { call?: (command: string, input?: unknown) => Promise<unknown> } = {
    id, name: id,
    activate(activation) { extension.call = (command, input) => activation.invokeHostExtension("tau.grok", command, input); },
  };
  return extension;
}

describe("Grok host half", () => {
  it("registers a Grok backend that asks for approvals, takes files and plans", async () => {
    const { provider } = await harness();
    expect(provider).toMatchObject({ kind: "grok", label: "Grok", order: 60 });
    expect(provider.adapter.capabilities).toMatchObject({ interactiveApprovals: true, fileAttachments: true, modes: ["plan"], ownsModelSelection: false });
  });

  it("lists the models initialize names without signing in or starting a session", async () => {
    const { provider, sent, connects } = await harness();
    const catalog = await provider.newThreadCatalog!();
    expect(catalog).toMatchObject({ model: { provider: "xai", id: "grok-4.6" }, thinkingLevels: { "grok-4.6": ["default", "high", "low"], "grok-4.6-fast": ["default"] } });
    expect(catalog?.models.map((model) => `${model.id}:${model.billing}:${model.contextWindow}`)).toEqual(["grok-4.6:subscription:500000", "grok-4.6-fast:subscription:2000000"]);
    expect((await sent()).map((message) => message.method).filter(Boolean)).toEqual(["initialize"]);
    expect(connects).toEqual([]);
    // An API key in Tau's environment bills the API.
    const keyed = await harness({ env: { XAI_API_KEY: "xai-test" } });
    expect((await keyed.provider.newThreadCatalog!())?.models[0]?.billing).toBe("api-key");
  });

  it("says what stops a catalog: no CLI, no sign-in", async () => {
    await expect((await harness({ found: false })).provider.newThreadCatalog!()).resolves.toMatchObject({ models: [], status: "not-installed" });
    const signedOut = await harness({ env: { FAKE_GROK_SIGNED_OUT: "1" } });
    await expect(signedOut.provider.newThreadCatalog!()).resolves.toMatchObject({ status: "sign-in-required" });
    expect(await signedOut.sent()).toEqual([]);
  });

  it("runs a thread with Tau's MCP server, ends a turn Grok answers only by notification, and loads it in a new process", async () => {
    const { provider, root, sent, connects } = await harness();
    const backend = await provider.open("tau-thread", root, { resume: false }, context());
    try {
      await expect(backend.prompt({ text: "which mcp?", delivery: "prompt" })).resolves.toEqual({ assistantText: "mcp tau:http" });
      await expect(backend.prompt({ text: "silent please", delivery: "prompt" })).resolves.toEqual({ assistantText: "pong from grok-4.6 (high)" });
    } finally {
      await backend.dispose();
    }
    expect(connects).toEqual([{ sessionId: "tau-thread", cwd: root }]);
    const created = (await sent()).find((message) => message.method === "session/new")!;
    expect(created.params).toMatchObject({ cwd: root, mcpServers: [{ type: "http", name: "tau", url: TAU_SERVER.url, headers: [{ name: "Authorization", value: "Bearer secret" }] }] });
    const again = await provider.open("tau-thread", root, { resume: true }, context("read-only"));
    try {
      await expect(again.prompt({ text: "history and args", delivery: "prompt" })).resolves.toEqual({ assistantText: "args --permission-mode default agent stdio" });
      expect((await again.transcript()).map((message) => message.text)).toEqual(["which mcp?", "mcp tau:http", "silent please", "pong from grok-4.6 (high)", "history and args", "args --permission-mode default agent stdio"]);
    } finally {
      await again.dispose();
    }
    expect((await sent()).filter((message) => message.method === "session/load")).toHaveLength(1);
  });

  it("reports version, login and models", async () => {
    const { registry, provider } = await harness({ env: { FAKE_GROK_VERSION: "1.2.3" } });
    await expect(provider.version!()).resolves.toEqual({ tool: "grok", installed: "1.2.3" });
    await expect(registry.invoke("tau.grok", "status")).resolves.toMatchObject({ instance: "default", command: "grok", path: FAKE_CLI, version: "1.2.3", login: "account", signedIn: true, account: "grok.com", models: 2 });
    const signedOut = await harness({ env: { FAKE_GROK_SIGNED_OUT: "1" } });
    await expect(signedOut.registry.invoke("tau.grok", "status")).resolves.toMatchObject({ signedIn: false });
  });

  it("registers a backend per instance and starts it with the instance's arguments", async () => {
    const { registry, backend, sent } = await harness();
    const report = await registry.invoke("tau.grok", "save-instance", { instance: { id: "work", name: "Work", args: "--verbose" } });
    expect(report).toMatchObject({ instances: [{ id: "default" }, { id: "work", kind: "grok@work", label: "Grok · Work" }] });
    const work = backend("grok@work")!;
    await expect(work.newThreadCatalog!()).resolves.toMatchObject({ models: expect.arrayContaining([expect.objectContaining({ id: "grok-4.6" })]) });
    expect((await sent()).some((message) => message.method === "initialize")).toBe(true);
    await expect(registry.invoke("tau.grok", "remove-instance", { instance: "work" })).resolves.toMatchObject({ instances: [{ id: "default" }] });
    expect(backend("grok@work")).toBeUndefined();
  });

  it("hands each thread's turns and the plan's window to the Usage kit and to no other kit", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ config: { creditUsagePercent: 12, currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" } } }) }) as unknown as Response);
    const { registry, root } = await harness({ fetch: fetch as unknown as typeof globalThis.fetch });
    await mkdir(join(root, "grok-home"), { recursive: true });
    await writeFile(join(root, "grok-home", "auth.json"), JSON.stringify({ "https://accounts.x.ai/sign-in": { key: "token", auth_mode: "oauth" } }));
    const store = new GrokSessionStore({ filePath: GrokSessionStore.defaultPath(join(root, "agent", "sessions")) });
    const turn = { provider: "xai", model: "grok-4.6", billing: "subscription" as const, inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 12, costUsd: 0.001, turns: 1, at: 5 };
    await store.recordUsage("thread-1", "/repo", { ...turn }, turn);
    const usage = caller("tau.usage");
    const stranger = caller("acme.stranger");
    await registry.activate(usage);
    await registry.activate(stranger);
    await expect(usage.call!("usage")).resolves.toMatchObject({ threads: [{ threadId: "thread-1", usage: { totalTokens: 12 }, turns: [{ model: "grok-4.6", billing: "subscription" }] }] });
    await expect(usage.call!("usage-limits")).resolves.toEqual({ accounts: [{ id: "grok:default", runtime: "grok", label: "Grok", checkedAt: expect.any(Number), windows: [{ id: "subscription", kind: "monthly", label: "Monthly", usedPercent: 12 }] }] });
    // Asked again within five minutes, the window comes from memory.
    await usage.call!("usage-limits");
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(stranger.call!("usage")).rejects.toThrow(/not allowed/u);
    await expect(stranger.call!("usage-limits")).rejects.toThrow(/not allowed/u);
  });
});
