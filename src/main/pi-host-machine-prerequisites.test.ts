import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostEvent, UiMessage } from "../shared/contracts.js";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import type { HostBackendThreadRecord, HostExtension, HostRuntimeBackendProvider } from "./host-extensions.js";
import { PiHost } from "./pi-host.js";
import { externalThreadPath } from "./pi-host-support.js";
import { ProjectHistory } from "./project-history.js";
import type { AgentRuntimeAdapter } from "./runtime-adapters.js";
import type { ThreadRuntimeBackend } from "./runtime-types.js";
import { WorkspaceIdentity } from "./workspace-identity.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

function adapter(kind: string): AgentRuntimeAdapter {
  return { id: kind, capabilities: { skillInvocationDialect: "pi" }, transport: { sendPrompt: async () => ({}) } };
}

function backend(kind: string, record: HostBackendThreadRecord): ThreadRuntimeBackend {
  const runtimeAdapter = adapter(kind);
  const messages: UiMessage[] = record.messages.map((message, position) => ({ ...message, id: `m${position}`, timestamp: position }));
  return {
    kind, runtimeAdapter, threadId: record.threadId, providerSessionId: record.threadId, cwd: record.cwd,
    capabilities: {}, turnReporting: "streamed",
    start: async () => undefined,
    dispose: async () => undefined,
    state: () => ({
      streaming: false, idle: true, hasMessages: messages.length > 0, title: record.title,
      sessionFile: externalThreadPath(kind, record.threadId), activeTools: [], supportsImageInput: false, extensionCount: 0,
    }),
    waitForIdle: async () => undefined,
    preparePrompt: async (text) => ({
      tauThreadId: record.threadId, providerSessionId: record.threadId, sessionId: record.threadId,
      backendKind: kind, runtimeCapabilities: runtimeAdapter.capabilities, visibleText: text, runtimeText: text,
      sourceFingerprint: clientMessageFingerprint(text, []),
    }),
    prompt: async () => ({}),
    abort: async () => undefined,
    transcript: async () => messages,
    persist: async () => undefined,
    setTitle: async () => undefined,
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] }),
    models: async () => [],
    composerCommands: () => [],
  };
}

/** Real host startup, activation and index, with external runtimes instead of a Pi session or network. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tau-machine-prerequisites-"));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const workspace = join(root, "local");
  const agentDir = join(root, "agent");
  const sessionsDir = join(root, "sessions");
  await Promise.all([workspace, agentDir, sessionsDir].map((path) => mkdir(path)));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", sessionsDir);
  vi.stubEnv("TAU_CONFIG_FILE", join(root, "config.json"));
  vi.stubEnv("TAU_THEMES_DIR", join(root, "themes"));
  vi.stubEnv("TAU_PACKAGES_HOME", join(root, "packages"));
  const missingCwd = join(root, "nonexistent", "x");
  const record: HostBackendThreadRecord = {
    threadId: "0123456789abcdef0123456789abcdef~t1", cwd: missingCwd, title: "Rex thread", updatedAt: 1,
    messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "ready" }],
  };
  const store = join(root, "backend-store.json");
  await writeFile(store, JSON.stringify(record));
  const readRecord = async (): Promise<HostBackendThreadRecord> => JSON.parse(await readFile(store, "utf8"));
  const open = async () => {
    const opened: Array<{ threadId: string; cwd: string; resume: boolean }> = [];
    const listed = vi.fn(async () => [await readRecord()]);
    const machine: HostRuntimeBackendProvider = {
      kind: "machine", adapter: adapter("machine"), listThreads: listed, composerCommands: () => [],
      lookup: async (threadId) => { const saved = await readRecord(); return saved.threadId === threadId ? saved : undefined; },
      open: async (threadId, cwd, options) => {
        opened.push({ threadId, cwd, resume: options.resume });
        return backend("machine", await readRecord());
      },
    };
    const initial: HostRuntimeBackendProvider = {
      kind: "fixture", adapter: adapter("fixture"), listThreads: async () => [], lookup: async () => undefined, composerCommands: () => [],
      open: async (threadId, cwd) => backend("fixture", { threadId, cwd, updatedAt: 0, messages: [] }),
    };
    const kit: HostExtension = {
      id: "test.machine", name: "Machine prerequisite fixture", permissions: ["runtime:extend"],
      activate: (context) => {
        const stops = [context.services.registerRuntimeBackend(initial), context.services.registerRuntimeBackend(machine)];
        return () => { for (const stop of stops) stop(); };
      },
    };
    const history = new ProjectHistory(join(root, "project-history.json"));
    await history.load();
    const events: HostEvent[] = [];
    const host = new PiHost(workspace, (event) => events.push(event), history, false, false, {
      hostExtensions: [kit], defaultBackendKind: "fixture", kitStateDir: join(root, "kit-state"),
      workspaceIdentity: new WorkspaceIdentity("abcdef0123456789abcdef0123456789"),
      createModelRuntime: async () => ({ getAvailable: async () => [], getModels: () => [], getModel: () => undefined, isUsingSubscription: () => false }) as never,
    });
    let disposed = false;
    const dispose = async () => { if (!disposed) { disposed = true; await host.dispose(); } };
    cleanups.push(dispose);
    await host.start();
    await expect.poll(() => host.threadPath(record.threadId)).toBe(externalThreadPath("machine", record.threadId));
    return { host, events, opened, listed, dispose };
  };
  return { open, record, missingCwd };
}

describe("machine backend host prerequisites", () => {
  it("activates and publishes a machine thread whose cwd is absent here without creating its folder", async () => {
    const { open, record, missingCwd } = await fixture();
    const { host, opened, events } = await open();
    expect(existsSync(missingCwd)).toBe(false);
    const result = await host.switchSession(host.threadPath(record.threadId)!);
    expect(result.updates).toContainEqual(expect.objectContaining({
      type: "thread-detail", detail: expect.objectContaining({ sessionId: record.threadId, backendKind: "machine" }),
    }));
    expect(result.updates).toContainEqual(expect.objectContaining({
      type: "project", sessionId: record.threadId, project: expect.objectContaining({ cwd: missingCwd }),
    }));
    expect(opened).toEqual([{ threadId: record.threadId, cwd: missingCwd, resume: true }]);
    expect((await host.snapshot()).messages.map((message) => message.text)).toEqual(["hello", "ready"]);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(existsSync(missingCwd)).toBe(false);
    expect(existsSync(join(missingCwd, ".."))).toBe(false);
  });

  it("lists the durable machine row again after restart and reopens it with resume true", async () => {
    const { open, record, missingCwd } = await fixture();
    const first = await open();
    const path = first.host.threadPath(record.threadId)!;
    await first.host.switchSession(path);
    await first.dispose();
    const second = await open();
    expect(second.listed).toHaveBeenCalled();
    const bootstrap = await second.host.bootstrap();
    expect(bootstrap.threadIndex.sessions).toContainEqual(expect.objectContaining({
      id: record.threadId, path, backendKind: "machine", projectPath: missingCwd, title: record.title,
    }));
    expect(second.opened).toEqual([]);
    const result = await second.host.switchSession(path);
    expect(second.opened).toEqual([{ threadId: record.threadId, cwd: missingCwd, resume: true }]);
    expect(result.updates).toContainEqual(expect.objectContaining({
      type: "thread-detail", detail: expect.objectContaining({ sessionId: record.threadId }),
    }));
    expect(existsSync(missingCwd)).toBe(false);
  });
});
