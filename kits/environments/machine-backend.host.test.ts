import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeAdapter, HostExtension, HostMachineServices, HostRuntimeBackendProvider, ThreadRuntimeBackend, UiSession } from "tau/host-extension";
import { PiHost, ProjectHistory, WorkspaceIdentity, externalThreadPath } from "../../src/main/test-support/machine-backend-harness.js";
import { createEnvironmentsHostExtension } from "./host.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

const adapter: AgentRuntimeAdapter = { id: "fixture", capabilities: { skillInvocationDialect: "pi" }, transport: { sendPrompt: async () => ({}) } };
function initialBackend(threadId: string, cwd: string): ThreadRuntimeBackend {
  return {
    kind: "fixture", threadId, providerSessionId: threadId, cwd, runtimeAdapter: adapter, capabilities: {}, turnReporting: "streamed",
    start: async () => undefined, dispose: async () => undefined, waitForIdle: async () => undefined,
    state: () => ({ streaming: false, idle: true, hasMessages: false, activeTools: [], supportsImageInput: false, extensionCount: 0 }),
    preparePrompt: async () => { throw new Error("No prompt in this fixture."); },
    prompt: async () => ({}), abort: async () => undefined, transcript: async () => [], persist: async () => undefined, setTitle: async () => undefined,
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] }), models: async () => [], composerCommands: () => [],
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tau-machine-backend-"));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const local = join(root, "local");
  const agent = join(root, "agent");
  const sessions = join(root, "sessions");
  await Promise.all([local, agent, sessions].map((path) => mkdir(path)));
  vi.stubEnv("PI_CODING_AGENT_DIR", agent);
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", sessions);
  vi.stubEnv("TAU_CONFIG_FILE", join(root, "config.json"));
  vi.stubEnv("TAU_THEMES_DIR", join(root, "themes"));
  vi.stubEnv("TAU_PACKAGES_HOME", join(root, "packages"));
  const machine = { id: "0123456789abcdef0123456789abcdef", name: "rex", status: "connected" as const, address: "wss://rex/" };
  const remote: UiSession = {
    id: "t1~saved", path: "/remote/session.jsonl", title: "Rex work", modifiedAt: 1,
    projectPath: join(root, "nonexistent", "x"), projectName: "x", messageCount: 2, backendKind: "codex", modelProvider: "openai", model: "gpt-test",
  };
  const catalog = { kind: "codex", models: [{ provider: "openai", id: "gpt-test", name: "GPT Test", images: true }, { provider: "openai", id: "gpt-small", name: "GPT Small" }], thinkingLevels: {} };
  const request = vi.fn(async (_machine: string, method: string) => {
    if (method === "runtime-catalog") return catalog;
    if (method !== "transcript-page") throw new Error(`Unexpected remote call ${method}`);
    return { sessionId: remote.id, messages: [{ id: "u", role: "user", text: "hello", timestamp: 1 }, { id: "a", role: "assistant", text: "ready", timestamp: 2 }], hasMore: false };
  });
  const machines: HostMachineServices = {
    self: { id: "here", name: "here", version: "1" }, list: () => [machine], subscribe: () => () => undefined,
    call: vi.fn(async () => undefined), request, watch: () => () => undefined, upload: vi.fn(),
    index: () => ({ projects: [], sessions: [remote] }), running: () => new Set(), subscribeIndex: () => () => undefined,
    followThread: vi.fn(() => () => undefined),
  };
  const initial: HostRuntimeBackendProvider = {
    kind: "fixture", adapter, listThreads: async () => [], lookup: async () => undefined, composerCommands: () => [],
    open: async (threadId, cwd) => initialBackend(threadId, cwd),
  };
  const initialKit: HostExtension = {
    id: "test.initial", name: "Initial runtime", permissions: ["runtime:extend"],
    activate: (context) => context.services.registerRuntimeBackend(initial),
  };
  const open = async () => {
    const history = new ProjectHistory(join(root, "projects.json"));
    await history.load();
    const host = new PiHost(local, () => undefined, history, false, false, {
      hostExtensions: [initialKit, createEnvironmentsHostExtension()], defaultBackendKind: "fixture", kitStateDir: join(root, "kit-state"),
      machines, workspaceIdentity: new WorkspaceIdentity("abcdef0123456789abcdef0123456789"),
      createModelRuntime: async () => ({ getAvailable: async () => [], getModels: () => [], getModel: () => undefined, isUsingSubscription: () => false }) as never,
    });
    let disposed = false;
    const dispose = async () => { if (!disposed) { disposed = true; await host.dispose(); } };
    cleanups.push(dispose);
    await host.start();
    await expect.poll(() => host.threadPath(`${machine.id}~${remote.id}`)).toBe(externalThreadPath("machine", `${machine.id}~${remote.id}`));
    return { host, dispose };
  };
  return { remote, machine, request, machines, open, proxyId: `${machine.id}~${remote.id}` };
}

