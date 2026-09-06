import { describe, expect, it, vi } from "vitest";
import type { GlobalHostEvent, UiMessage } from "../../shared/contracts.js";
import {
  AGENTS_HOST_EXTENSION_ID,
  AGENT_CHILD_ENTRY,
  AGENT_PARENT_ENTRY,
  MAX_CHILDREN_PER_PARENT,
} from "../../shared/agents-kit-protocol.js";
import {
  HostExtensionRegistry,
  type HostExtensionServices,
  type HostThread,
  type HostThreadLifecycle,
  type HostThreadStartOptions,
  type HostTurnObserver,
  type RuntimeExtensionContribution,
} from "../host-extensions.js";
import { createAgentsHostExtension, linksFromEntries, titleFromPrompt } from "./agents-host-extension.js";
import { AgentThreadBook, decodeSpawnRequest, decodeThreadId, decodeTimeout, deriveStatus, parseModel } from "./agents-threads.js";

interface FakeTool {
  name: string;
  execute(toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown): Promise<{ details: unknown }>;
}

interface FakeThread {
  streaming: boolean;
  idle: boolean;
  messages: UiMessage[];
  entries: Array<{ type: "custom"; customType: string; data: unknown }>;
}

function harness() {
  const threads = new Map<string, FakeThread>();
  const started: HostThreadStartOptions[] = [];
  const events: GlobalHostEvent[] = [];
  const observers: HostTurnObserver[] = [];
  const lifecycles: HostThreadLifecycle[] = [];
  const runtimeExtensions: RuntimeExtensionContribution[] = [];
  let nextThread = 0;

  const open = (threadId: string): FakeThread => {
    const thread: FakeThread = { streaming: false, idle: true, messages: [], entries: [] };
    threads.set(threadId, thread);
    return thread;
  };

  const hostThread = (threadId: string): HostThread | undefined => {
    const found = threads.get(threadId);
    if (!found) return undefined;
    return {
      sessionId: threadId,
      cwd: "/project",
      backendKind: "pi",
      sessionFile: `/sessions/${threadId}.jsonl`,
      isStreaming: () => found.streaming,
      isIdle: () => found.idle,
      transcript: async () => found.messages,
      entries: () => found.entries,
      appendEntry: (customType: string, data: unknown) => { found.entries.push({ type: "custom", customType, data }); },
    } as unknown as HostThread;
  };

  const services: HostExtensionServices = {
    cwd: () => "/project",
    safeMode: false,
    log: vi.fn(),
    openWorkspace: async () => ({ version: 1 as const, updates: [] }),
    knownWorkspacePath: async (path) => path,
    workspaceRef: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    projectName: async () => "project",
    rememberProjectName: () => undefined,
    pickDirectory: async () => undefined,
    runtimeOwner: () => "tau" as const,
    thread: (sessionId) => hostThread(sessionId ?? "parent"),
    setThreadTitle: async () => undefined,
    attachedRuntime: () => undefined,
    describeProjects: () => () => undefined,
    noteSubprocess: () => undefined,
    findCommand: () => undefined,
    sessions: {
      list: async () => [{ sessionId: "parent", path: "/sessions/parent.jsonl", cwd: "/project" }, { sessionId: "other", path: "/sessions/other.jsonl", cwd: "/other" }],
      open: () => { throw new Error("no session files in this test"); },
      prepare: async () => { throw new Error("no runtimes in this test"); },
      start: async (options) => {
        started.push(options);
        nextThread += 1;
        const sessionId = `child-${nextThread}`;
        const thread = open(sessionId);
        thread.streaming = true;
        return { sessionId, cwd: options.cwd, ...(options.title ? { title: options.title } : {}) };
      },
      exclusive: (work) => work(),
      refreshIndex: async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }),
    },
    registerThreadLifecycle: (lifecycle) => { lifecycles.push(lifecycle); return () => undefined; },
    registerTurnObserver: (observer) => { observers.push(observer); return () => undefined; },
    pinTranscriptEntries: () => () => undefined,
    decorateUiPrompt: () => () => undefined,
    registerRuntimeExtension: (name, factory, options) => { runtimeExtensions.push({ name, factory, ...options }); return () => undefined; },
    setPermissionLevel: () => undefined,
    registerRuntimeBackend: () => () => undefined,
    presentUi: () => () => undefined,
  };

  const registry = new HostExtensionRegistry(services, (event) => events.push(event));

  /** Loads the kit's Pi extension into one runtime and returns its tools. */
  const runtime = (sessionId: string, cwd = "/project") => {
    const tools = new Map<string, FakeTool>();
    const piEvents = new Map<string, (event: unknown) => void>();
    runtimeExtensions[0]!.factory({
      on: (event: string, handler: (payload: unknown) => void) => { piEvents.set(event, handler); },
      registerTool: (tool: FakeTool) => { tools.set(tool.name, tool); },
    } as never, { sessionId, cwd });
    return {
      call: async (name: string, params: unknown = {}, signal?: AbortSignal) =>
        (await tools.get(name)!.execute("call-1", params, signal, undefined, { model: { provider: "anthropic", id: "sonnet" } })).details,
      fire: (event: string, payload: unknown) => piEvents.get(event)?.(payload),
      names: () => [...tools.keys()],
    };
  };

  return { registry, services, threads, started, events, observers, lifecycles, runtime, open, latestState: () => events.at(-1)?.type === "extension-event" ? (events.at(-1) as { payload: unknown }).payload : undefined };
}

