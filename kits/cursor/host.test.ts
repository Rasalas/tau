import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtension, HostMcpConnection, HostRuntimeBackendProvider } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { cursorEnvironment } from "./cli.js";
import createCursorHostExtension from "./host.js";
import { CursorSessionStore } from "./session-store.js";

const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-cursor-agent.mjs", import.meta.url));
const TAU_SERVER: HostMcpConnection = { name: "tau", url: "http://127.0.0.1:4100/mcp", token: "secret", headers: { Authorization: "Bearer secret" } };
const INSTALL_SCRIPT = 'DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.10.02-abc1234/${OS}/${ARCH}/agent-cli-package.tar.gz"';
const directories: string[] = [];

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function harness(options: { found?: boolean; env?: Record<string, string> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tau-cursor-host-"));
  directories.push(root);
  const log = join(root, "agent.log");
  const backends: HostRuntimeBackendProvider[] = [];
  const connects: unknown[] = [];
  const fetch = vi.fn(async () => ({ ok: true, text: async () => INSTALL_SCRIPT }) as unknown as Response);
  const extension = createCursorHostExtension({
    env: { PATH: process.env.PATH ?? "", CURSOR_DATA_DIR: join(root, "cursor-data"), FAKE_CURSOR_LOG: log, ...options.env },
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  const registry = await activateHostKit(extension, {
    mcp: { registerTools: () => () => undefined, gate: () => () => undefined, connect: async (scope) => { connects.push(scope); return TAU_SERVER; } },
    findCommand: (name) => (name === "cursor-agent" || name === FAKE_CLI) && options.found !== false ? FAKE_CLI : undefined,
    sessionsDir: join(root, "agent", "sessions"),
    stateDir: join(root, "state"),
    noteSubprocess: () => undefined,
    registerRuntimeBackend: (provider) => {
      backends.push(provider);
      return () => { backends.splice(backends.indexOf(provider), 1); };
    },
  });
  const sent = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
  return { registry, provider: backends[0]!, backend: (kind: string) => backends.find((entry) => entry.kind === kind), root, sent, connects, fetch };
}

const context = { projectName: "repo", permissionLevel: () => "full", onMessage: () => undefined, onEvent: () => undefined, ask: async () => ({ cancelled: true }) } as never;

function caller(id: string): HostExtension & { call?: (command: string, input?: unknown) => Promise<unknown> } {
  const extension: HostExtension & { call?: (command: string, input?: unknown) => Promise<unknown> } = {
    id, name: id,
    activate(activation) { extension.call = (command, input) => activation.invokeHostExtension("tau.cursor", command, input); },
  };
  return extension;
}

describe("Cursor host half", () => {
  it("registers a Cursor backend that asks for approvals, takes files and plans", async () => {
    const { provider } = await harness();
    expect(provider).toMatchObject({ kind: "cursor", label: "Cursor", order: 50 });
    expect(provider.adapter.capabilities).toMatchObject({ interactiveApprovals: true, fileAttachments: true, modes: ["plan"], ownsModelSelection: false });
  });

  it("lists the account's models with their efforts, from a session that gets no Tau tools", async () => {
    const { provider, sent, connects } = await harness();
    const catalog = await provider.newThreadCatalog!();
    expect(catalog).toMatchObject({
      model: { provider: "cursor", id: "default", name: "Auto" },
      thinkingLevels: { default: ["default"], "composer-2": ["default"], "gpt-5.4": ["default", "low", "medium", "high"] },
    });
    expect(catalog?.models.map((model) => `${model.id}:${model.billing}`)).toEqual(["default:subscription", "composer-2:subscription", "gpt-5.4:subscription"]);
    expect((await sent()).map((message) => message.method).filter(Boolean)).toEqual(["initialize", "authenticate", "cursor/list_available_models"]);
    expect(connects).toEqual([]);
  });

  it("says what stops a catalog: no CLI, a CLI too old for ACP, no sign-in", async () => {
    await expect((await harness({ found: false })).provider.newThreadCatalog!()).resolves.toMatchObject({ models: [], status: "not-installed" });
    const old = await harness({ env: { FAKE_CURSOR_VERSION: "2025.09.18-7ae6800" } });
    await expect(old.provider.newThreadCatalog!()).resolves.toMatchObject({ status: "unavailable", note: expect.stringMatching(/2026\.04\.08 or newer[\s\S]*update/u) });
    // The old CLI was asked for its version only; `acp` would have been a prompt to it.
    expect(await old.sent()).toEqual([]);
    await expect((await harness({ env: { FAKE_CURSOR_SIGNED_OUT: "1" } })).provider.newThreadCatalog!()).resolves.toMatchObject({ status: "sign-in-required" });
  });

  it("runs a thread with Tau's MCP server and resumes it in a new process", async () => {
    const { provider, root, sent, connects } = await harness();
    const backend = await provider.open("tau-thread", root, { resume: false }, context);
    try {
      await expect(backend.prompt({ text: "which mcp?", delivery: "prompt" })).resolves.toEqual({ assistantText: "mcp tau:http" });
    } finally {
      await backend.dispose();
    }
    expect(connects).toEqual([{ sessionId: "tau-thread", cwd: root }]);
    const created = (await sent()).find((message) => message.method === "session/new")!;
    expect(created.params).toMatchObject({ cwd: root, mcpServers: [{ type: "http", name: "tau", url: TAU_SERVER.url, headers: [{ name: "Authorization", value: "Bearer secret" }] }] });
    const again = await provider.open("tau-thread", root, { resume: true }, context);
    try {
      await expect(again.prompt({ text: "history please", delivery: "prompt" })).resolves.toEqual({ assistantText: "history 3" });
      expect((await again.transcript()).map((message) => message.text)).toEqual(["which mcp?", "mcp tau:http", "history please", "history 3"]);
    } finally {
      await again.dispose();
    }
    expect((await sent()).filter((message) => message.method === "session/load")).toHaveLength(1);
  });

  it("refuses a thread on a CLI older than ACP", async () => {
    const { provider, root } = await harness({ env: { FAKE_CURSOR_VERSION: "2025.09.18-7ae6800" } });
    await expect(provider.version!()).resolves.toMatchObject({ installed: "2025.09.18-7ae6800", compatibility: { status: "broken" } });
    const backend = await provider.open("tau-old", root, { resume: false }, context);
    await expect(backend.prompt({ text: "Hi", delivery: "prompt" })).rejects.toThrow(/does not work with Tau/u);
    await backend.dispose();
  });

  it("reports version, the newest release, the account and the models", async () => {
    const { provider, registry } = await harness({ env: { FAKE_CURSOR_VERSION: "2026.09.18-9a7762b" } });
    await expect(provider.version!()).resolves.toEqual({ tool: "cursor-agent", installed: "2026.09.18-9a7762b", latest: "2026.10.02-abc1234", updateCommand: `${FAKE_CLI} update` });
    await expect(registry.invoke("tau.cursor", "status")).resolves.toMatchObject({
      instance: "default", command: "cursor-agent", path: FAKE_CLI, version: "2026.09.18-9a7762b", latest: "2026.10.02-abc1234", updateAvailable: true,
      signedIn: true, account: "tester@example.invalid", plan: "Pro", models: 3,
    });
  });

  it("gives an instance's home to the CLI as its config and data folder with a file login", () => {
    expect(cursorEnvironment({ TAU_CURSOR_HOME: "/shadow", PATH: "/bin" })).toEqual({ TAU_CURSOR_HOME: "/shadow", PATH: "/bin", CURSOR_CONFIG_DIR: "/shadow", CURSOR_DATA_DIR: "/shadow", AGENT_CLI_CREDENTIAL_STORE: "file" });
    expect(cursorEnvironment({ PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });

  it("registers a backend per instance and starts it with the instance's arguments", async () => {
    const { registry, backend, sent } = await harness();
    const report = await registry.invoke("tau.cursor", "save-instance", { instance: { id: "work", name: "Work", args: "--model-hint x" } });
    expect(report).toMatchObject({ instances: [{ id: "default" }, { id: "work", kind: "cursor@work", label: "Cursor · Work" }] });
    const work = backend("cursor@work")!;
    expect(work.label).toBe("Cursor · Work");
    // The fake refuses anything but `… acp` as its last argument, so the extra arguments came first.
    await expect(work.newThreadCatalog!()).resolves.toMatchObject({ models: expect.arrayContaining([expect.objectContaining({ id: "gpt-5.4" })]) });
    expect((await sent()).some((message) => message.method === "cursor/list_available_models")).toBe(true);
    await expect(registry.invoke("tau.cursor", "remove-instance", { instance: "work" })).resolves.toMatchObject({ instances: [{ id: "default" }] });
    expect(backend("cursor@work")).toBeUndefined();
  });

  it("hands each thread's running total to the Usage kit and to no other kit", async () => {
    const { registry, root } = await harness();
    const store = new CursorSessionStore({ filePath: CursorSessionStore.defaultPath(join(root, "agent", "sessions")) });
    await store.recordUsage("thread-1", "/repo", { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 12, costUsd: 0, turns: 1 });
    await store.setObservedModel("thread-1", "/repo", "gpt-5.4");
    const usage = caller("tau.usage");
    const stranger = caller("acme.stranger");
    await registry.activate(usage);
    await registry.activate(stranger);
    await expect(usage.call!("usage")).resolves.toMatchObject({ threads: [{ threadId: "thread-1", model: "gpt-5.4", usage: { totalTokens: 12 } }] });
    await expect(stranger.call!("usage")).rejects.toThrow(/not allowed/u);
  });

  it("hands the text of its threads to the Search kit and to no other kit", async () => {
    const { registry, root } = await harness();
    const store = new CursorSessionStore({ filePath: CursorSessionStore.defaultPath(join(root, "agent", "sessions")) });
    await store.appendMessages("thread-1", "/repo", [
      { id: "u1", role: "user", text: "Rename the queue", timestamp: 1 },
      { id: "a1", role: "assistant", text: "Renamed it.", timestamp: 2 },
    ] as never);
    const search = caller("tau.search");
    const usage = caller("tau.usage");
    await registry.activate(search);
    await registry.activate(usage);
    await expect(search.call!("thread-texts", {})).resolves.toMatchObject({
      threads: [{ threadId: "thread-1", messages: [{ role: "user", text: "Rename the queue" }, { role: "assistant", text: "Renamed it." }] }],
      removed: [],
    });
    await expect(usage.call!("thread-texts", {})).rejects.toThrow(/not allowed/u);
  });
});
