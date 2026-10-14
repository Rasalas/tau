import { expect, it, vi } from "vitest";
import { completeCodex } from "./completion.js";
import type { CodexSessionInput, CodexSessionLike } from "./thread-backend.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServer, type CodexPolicy } from "./app-server.js";
import { spawnRpcProcess } from "./rpc.js";
import frames from "./fixtures/app-server-frames.json" with { type: "json" };

it("completes without starting configured MCP servers, plugins or apps", async () => {
  await withStub(async (open, sent) => {
    await expect(completeCodex(open, "/repo", frames.models[0]!.model, "low", { system: "Title", prompt: "Task" })).resolves.toBe("hello");
    const messages = await sent();
    expect(messages.filter((entry) => entry.startedMcp || entry.startedPlugin || entry.startedApps)).toEqual([]);
    expect(messages.find((entry) => entry.method === "config/read")?.params).toEqual({ includeLayers: false, cwd: "/repo" });
    expect(messages.find((entry) => entry.method === "thread/start")?.params?.config).not.toHaveProperty("mcp_optional_startup_grace_ms");
    expect(messages.find((entry) => entry.method === "thread/start")?.params?.config).toMatchObject({
      mcp_servers: { personal: { enabled: false }, "with.dot": { enabled: false }, ["__proto__"]: { enabled: false }, disabled: { enabled: false } },
      "features.plugins": false, "features.apps": false,
      "features.shell_tool": false, "features.apply_patch_tool": false,
    });
  });
});

it("keeps configured servers and plugins with startup grace for ordinary threads", async () => {
  await withStub(async (open, sent) => {
    const session = await open({ cwd: "/repo", onNotification: () => undefined, onRequest: async () => ({}), onExit: () => undefined });
    const policy: CodexPolicy = { approvalPolicy: "never", sandbox: "read-only", sandboxPolicy: { type: "readOnly" } };
    try {
      const info = await session.startThread({ cwd: "/repo", policy });
      await session.resumeThread({ threadId: info.thread.id, cwd: "/repo", policy });
    } finally { await session.close(); }
    const messages = await sent();
    const requests = messages.filter((entry) => entry.method === "thread/start" || entry.method === "thread/resume");
    expect(requests.map((entry) => entry.method)).toEqual(["thread/start", "thread/resume"]);
    for (const request of requests) {
      expect(request.params?.config).toEqual({ mcp_optional_startup_grace_ms: 10_000 });
    }
    expect(messages.filter((entry) => entry.startedMcp).map((entry) => entry.startedMcp)).toEqual(["personal", "with.dot", "__proto__"]);
    expect(messages.some((entry) => entry.startedPlugin)).toBe(true);
    expect(messages.some((entry) => entry.startedApps)).toBe(true);
    expect(messages.some((entry) => entry.method === "config/read")).toBe(false);
  });
});

it("refuses a completion when the configured servers cannot be read", async () => {
  await withStub(async (open, sent) => {
    await expect(completeCodex(open, "/repo", frames.models[0]!.model, "low", { system: "Title", prompt: "Task" })).rejects.toThrow("Cannot read configuration");
    expect((await sent()).some((entry) => entry.method === "thread/start")).toBe(false);
  }, true);
});

interface StubMessage {
  method?: string;
  params?: { config?: unknown; [key: string]: unknown };
  startedMcp?: string;
  startedPlugin?: string;
  startedApps?: boolean;
}

async function withStub(run: (open: (input: CodexSessionInput) => Promise<CodexSessionLike>, sent: () => Promise<StubMessage[]>) => Promise<void>, configError = false) {
  const dir = await mkdtemp(join(tmpdir(), "tau-completion-"));
  const log = join(dir, "messages.jsonl");
  const config = join(dir, "config.json");
  const sessions: CodexAppServer[] = [];
  await writeFile(config, JSON.stringify({
    mcp_servers: { personal: {}, "with.dot": {}, ["__proto__"]: {}, disabled: { enabled: false } },
    features: { plugins: true, apps: true },
  }));
  try {
    await run(async (input) => {
      const session = await CodexAppServer.open({
        command: process.execPath, cwd: dir,
        env: { ...process.env, CODEX_HOME: join(dir, "home"), STUB_LOG: log, STUB_CONFIG: config, ...(configError ? { STUB_CONFIG_ERROR: "1" } : {}) },
        clientVersion: "test",
        spawn: (launch) => spawnRpcProcess({ ...launch, args: [fileURLToPath(new URL("./fixtures/stub-app-server.mjs", import.meta.url)), ...launch.args] }),
        onNotification: input.onNotification, onRequest: input.onRequest, onExit: input.onExit,
      });
      sessions.push(session);
      return session;
    }, async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)));
  } finally {
    await Promise.all(sessions.map((session) => session.close()));
    await rm(dir, { recursive: true, force: true });
  }
}

it("closes a failed completion without waiting for an unresolved startTurn request", async () => {
  const close = vi.fn(async () => undefined);
  const open = async (input: CodexSessionInput) => ({
    startThread: async () => ({ thread: { id: "helper" }, model: "gpt-6-luna", reasoningEffort: "low" }),
    startTurn: async () => {
      input.onNotification("turn/completed", { threadId: "helper", turn: { status: "failed", error: { message: "Model unavailable" } } });
      return new Promise<string>(() => undefined);
    }, close,
  }) as unknown as CodexSessionLike;
  await expect(completeCodex(open, "/repo", "gpt-6-luna", "low", { system: "Title", prompt: "Task" })).rejects.toThrow("Model unavailable");
  expect(close).toHaveBeenCalledOnce();
});

it("times out and closes a completion whose thread/start never answers", async () => {
  const close = vi.fn(async () => undefined);
  const open = async () => ({ startThread: () => new Promise(() => undefined), close }) as unknown as CodexSessionLike;
  vi.useFakeTimers();
  try {
    const result = completeCodex(open, "/repo", "gpt-6-luna", "low", { system: "Title", prompt: "Task" });
    const rejected = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(25_000);
    await rejected;
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
