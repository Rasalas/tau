import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientMessageFingerprint } from "../shared/client-message-correlation.js";
import { createHostMethods, invokeHostMethod } from "./host-methods.js";
import { HostJobRunner } from "./host-jobs.js";
import { PiHost } from "./pi-host.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { ThreadRuntime } from "./thread-runtime.js";

function methodsFor(host: PiHost) {
  const unsupported = (): never => { throw new Error("not in this test"); };
  return createHostMethods({
    bootstrap: unsupported,
    requireHost: async () => host,
    host: () => host,
    jobs: new HostJobRunner(() => undefined),
    platform: {
      copyText: unsupported, copyImage: unsupported, readImagePreview: unsupported,
      inspectExtensions: unsupported, loadDesktopExtensions: unsupported, rebuildWorkbench: unsupported,
      workbenchSource: unsupported, relaunchWorkbench: unsupported, installUpdate: unsupported,
      notify: unsupported, setBadge: unsupported,
    },
  });
}

function fakeThread(threadId: string, cwd: string, delivered: string[]): ThreadRuntime {
  let hasMessages = threadId === "saved";
  const backend = {
    kind: "pi" as const,
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId,
    providerSessionId: threadId,
    cwd,
    turnReporting: "streamed" as const,
    capabilities: { journal: { entries: () => [], appendCustomEntry: () => undefined, appendMessage: () => undefined } },
    preparePrompt: async (text: string) => ({
      tauThreadId: threadId, providerSessionId: threadId, sessionId: threadId,
      backendKind: "pi" as const, runtimeCapabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities,
      visibleText: text, runtimeText: text, sourceFingerprint: clientMessageFingerprint(text, []),
    }),
    composerCommands: () => [],
    prompt: async (input: { text: string; onAdmitted?: (accepted: boolean) => void }) => {
      delivered.push(`${threadId}:${input.text}`);
      hasMessages = true;
      input.onAdmitted?.(true);
      return {};
    },
    state: () => ({
      streaming: false, idle: true, hasMessages, sessionFile: `/sessions/${threadId}.jsonl`,
      activeTools: [], supportsImageInput: false, extensionCount: 0,
    }),
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: ["off"], allTools: [] }),
    models: async () => [], transcript: async () => [], persist: async () => undefined,
    setTitle: async () => undefined, abort: async () => undefined, dispose: async () => undefined,
    start: async () => undefined, waitForIdle: async () => undefined,
  };
  const runtime = {
    session: { sessionId: threadId, abort: async () => undefined, dispose: async () => undefined },
    dispose: async () => undefined,
  };
  return new ThreadRuntime(backend as never, runtime as never);
}