async function activated() {
  const bench = harness();
  bench.open("parent");
  await bench.registry.activate(createAgentsHostExtension());
  return bench;
}

describe("Agents Kit tool arguments", () => {
  it("refuses a spawn without a prompt and bounds what it accepts", () => {
    expect(() => decodeSpawnRequest({})).toThrow("prompt is required");
    expect(() => decodeSpawnRequest({ prompt: "   " })).toThrow("prompt is required");
    expect(() => decodeSpawnRequest({ prompt: "go", title: "x".repeat(121) })).toThrow("120 characters or fewer");
    expect(() => decodeSpawnRequest({ prompt: "go", title: 7 })).toThrow("title must be a string");
    expect(decodeSpawnRequest({ prompt: " go ", title: " Look ", model: "", projectPath: undefined }))
      .toEqual({ prompt: "go", title: "Look" });
  });

  it("reads a thread id and clamps the wait to the hard cap", () => {
    expect(() => decodeThreadId({})).toThrow("threadId is required");
    expect(decodeThreadId({ threadId: " t1 " })).toBe("t1");
    expect(decodeTimeout({})).toBe(600_000);
    expect(decodeTimeout({ timeoutMs: 5_000 })).toBe(5_000);
    expect(decodeTimeout({ timeoutMs: 60 * 60_000 })).toBe(1_800_000);
    expect(() => decodeTimeout({ timeoutMs: -1 })).toThrow("positive number");
  });

  it("reads a model as provider/model-id", () => {
    expect(parseModel("anthropic/claude-sonnet-4-5")).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
    expect(() => parseModel("sonnet")).toThrow("provider/model-id");
  });

  it("derives a title from the prompt when none is given", () => {
    expect(titleFromPrompt("Reply with ALPHA. Then stop.")).toBe("Reply with ALPHA.");
    expect(titleFromPrompt("x".repeat(80))).toHaveLength(58);
  });
});