describe("machine provider in the real host", () => {
  it("keeps a remote worktree's project name and icon through indexing and activation", async () => {
    const f = await fixture();
    const icon = "data:image/svg+xml;base64,PHN2Zy8+";
    f.remote.projectName = "Tau";
    f.remote.workspaceId = "remote-worktree";
    f.machines.index = () => ({
      projects: [{ path: "/remote/tau", workspaceId: "remote-root", name: "Tau", lastOpenedAt: 1, icon }],
      sessions: [f.remote],
    });
    const { host } = await f.open();
    const check = async () => {
      const { threadIndex } = await host.bootstrap();
      expect(threadIndex.sessions.find((entry) => entry.id === f.proxyId)?.projectName).toBe("Tau");
      expect(threadIndex.projects.find((entry) => entry.workspaceId === "remote-worktree")?.icon).toBe(icon);
    };
    await check();
    await host.switchSession(externalThreadPath("machine", f.proxyId));
    await check();
    expect(existsSync(f.remote.projectPath)).toBe(false);
  });

  it("lists the machine row, hides the backend from new threads, activates without moving rex, and resumes after restart", async () => {
    const f = await fixture();
    const first = await f.open();
    const bootstrap = await first.host.bootstrap();
    const path = externalThreadPath("machine", f.proxyId);
    expect(bootstrap.threadIndex.sessions).toContainEqual(expect.objectContaining({
      id: f.proxyId, path, backendKind: "machine", title: "Rex work", messageCount: 2,
      machine: { id: f.machine.id, name: "rex", backendKind: "codex", modelProvider: "openai" },
    }));
    expect(bootstrap.catalog.runtimeBackends?.some((backend) => backend.kind === "machine")).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
    const switched = await first.host.switchSession(path);
    expect(switched.updates).toContainEqual(expect.objectContaining({ type: "thread-detail", detail: expect.objectContaining({ sessionId: f.proxyId, providerSessionId: f.remote.id, backendKind: "machine" }) }));
    expect((await first.host.snapshot()).messages.map((message) => message.text)).toEqual(["hello", "ready"]);
    expect(f.machines.followThread).toHaveBeenCalledWith(f.machine.id, f.remote.id, expect.any(Function));
    expect([...new Set(f.request.mock.calls.map((call) => call[1]))].sort()).toEqual(["runtime-catalog", "transcript-page"]);
    expect(existsSync(f.remote.projectPath)).toBe(false);
    expect(existsSync(join(f.remote.projectPath, ".."))).toBe(false);
    await first.dispose();
    f.request.mockClear();
    const second = await f.open();
    expect((await second.host.bootstrap()).threadIndex.sessions).toContainEqual(expect.objectContaining({ id: f.proxyId, path, machine: expect.objectContaining({ name: "rex" }) }));
    await second.host.switchSession(path);
    expect((await second.host.snapshot()).messages.map((message) => message.text)).toEqual(["hello", "ready"]);
    expect([...new Set(f.request.mock.calls.map((call) => call[1]))].sort()).toEqual(["runtime-catalog", "transcript-page"]);
    expect(existsSync(f.remote.projectPath)).toBe(false);
  });

  it("renames, attaches an image and changes the model through the home machine", async () => {
    const f = await fixture();
    const { host } = await f.open();
    await host.switchSession(externalThreadPath("machine", f.proxyId));
    const bootstrap = await host.bootstrap();
    expect(bootstrap.catalog.models.map((model) => model.id)).toEqual(["gpt-test", "gpt-small"]);
    expect(bootstrap.catalog.supportsImageInput).toBe(true);
    const home = (command: string, input: unknown) => [f.machine.id, "tau.environments", command, input, undefined];
    await host.renameThread("Better name", f.proxyId);
    expect(f.machines.call).toHaveBeenLastCalledWith(...home("thread-rename", { sessionId: f.remote.id, title: "Better name" }));
    expect((await host.bootstrap()).threadIndex.sessions).toContainEqual(expect.objectContaining({ id: f.proxyId, title: "Better name" }));
    await host.setModel("openai", "gpt-small");
    expect(f.machines.call).toHaveBeenLastCalledWith(...home("thread-model", { sessionId: f.remote.id, provider: "openai", id: "gpt-small" }));
    expect((await host.snapshot()).model).toMatchObject({ id: "gpt-small" });
    await host.setModel("openai", "gpt-test");
    const image = { kind: "image" as const, name: "x.png", mimeType: "image/png", data: "AA==", size: 1 };
    await host.prompt("look", [image], f.proxyId);
    expect(f.machines.call).toHaveBeenLastCalledWith(f.machine.id, "tau.environments", "thread-send", { sessionId: f.remote.id, text: "look", delivery: "prompt", attachments: [image] }, { timeoutMs: 120_000 });
    await host.setModel("openai", "gpt-small");
    await expect(host.prompt("again", [image], f.proxyId)).rejects.toThrow("The active model does not support image input.");
  });
});