function offScreenHost() {
  const delivered: string[] = [];
  const history = { list: () => [], isHidden: () => false, remember: async () => undefined };
  const host = new PiHost("/repo", () => undefined, history as never, false, false);
  const internals = host as unknown as Record<string, any>;
  internals.rememberProject = async () => {};
  internals.prewarm.scheduleThreads = () => {};
  internals.prewarm.scheduleSpare = () => {};
  internals.projects.label = () => undefined;
  internals.projects.name = () => "repo";
  const active = fakeThread("active", "/repo", delivered);
  internals.threads.adopt({ threadId: "active", cwd: "/repo", runtime: active, isolation: "in-process" });
  internals.threads.setActive("active");
  internals.runtimes.open = async (manager: { getCwd(): string }) => fakeThread("child", manager.getCwd(), delivered);
  const opened: string[] = [];
  internals.runtimes.openForPath = async (path: string) => {
    opened.push(path);
    const thread = fakeThread("saved", "/repo", delivered);
    internals.threads.adopt({ threadId: "saved", cwd: "/repo", runtime: thread, isolation: "in-process" });
    return thread;
  };
  return { host, internals, delivered, opened, methods: methodsFor(host) };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("off-screen core thread methods", () => {
  it.each(["/other", "workspace"])("starts a thread in %s without changing the active thread", async (cwd) => {
    const bench = offScreenHost();
    const workspaceId = bench.internals.workspaces.ref("/other").workspaceId;
    const before = bench.internals.active.threadId;

    await expect(invokeHostMethod(bench.methods, "start-thread", [{ cwd: cwd === "workspace" ? workspaceId : cwd, prompt: "hello" }]))
      .resolves.toEqual({ sessionId: "child", path: "/sessions/child.jsonl", cwd: "/other" });

    expect(bench.internals.active.threadId).toBe(before);
    expect(bench.host.activeWorkspacePath()).toBe("/repo");
    expect(bench.delivered).toEqual(["child:hello"]);
  });

  it("reopens a released thread and delivers a prompt without changing the active thread", async () => {
    const bench = offScreenHost();
    vi.spyOn(SessionManager, "listAll").mockResolvedValue([{
      path: "/sessions/saved.jsonl", id: "saved", cwd: "/repo", created: new Date(1), modified: new Date(2),
      messageCount: 2, firstMessage: "earlier", allMessagesText: "earlier",
    }]);
    await bench.internals.index.refresh("none");
    await bench.internals.runtimes.openForPath("/sessions/saved.jsonl");
    await bench.internals.threads.release("saved");
    bench.opened.length = 0;
    const before = bench.internals.active.threadId;

    await expect(invokeHostMethod(bench.methods, "send-to-thread", ["saved", "continue"])).resolves.toBeNull();

    expect(bench.opened).toEqual(["/sessions/saved.jsonl"]);
    expect(bench.delivered).toEqual(["saved:continue"]);
    expect(bench.internals.active.threadId).toBe(before);
  });

  it("passes only the supported start options to the host", async () => {
    const startThread = vi.fn(async () => ({ sessionId: "s1", cwd: "/repo", title: "Child" }));
    const fake = {
      startThread, threadPath: () => "backend:s1", resolveWorkspacePath: () => "/repo",
    } as unknown as PiHost;
    const options = {
      cwd: "ws:repo", prompt: "hello", backend: "fake", model: { provider: "test", id: "small" },
      thinkingLevel: "off", mode: "plan", title: "Child",
    };
    await expect(invokeHostMethod(methodsFor(fake), "start-thread", [{ ...options, attachments: ["unsupported"], parent: { threadId: "other" } }]))
      .resolves.toEqual({ sessionId: "s1", path: "backend:s1", cwd: "/repo", title: "Child" });
    expect(startThread).toHaveBeenCalledWith({ ...options, cwd: "/repo" });
  });

  it.each([undefined, "prompt", "steer", "queue"])("delivers with %s", async (delivery) => {
    const sendToThread = vi.fn(async () => undefined);
    const table = methodsFor({ sendToThread } as unknown as PiHost);
    await expect(invokeHostMethod(table, "send-to-thread", ["s1", "hello", delivery])).resolves.toBeNull();
    expect(sendToThread).toHaveBeenCalledWith("s1", "hello", delivery ?? "prompt");
  });

  it.each([
    ["start-thread", []],
    ["start-thread", [null]],
    ["start-thread", [{ cwd: 1, prompt: "hello" }]],
    ["start-thread", [{ cwd: "/repo", prompt: "" }]],
    ["start-thread", [{ cwd: "/repo", prompt: "hello", backend: 1 }]],
    ["start-thread", [{ cwd: "/repo", prompt: "hello", model: { provider: "test", id: 1 } }]],
    ["start-thread", [{ cwd: "/repo", prompt: "hello", thinkingLevel: false }]],
    ["start-thread", [{ cwd: "/repo", prompt: "hello", mode: [] }]],
    ["start-thread", [{ cwd: "/repo", prompt: "hello", title: {} }]],
    ["send-to-thread", [1, "hello"]],
    ["send-to-thread", ["s1", false]],
    ["send-to-thread", ["s1", "hello", "invalid"]],
    ["send-to-thread", ["s1", "hello", null]],
  ])("refuses malformed %s params before calling the host", async (method, params) => {
    const startThread = vi.fn();
    const sendToThread = vi.fn();
    await expect(invokeHostMethod(methodsFor({ startThread, sendToThread } as unknown as PiHost), method as string, params as unknown[])).rejects.toThrow(method as string);
    expect(startThread).not.toHaveBeenCalled();
    expect(sendToThread).not.toHaveBeenCalled();
  });
});