describe("Agents Kit status", () => {
  it("derives a status from liveness, turns and what the thread is holding open", () => {
    expect(deriveStatus({ spawning: true, turns: 0 })).toBe("running");
    expect(deriveStatus({ spawning: false, turns: 0, live: { streaming: true, idle: false } })).toBe("running");
    expect(deriveStatus({ spawning: false, turns: 1, pendingToolPrompt: "Allow?", live: { streaming: false, idle: false } })).toBe("waiting");
    expect(deriveStatus({ spawning: false, turns: 0, live: { streaming: false, idle: false } })).toBe("waiting");
    expect(deriveStatus({ spawning: false, turns: 1, lastOutcome: "completed", live: { streaming: false, idle: true } })).toBe("completed");
    expect(deriveStatus({ spawning: false, turns: 1, lastOutcome: "failed" })).toBe("failed");
    expect(deriveStatus({ spawning: false, turns: 0, error: "gone" })).toBe("failed");
    expect(deriveStatus({ spawning: false, turns: 0 })).toBe("idle");
  });

  it("keeps a parent's budget and depth", () => {
    const book = new AgentThreadBook(() => ({ streaming: true, idle: false }));
    for (let index = 0; index < MAX_CHILDREN_PER_PARENT; index += 1) {
      book.assertCanSpawn("parent");
      book.add({ threadId: `c${index}`, parentThreadId: "parent", spawnedBy: "tau_spawn_thread", spawnedAt: index, projectPath: "/project", depth: 1 });
    }
    expect(() => book.assertCanSpawn("parent")).toThrow("already has 8 sub-agents running");
    book.add({ threadId: "grandchild", parentThreadId: "c0", spawnedBy: "tau_spawn_thread", spawnedAt: 9, projectPath: "/project", depth: 2 });
    expect(() => book.assertCanSpawn("grandchild")).toThrow("may nest 2 levels deep");
  });

  it("stops counting a child that finished against the parent's budget", () => {
    const book = new AgentThreadBook(() => ({ streaming: false, idle: true }));
    book.add({ threadId: "c1", parentThreadId: "parent", spawnedBy: "tau_spawn_thread", spawnedAt: 1, projectPath: "/project", depth: 1 });
    book.noteEnded("c1", "completed");
    expect(book.linkFor("c1")?.status).toBe("completed");
    expect(book.childrenOf("parent")).toHaveLength(1);
    book.assertCanSpawn("parent");
  });
});

describe("Agents Kit", () => {
  it("registers its four tools on every runtime", async () => {
    const bench = await activated();
    expect(bench.runtime("parent").names()).toEqual([
      "tau_spawn_thread",
      "tau_get_thread_status",
      "tau_wait_for_thread",
      "tau_list_threads",
    ]);
  });

  it("spawns a thread in the caller's project and records the link on both sessions", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const spawned = await parent.call("tau_spawn_thread", { prompt: "Reply with ALPHA" }) as { threadId: string; title: string; status: string };

    expect(spawned).toEqual({ threadId: "child-1", title: "Reply with ALPHA", status: "running" });
    expect(bench.started).toEqual([{ cwd: "/project", prompt: "Reply with ALPHA", title: "Reply with ALPHA", model: { provider: "anthropic", id: "sonnet" } }]);
    expect(bench.threads.get("child-1")!.entries).toEqual([
      { type: "custom", customType: AGENT_PARENT_ENTRY, data: expect.objectContaining({ parentThreadId: "parent", spawnedBy: "tau_spawn_thread", depth: 1 }) },
    ]);
    expect(bench.threads.get("parent")!.entries).toEqual([
      { type: "custom", customType: AGENT_CHILD_ENTRY, data: expect.objectContaining({ threadId: "child-1", depth: 1, title: "Reply with ALPHA" }) },
    ]);
    expect(bench.latestState()).toEqual({ links: [expect.objectContaining({ threadId: "child-1", parentThreadId: "parent", status: "running" })] });
  });

  it("takes the model the caller names and refuses a project the host does not have", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    await parent.call("tau_spawn_thread", { prompt: "go", model: "openai/gpt-5", projectPath: "/other" });
    expect(bench.started[0]).toMatchObject({ cwd: "/other", model: { provider: "openai", id: "gpt-5" } });
    await expect(parent.call("tau_spawn_thread", { prompt: "go", projectPath: "/nowhere" })).rejects.toThrow("not a project this host has open");
  });

  it("reports status from the host's own view of the thread", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const { threadId } = await parent.call("tau_spawn_thread", { prompt: "Reply with ALPHA" }) as { threadId: string };
    await expect(parent.call("tau_get_thread_status", { threadId })).resolves.toMatchObject({ status: "running", turns: 0 });

    const child = bench.threads.get(threadId)!;
    child.messages = [{ role: "assistant", text: "ALPHA" } as UiMessage];
    child.streaming = false;
    for (const observer of bench.observers) await observer.ended?.(threadId, "turn-1", "completed");

    await expect(parent.call("tau_get_thread_status", { threadId })).resolves.toEqual({
      threadId,
      title: "Reply with ALPHA",
      status: "completed",
      turns: 1,
      lastAssistantMessage: "ALPHA",
    });
    await expect(parent.call("tau_get_thread_status", { threadId: "someone-else" })).rejects.toThrow("not a thread this one spawned");
  });

  it("surfaces a question the child is holding as waiting, not as an answer for the parent", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const { threadId } = await parent.call("tau_spawn_thread", { prompt: "go" }) as { threadId: string };
    bench.threads.get(threadId)!.streaming = false;
    bench.runtime(threadId).fire("ui_prompt_start", { kind: "confirm", title: "Run rm -rf?" });

    await expect(parent.call("tau_get_thread_status", { threadId }))
      .resolves.toMatchObject({ status: "waiting", pendingToolPrompt: "Run rm -rf?" });
  });

  it("waits for the child's turn to end and returns its final answer", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const { threadId } = await parent.call("tau_spawn_thread", { prompt: "Reply with BETA" }) as { threadId: string };
    const waiting = parent.call("tau_wait_for_thread", { threadId, timeoutMs: 5_000 });

    const child = bench.threads.get(threadId)!;
    child.messages = [{ role: "assistant", text: "BETA" } as UiMessage];
    child.streaming = false;
    for (const observer of bench.observers) await observer.ended?.(threadId, "turn-1", "completed");

    await expect(waiting).resolves.toMatchObject({ status: "completed", lastAssistantMessage: "BETA", turns: 1 });
  });

  it("gives up on the tool's own abort signal instead of holding the turn open", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const { threadId } = await parent.call("tau_spawn_thread", { prompt: "go" }) as { threadId: string };
    const controller = new AbortController();
    const waiting = parent.call("tau_wait_for_thread", { threadId }, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toMatchObject({ timedOut: true, status: "running" });
  });

  it("lists only the threads the calling thread spawned", async () => {
    const bench = await activated();
    bench.open("sibling");
    const parent = bench.runtime("parent");
    await parent.call("tau_spawn_thread", { prompt: "one" });
    await bench.runtime("sibling").call("tau_spawn_thread", { prompt: "two" });

    await expect(parent.call("tau_list_threads")).resolves.toEqual({
      threads: [expect.objectContaining({ threadId: "child-1", title: "one", status: "running" })],
    });
  });

  it("reads links back from a session file when its thread opens again", async () => {
    const bench = await activated();
    const entries = [
      { type: "custom", customType: AGENT_CHILD_ENTRY, data: { version: 1, threadId: "child-9", spawnedAt: 5, projectPath: "/project", depth: 1, title: "Nine" } },
    ];
    expect(linksFromEntries("parent", entries)).toEqual([
      { threadId: "child-9", parentThreadId: "parent", spawnedBy: "tau_spawn_thread", spawnedAt: 5, projectPath: "/project", depth: 1, title: "Nine" },
    ]);

    await bench.lifecycles[0]!.beforeOpen?.({ sessionId: "parent", entries: () => entries } as never);
    await expect(bench.registry.invoke(AGENTS_HOST_EXTENSION_ID, "state")).resolves.toEqual({
      links: [expect.objectContaining({ threadId: "child-9", parentThreadId: "parent" })],
    });
  });

  it("survives its threads going away", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const { threadId } = await parent.call("tau_spawn_thread", { prompt: "go" }) as { threadId: string };
    bench.threads.delete(threadId);
    bench.threads.delete("parent");
    for (const observer of bench.observers) await observer.closed?.(threadId);

    await expect(parent.call("tau_get_thread_status", { threadId })).resolves.toMatchObject({ status: "idle", turns: 0 });
    await bench.lifecycles[0]!.sweep?.({ sessions: [], liveThreads: [], projectPaths: [], deleted: [{ sessionId: threadId, cwd: "/project" }] });
    await expect(parent.call("tau_list_threads")).resolves.toEqual({ threads: [] });
  });
});
