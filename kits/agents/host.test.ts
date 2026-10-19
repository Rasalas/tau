import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PARENT_LINK_ENTRY,
  parentLinkEntry,
  type ExtensionUiPrompt,
  type GlobalHostEvent,
  type HostExtensionServices,
  type HostMcpToolProvider,
  type HostMcpInstructionsProvider,
  type HostRuntimeChoice,
  type HostThread,
  type HostThreadLifecycle,
  type HostThreadStartOptions,
  type HostTurnObserver,
  type RuntimeExtensionContribution,
  type UiMessage,
  type UiToolRun,
  type UiWake,
} from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { ownedProcessTree } from "../../src/main/test-support/owned-process-tree.js";
import {
  AGENTS_HOST_EXTENSION_ID,
  AGENT_CHILD_ENTRY,
  DEFAULT_MAX_RUNNING_AGENTS,
  type AgentsState,
} from "./protocol.js";
import {
  createAgentsHostExtension,
  decodeStoredLinks,
  linksFromEntries,
  readAgentLinks,
  readAgentLinksWithMigration,
  readAgentsSettings,
  titleFromPrompt,
  toolLine,
  writeAgentLinks,
} from "./host.js";
import { captureWorktreeTree, runAgentGit, type AgentGitRunner } from "../workspace/agent-worktrees.js";
import { priorityPrefix, readAgentPriority } from "./priority.js";
import { AgentThreadBook, decodeSpawnRequest, decodeThreadId, decodeTimeout, deriveStatus, parseModel, readMaxRunningAgents } from "./threads.js";
import { waitingBelow } from "./model.js";

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
  const mcpProviders: HostMcpToolProvider[] = [];
  const instructions: HostMcpInstructionsProvider[] = [];
  const promptDecorators = new Set<Parameters<HostExtensionServices["decorateUiPrompt"]>[0]>();
  const choices: HostRuntimeChoice[] = ["pi", "opencode", "codex"].map((kind) => ({
    backend: { kind, label: kind }, enabled: true, readiness: { kind, label: kind, state: "ready" },
    catalog: { kind, models: ["openai/test-model", "openai/reviewer-model", "anthropic/parent-model", "anthropic/small-model", "openai/parent-model"].map(parseModel).map((model) => ({ ...model, name: model.id })), thinkingLevels: {} },
  }));
  /** What `sessions.send` and `sessions.abort` were asked to do, in order. */
  const sent: Array<{ sessionId: string; text: string; delivery: string; from?: string; wake?: UiWake }> = [];
  const aborted: string[] = [];
  let steerRefused = false;
  /** Prompts refused the way a runtime refuses one while it starts a turn. */
  let promptRefusals = 0;
  /** Threads of a runtime without a journal, as a Codex parent is. */
  const noJournal = new Set<string>();
  const backends = new Map<string, string>();
  /** The reasoning level a thread's Pi runtime reports. */
  const thinking = new Map<string, string>();
  const models = new Map<string, { provider: string; id: string }>();
  let nextThread = 0;
  let projectCwd = "/project";
  let transcriptGate: ((threadId: string) => Promise<void>) | undefined;

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
      cwd: projectCwd,
      backendKind: backends.get(threadId) ?? "pi",
      model: models.get(threadId),
      sessionFile: `/sessions/${threadId}.jsonl`,
      isStreaming: () => found.streaming,
      isIdle: () => found.idle && !found.streaming,
      waitForIdle: async () => undefined,
      transcript: async () => { await transcriptGate?.(threadId); return found.messages; },
      entries: () => found.entries,
      appendEntry: (customType: string, data: unknown) => {
        if (noJournal.has(threadId)) throw new Error("This runtime keeps no journal.");
        found.entries.push({ type: "custom", customType, data });
      },
    } as unknown as HostThread;
  };

  /** Holds `sessions.start` open, so a test can watch how many run at once. */
  let startGate: (() => Promise<void>) | undefined;
  let sendGate: (() => Promise<void>) | undefined;

  const services: HostExtensionServices = {
    cwd: () => projectCwd,
    agentDir: "/agent",
  complete: async () => "",
    sessionsDir: "/agent/sessions",
    stateDir: "/state",
    themesDir: "/themes",
    safeMode: false,
    log: vi.fn(),
    refreshExtensionPackages: async () => undefined,
    listPackages: async () => [],
    installPackage: async () => { throw new Error("no installer in this test"); },
    reviewPackage: async () => { throw new Error("no installer in this test"); },
    approvePackage: async () => { throw new Error("no installer in this test"); },
    removePackage: async () => { throw new Error("no installer in this test"); },
    newPackage: async () => { throw new Error("no installer in this test"); },
    globalExtensionsDirectory: () => "/tmp/tau-extensions",
    updatePackages: async () => [],
    openWorkspace: async () => ({ version: 1 as const, updates: [] }),
    knownWorkspacePath: async (path) => path,
    workspaceRef: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    admitWorkspace: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    projectName: async () => "project",
    rememberProjectName: () => undefined,
    pickDirectory: async () => undefined,
    runtimeOwner: () => "tau" as const,
    thread: (sessionId) => hostThread(sessionId ?? "parent"),
    runtimeChoices: async (_cwd, kind) => choices.filter((choice) => !kind || choice.backend.kind === kind),
    setThreadTitle: async () => undefined,
    attachedRuntime: () => undefined,
    describeProjects: () => () => undefined,
    noteSubprocess: () => undefined,
    findCommand: () => undefined,
    skills: () => [],
    sessions: {
      list: async () => [
        { sessionId: "parent", path: "/sessions/parent.jsonl", cwd: "/project" },
        { sessionId: "other", path: "/sessions/other.jsonl", cwd: "/other" },
      ],
      open: () => { throw new Error("no session files in this test"); },
      prepare: async () => { throw new Error("no runtimes in this test"); },
      start: async (startOptions) => {
        started.push(startOptions);
        nextThread += 1;
        const sessionId = `child-${nextThread}`;
        await startGate?.();
        const thread = open(sessionId);
        backends.set(sessionId, startOptions.backend ?? "pi");
        // The host records the link in the new session before its first prompt.
        if (startOptions.parent) {
          thread.entries.push({
            type: "custom",
            customType: PARENT_LINK_ENTRY,
            data: parentLinkEntry(startOptions.parent.threadId, startOptions.parent.details),
          });
        }
        await startOptions.beforePrompt?.(hostThread(sessionId)!);
        thread.streaming = true;
        return { sessionId, cwd: startOptions.cwd, ...(startOptions.title ? { title: startOptions.title } : {}) };
      },
      send: async (sessionId, text, sendOptions) => {
        const delivery = sendOptions?.delivery ?? "prompt";
        if (steerRefused && delivery === "steer") throw new Error("This runtime cannot steer.");
        if (promptRefusals > 0 && (delivery === "prompt" || sendOptions?.wake)) {
          promptRefusals -= 1;
          throw new Error("The prompt was rejected before it started.");
        }
        sent.push({ sessionId, text, delivery, ...(sendOptions?.from ? { from: sendOptions.from } : {}), ...(sendOptions?.wake ? { wake: sendOptions.wake } : {}) });
        const thread = threads.get(sessionId);
        if (thread && (delivery === "prompt" || sendOptions?.wake && !thread.streaming)) thread.streaming = true;
        await sendGate?.();
      },
      abort: async (sessionId) => {
        aborted.push(sessionId);
        const thread = threads.get(sessionId);
        if (thread) thread.streaming = false;
      },
      exclusive: (work) => work(),
      remove: async () => undefined, restore: async () => undefined, trash: async () => [], purge: async () => undefined,
      refreshIndex: async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }),
    },
    clients: { observe: () => () => undefined, count: () => 1 },
    registerThreadLifecycle: (lifecycle) => { lifecycles.push(lifecycle); return () => undefined; },
    registerTurnObserver: (observer) => { observers.push(observer); return () => undefined; },
    pinTranscriptEntries: () => () => undefined,
    decorateUiPrompt: (decorator) => { promptDecorators.add(decorator); return () => { promptDecorators.delete(decorator); }; },
    registerRuntimeExtension: (name, factory, extensionOptions) => { runtimeExtensions.push({ name, factory, ...extensionOptions }); return () => undefined; },
    loadRuntimeExtension: async () => { throw new Error("no runtime packages in this test"); },
    loadDependency: async () => { throw new Error("no dependencies in this test"); },
    mcp: {
      registerTools: (provider) => { mcpProviders.push(provider); return () => { mcpProviders.splice(mcpProviders.indexOf(provider), 1); }; },
      registerInstructions: (provider) => { instructions.push(provider); return () => undefined; },
      gate: () => () => undefined,
      connect: async () => undefined,
    },
    setPermissionLevel: () => undefined,
    registerRuntimeBackend: () => () => undefined,
    observeConfigChanges: () => () => undefined,
    presentUi: () => () => undefined,
    callClient: async () => { throw new Error("no window half in this test"); },
  };

  let invoke: (command: string, input?: unknown) => Promise<unknown> = () => Promise.reject(new Error("the kit is not activated"));
  let registry: Awaited<ReturnType<typeof activateHostKit>> | undefined;
  const activate = async (options: { settingsPath?: string; linksPath?: string; stateDir?: string; runGit?: AgentGitRunner }) => {
    const { stateDir, ...kitOptions } = options;
    registry = await activateHostKit(
      createAgentsHostExtension(kitOptions),
      stateDir ? { ...services, stateDir } : services,
      (event) => events.push(event),
    );
    invoke = (command, input) => registry!.invoke(AGENTS_HOST_EXTENSION_ID, command, input);
  };

  /** Loads the kit's Pi extension into one runtime and returns its tools. */
  const runtime = (sessionId: string, cwd = "/project", builtIns: string[] = []) => {
    const tools = new Map<string, FakeTool>();
    const piEvents = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
    let active: string[] | undefined;
    const all = () => [...builtIns, ...tools.keys()];
    runtimeExtensions[0]!.factory({
      on: (event: string, handler: (payload: unknown, ctx?: unknown) => unknown) => { piEvents.set(event, handler); },
      registerTool: (tool: FakeTool) => { tools.set(tool.name, tool); },
      getAllTools: () => all().map((name) => ({ name })),
      getActiveTools: () => active ?? all(),
      setActiveTools: (names: string[]) => { active = [...names]; },
      getThinkingLevel: () => thinking.get(sessionId) ?? "off",
    } as never, { sessionId, cwd });
    return {
      call: async (name: string, params: unknown = {}, signal?: AbortSignal) =>
        (await tools.get(name)!.execute("call-1", params, signal, undefined, { model: { provider: "anthropic", id: "parent-model" } })).details,
      fire: (event: string, payload: unknown, ctx?: unknown) => piEvents.get(event)?.(payload, ctx),
      names: () => [...tools.keys()],
      active: () => active ?? all(),
    };
  };

  /** The kit registers one turn observer; this is the host telling it what happened. */
  const notify = async (event: "accepted" | "ended" | "closed" | "reset" | "toolEnded", sessionId: string, extra?: unknown) => {
    for (const observer of observers) {
      if (event === "accepted") observer.accepted?.(sessionId, "turn-1", { deferBefore: false });
      if (event === "ended") await observer.ended?.(sessionId, "turn-1", (extra as "completed" | "failed") ?? "completed");
      if (event === "closed") await observer.closed?.(sessionId);
      if (event === "reset") await observer.reset?.(sessionId);
      if (event === "toolEnded") observer.toolEnded?.(sessionId, extra as UiToolRun, "/project");
    }
  };

  const state = async (): Promise<AgentsState> => await invoke("state") as AgentsState;

  /** The same tools as a runtime that is not Pi reaches them over MCP: no Pi context at all. */
  const mcpThread = async (sessionId: string, cwd = "/project") => {
    const tools = (await Promise.all(mcpProviders.map((provider) => provider({ sessionId, cwd })))).flat();
    return {
      names: () => tools.map((tool) => tool.name),
      call: async (name: string, params: unknown = {}) =>
        (await tools.find((tool) => tool.name === name)!.execute("call-1", params as never, undefined, undefined, undefined as never)).details,
    };
  };

  const holdStarts = (gate: () => Promise<void>) => { startGate = gate; };
  const holdTranscripts = (gate: (threadId: string) => Promise<void>) => { transcriptGate = gate; };

  /** The dialog coordinator calls the cleanup on an answer, cancellation or expiry. */
  const prompt = (question: ExtensionUiPrompt) => {
    const cleanups = [...promptDecorators].map((decorate) => decorate(question));
    return () => { for (const cleanup of cleanups) cleanup?.(); };
  };

  return { backends, models, thinking, choices, instructions, activate, runtimeExtensions, services, threads, started, sent, aborted, prompt, refuseSteer: () => { steerRefused = true; }, refusePrompts: (count: number) => { promptRefusals = count; }, events, observers, lifecycles, runtime, mcpThread, mcpProviders, noJournal, open, notify, state, holdStarts, holdTranscripts, holdSends: (gate: () => Promise<void>) => { sendGate = gate; }, invoke: (command: string, input?: unknown) => invoke(command, input), registry: () => registry!, setProject: (dir: string) => { projectCwd = dir; } };
}

async function activated(paths: { settingsPath?: string; linksPath?: string; stateDir?: string; runGit?: AgentGitRunner } = {}) {
  const bench = harness();
  bench.open("parent");
  await bench.activate({
    ...(paths.stateDir ? { stateDir: paths.stateDir } : { linksPath: paths.linksPath ?? join(tmpdir(), `tau-agents-none-${randomUUID()}.json`) }),
    ...(paths.linksPath && paths.stateDir ? { linksPath: paths.linksPath } : {}),
    ...(paths.settingsPath ? { settingsPath: paths.settingsPath } : {}),
    ...(paths.runGit ? { runGit: paths.runGit } : {}),
  });
  return bench;
}

it("annotates thread creation and delegated actions as writes, and inspection as reads", async () => {
  const bench = await activated();
  try {
    let independent = 0;
    for (const backend of bench.choices.map((choice) => choice.backend.kind)) {
      bench.backends.set("parent", backend);
      const tools = (await Promise.all(bench.mcpProviders.map((provider) => provider({ sessionId: "parent", cwd: "/project" })))).flat();
      const reads = new Set(["tau_get_thread_status", "tau_wait_for_thread", "tau_list_threads"]);
      for (const tool of tools) expect(tool.annotations?.readOnlyHint, tool.name).toBe(reads.has(tool.name));
      expect(tools.find((tool) => tool.name === "tau_spawn_thread")?.annotations?.readOnlyHint).toBe(false);
      const create = tools.find((tool) => tool.name === "tau_create_thread");
      if (create) { independent++; expect(create.annotations?.readOnlyHint).toBe(false); }
    }
    expect(independent).toBeGreaterThan(0);
  } finally { await bench.registry().deactivate(AGENTS_HOST_EXTENSION_ID); }
});

/** Long enough for the kit's coalesced publish; a check that something did not happen waits this long. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

/** The agent handle a completed spawn reports. */
const handleOf = (result: unknown) => (result as { threadId: string }).threadId;

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
    expect(() => parseModel("parent-model")).toThrow("provider/model-id");
  });

  it("derives a title from the prompt when none is given", () => {
    expect(titleFromPrompt("Reply with ALPHA. Then stop.")).toBe("Reply with ALPHA.");
    expect(titleFromPrompt("x".repeat(80))).toHaveLength(58);
  });

  it("clamps the running budget the user configured", () => {
    expect(readMaxRunningAgents(undefined)).toBe(DEFAULT_MAX_RUNNING_AGENTS);
    expect(readMaxRunningAgents({ maxRunningAgents: 0 })).toBe(DEFAULT_MAX_RUNNING_AGENTS);
    expect(readMaxRunningAgents({ maxRunningAgents: 12 })).toBe(12);
    expect(readMaxRunningAgents({ maxRunningAgents: 500 })).toBe(64);
  });
});

describe("Agents Kit status", () => {
  it("derives a status from liveness, turns and what the agent is holding open", () => {
    const facts = { queued: false, spawning: false, turns: 0 };
    expect(deriveStatus({ ...facts, queued: true })).toBe("pending");
    expect(deriveStatus({ ...facts, spawning: true })).toBe("running");
    expect(deriveStatus({ ...facts, live: { streaming: true, idle: false } })).toBe("running");
    expect(deriveStatus({ ...facts, turns: 1, pendingToolPrompt: "Allow?", live: { streaming: false, idle: false } })).toBe("waiting");
    expect(deriveStatus({ ...facts, live: { streaming: false, idle: false } })).toBe("waiting");
    expect(deriveStatus({ ...facts, pendingToolPrompt: "Approve write?", live: { streaming: true, idle: false } })).toBe("waiting");
    expect(deriveStatus({ ...facts, turns: 1, lastOutcome: "completed", live: { streaming: false, idle: true } })).toBe("completed");
    expect(deriveStatus({ ...facts, turns: 1, lastOutcome: "failed" })).toBe("failed");
    expect(deriveStatus({ ...facts, error: "gone" })).toBe("failed");
    expect(deriveStatus(facts)).toBe("idle");
  });

  it("hands out slots oldest first and lets agents nest without a limit", () => {
    const streaming = new Set(["t0", "t1"]);
    const book = new AgentThreadBook((threadId) => ({ streaming: streaming.has(threadId), idle: !streaming.has(threadId) }));
    book.setMaxRunning(2);
    const link = (id: string, parent: string, at: number, depth = 1) =>
      ({ id, parentThreadId: parent, spawnedBy: "tau_spawn_thread", spawnedAt: at, projectPath: "/project", depth, title: id });
    for (const index of [0, 1, 2]) book.add(link(`c${index}`, "parent", index), { queued: true });
    expect(book.startable("parent").map((entry) => entry.id)).toEqual(["c0", "c1"]);
    book.noteStarted("c0", "t0", 10);
    book.noteStarted("c1", "t1", 11);
    expect(book.startable("parent")).toEqual([]);
    expect(book.busyChildren("parent")).toBe(2);
    streaming.delete("t0");
    book.noteEnded("t0", "completed", 12);
    expect(book.startable("parent").map((entry) => entry.id)).toEqual(["c2"]);

    // Depth is a record, not a limit: a grandchild's own child is depth 3.
    book.add(link("grand", "t0", 20, 2));
    book.noteStarted("grand", "t2", 21);
    book.add(link("great", "t2", 22, 3));
    expect(book.depthOf("t2")).toBe(2);
    expect(book.linkFor("great")?.depth).toBe(3);
  });
});

describe("Agents Kit priority", () => {
  const prefixFor = (bench: Awaited<ReturnType<typeof activated>>, session: { sessionId: string; cwd: string; parentThreadId?: string }) =>
    bench.runtimeExtensions[0]!.shellCommandPrefix?.(session);
  const withSettings = async (settings: unknown, check: (path: string) => Promise<void>) => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agents-settings-"));
    const path = join(directory, "agents.json");
    await writeFile(path, JSON.stringify(settings), "utf8");
    try { await check(path); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  };

  it("puts a spawned thread's commands at low priority and leaves the user's own threads alone", async () => {
    const bench = await activated();
    expect(prefixFor(bench, { sessionId: "parent", cwd: "/project" })).toBeUndefined();
    expect(prefixFor(bench, { sessionId: "child", cwd: "/project", parentThreadId: "parent" })).toBe(priorityPrefix("low"));
  });

  it("takes the level the user set, and reads the old switch as normal", async () => {
    await withSettings({ priority: "background" }, async (path) => {
      await expect(readAgentsSettings(path)).resolves.toEqual({ maxRunning: DEFAULT_MAX_RUNNING_AGENTS, priority: "background" });
      const bench = await activated({ settingsPath: path });
      expect(prefixFor(bench, { sessionId: "child", cwd: "/project", parentThreadId: "parent" })).toBe(priorityPrefix("background"));
    });
    await withSettings({ lowPriority: false }, async (path) => {
      const bench = await activated({ settingsPath: path });
      expect(prefixFor(bench, { sessionId: "child", cwd: "/project", parentThreadId: "parent" })).toBeUndefined();
    });
  });

  it("reads the level, the alias and anything else", () => {
    expect(readAgentPriority(undefined)).toBe("low");
    expect(readAgentPriority({ priority: "idle" })).toBe("low");
    expect(readAgentPriority({ priority: "normal" })).toBe("normal");
    expect(readAgentPriority({ lowPriority: false })).toBe("normal");
    expect(readAgentPriority({ lowPriority: true })).toBe("low");
    expect(readAgentPriority({ priority: "background", lowPriority: false })).toBe("background");
  });

  it("lowers the shell itself, silently, on the platforms that have the tools", () => {
    expect(priorityPrefix("low", "darwin")).toBe("renice -n 10 -p $$ >/dev/null 2>&1");
    expect(priorityPrefix("background", "darwin")).toBe("{ /usr/sbin/taskpolicy -b -p $$; renice -n 10 -p $$; } >/dev/null 2>&1");
    expect(priorityPrefix("low", "linux")).toBe("{ renice -n 10 -p $$; ionice -c 2 -n 7 -p $$; } >/dev/null 2>&1");
    expect(priorityPrefix("background", "linux")).toBe("{ renice -n 10 -p $$; ionice -c 3 -p $$; } >/dev/null 2>&1");
    expect(priorityPrefix("normal", "linux")).toBeUndefined();
    expect(priorityPrefix("low", "win32")).toBeUndefined();
  });
});

describe("Agents Kit", () => {
  it("registers delegation tools on every runtime", async () => {
    const bench = await activated();
    expect(bench.runtime("parent").names()).toEqual([
      "tau_spawn_thread",
      "tau_get_thread_status",
      "tau_wait_for_thread",
      "tau_send_to_thread",
      "tau_cancel_thread",
      "tau_apply_thread_changes",
      "tau_list_threads",
    ]);
  });

  it("offers the same tools over MCP, bound to the thread the credential names", async () => {
    const bench = await activated();
    bench.open("codex-parent");
    bench.noJournal.add("codex-parent");
    const parent = await bench.mcpThread("codex-parent");
    expect(parent.names()).toEqual(bench.runtime("parent").names());

    // No Pi context: nothing to inherit a model from, and no journal to write the child's link into.
    const spawned = await parent.call("tau_spawn_thread", { prompt: "Reply with BETA" }) as { threadId: string };
    expect(spawned.threadId).toBe("child-1");
    expect(bench.started).toEqual([expect.not.objectContaining({ model: expect.anything() })]);
    expect(bench.started[0]!.parent?.threadId).toBe("codex-parent");
    expect(await parent.call("tau_list_threads")).toEqual({ threads: [expect.objectContaining({ threadId: "child-1" })] });

    // Another thread sees none of it and may not touch it.
    const stranger = await bench.mcpThread("parent");
    expect(await stranger.call("tau_list_threads")).toEqual({ threads: [] });
    await expect(stranger.call("tau_get_thread_status", { threadId: "child-1" })).rejects.toThrow("is not a thread this one spawned");

    await bench.registry().deactivate(AGENTS_HOST_EXTENSION_ID);
    expect(bench.mcpProviders).toEqual([]);
  });

  it.each(["codex", "codex@work", "claude-code"])("delegates other runtimes and models on %s and creates an independent thread only on explicit request", async (backend) => {
    const bench = await activated();
    bench.backends.set("parent", backend);
    bench.models.set("parent", { provider: "openai", id: "parent-model" });
    const parent = await bench.mcpThread("parent");
    expect(parent.names()).toEqual(["tau_create_thread", ...bench.runtime("parent").names().filter((name) => name !== "tau_create_thread")]);
    expect(parent.names()).toContain("tau_spawn_thread");
    expect(bench.instructions[0]!({ sessionId: "parent", cwd: "/project" })).toContain("tau_spawn_thread with runtime/model");
    await expect(parent.call("tau_spawn_thread", { prompt: "Delegate" })).rejects.toThrow("native subagents");
    await expect(parent.call("tau_spawn_thread", { prompt: "Delegate", runtime: backend, model: "parent-model" })).rejects.toThrow("native subagents");
    bench.noJournal.add("parent");
    const target = backend === "codex" ? "pi" : "codex";
    const alternate = { provider: "test", id: "alternate" };
    bench.choices.splice(0, bench.choices.length, { backend: { kind: target, label: "Target" }, enabled: true, readiness: { kind: target, label: "Target", state: "ready" }, catalog: { kind: target, models: [{ ...alternate, name: "Alternate" }], thinkingLevels: {} } });
    const child = await parent.call("tau_spawn_thread", { prompt: "Delegate", runtime: target, model: alternate.id, clientRequestId: "cross-runtime" }) as { threadId: string };
    await parent.call("tau_spawn_thread", { prompt: "Delegate", runtime: target, model: alternate.id, clientRequestId: "cross-runtime" });
    expect(bench.started).toHaveLength(1);
    expect(bench.started[0]).toMatchObject({ backend: target, model: alternate, parent: { threadId: "parent" } });
    expect(await parent.call("tau_list_threads")).toMatchObject({ threads: [expect.objectContaining({ threadId: child.threadId, runtime: target, model: "test/alternate" })] });
    bench.threads.get(child.threadId)!.streaming = false;
    bench.threads.get(child.threadId)!.messages.push({ id: "delegated-answer", role: "assistant", text: "Delegated answer", timestamp: 2 });
    await bench.notify("ended", child.threadId, "completed");
    await vi.waitFor(() => expect(bench.sent.filter((entry) => entry.sessionId === "parent")).toEqual([expect.objectContaining({ text: expect.stringContaining("Delegated answer") })]));
    bench.choices.push({ backend: { kind: backend, label: "Parent runtime" }, enabled: true, readiness: { kind: backend, label: "Parent runtime", state: "ready" }, catalog: { kind: backend, models: [{ ...alternate, name: "Alternate" }], thinkingLevels: {} } });
    await parent.call("tau_spawn_thread", { prompt: "Another model", model: "test/alternate" });
    expect(bench.started[1]).toMatchObject({ backend, model: alternate });
    await expect(parent.call("tau_spawn_thread", { prompt: "Unknown runtime", runtime: "missing" })).rejects.toThrow("Available runtimes and models");
    await expect(parent.call("tau_spawn_thread", { prompt: "Unknown model", runtime: target, model: "missing" })).rejects.toThrow("test/alternate");
    bench.choices[0]!.enabled = false;
    await expect(parent.call("tau_spawn_thread", { prompt: "Off", runtime: target })).rejects.toThrow("turned off for this project");
    bench.choices[0]!.enabled = true;
    bench.choices[0]!.readiness.state = "sign-in-required";
    await expect(parent.call("tau_spawn_thread", { prompt: "Sign in", runtime: target })).rejects.toThrow("sign-in-required");
    bench.choices[0]!.readiness.state = "not-installed";
    await expect(parent.call("tau_spawn_thread", { prompt: "Install", runtime: target })).rejects.toThrow("not-installed");
    bench.started.length = 0;
    expect(bench.started).toEqual([]);
    await expect(parent.call("tau_create_thread", { prompt: "New conversation" })).rejects.toThrow("userRequest");
    await parent.call("tau_create_thread", { prompt: "New conversation", userRequest: "Open another Tau thread" });
    expect(bench.started[0]).toMatchObject({ backend, model: { provider: "openai", id: "parent-model" } });
    expect(bench.started[0]).not.toHaveProperty("parent");
    await bench.registry().dispose();
  });

  it.each(["opencode", "opencode@work", "grok"])("inherits the %s parent's runtime and model over MCP", async (backend) => {
    const bench = await activated();
    bench.backends.set("parent", backend);
    bench.models.set("parent", { provider: "openai", id: "parent-model" });
    const parent = await bench.mcpThread("parent");
    await parent.call("tau_spawn_thread", { prompt: "Reply with BETA" });
    expect(bench.started[0]).toMatchObject({ backend, model: { provider: "openai", id: "parent-model" } });
  });

  it("preserves an inherited runtime and model when a queued spawn is recovered", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agents-inherited-runtime-"));
    const linksPath = join(directory, "links.json");
    const settingsPath = join(directory, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ maxRunningAgents: 1 }));
    const first = await activated({ linksPath, settingsPath });
    let second: Awaited<ReturnType<typeof activated>> | undefined;
    try {
      first.backends.set("parent", "opencode@work");
      first.models.set("parent", { provider: "openai", id: "original-model" });
      const parent = await first.mcpThread("parent");
      await parent.call("tau_spawn_thread", { prompt: "Occupy capacity" });
      const queued = handleOf(await parent.call("tau_spawn_thread", { prompt: "Queued task" }));
      first.backends.set("parent", "pi");
      second = await activated({ linksPath, settingsPath });
      const recovered = await second.mcpThread("parent");
      await recovered.call("tau_send_to_thread", { threadId: queued, message: "Continue", mode: "queue" });
      expect(second.started[0]).toMatchObject({ backend: "opencode@work", model: { provider: "openai", id: "original-model" }, prompt: "Queued task\n\nContinue" });
    } finally {
      await first.registry().dispose();
      await second?.registry().dispose();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("spawns a thread in the caller's project and records the link on both sessions", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const spawned = await parent.call("tau_spawn_thread", { prompt: "Reply with ALPHA" }) as { threadId: string; title: string; status: string };

    // The project of this bench is no repository, so the child shares its checkout.
    expect(spawned).toEqual({ threadId: "child-1", title: "Reply with ALPHA", status: "running", workspace: "shared" });
    expect(bench.started).toEqual([{
      cwd: "/project",
      backend: "pi",
      prompt: "Reply with ALPHA",
      title: "Reply with ALPHA",
      model: { provider: "anthropic", id: "parent-model" },
      parent: { threadId: "parent", details: expect.objectContaining({ depth: 1, spawnedBy: "tau_spawn_thread", title: "Reply with ALPHA" }) },
    }]);
    expect(bench.threads.get("child-1")!.entries).toEqual([
      { type: "custom", customType: PARENT_LINK_ENTRY, data: expect.objectContaining({ parentThreadId: "parent", spawnedBy: "tau_spawn_thread", depth: 1 }) },
    ]);
    expect(bench.threads.get("parent")!.entries).toEqual([
      { type: "custom", customType: AGENT_CHILD_ENTRY, data: expect.objectContaining({ threadId: "child-1", depth: 1, title: "Reply with ALPHA" }) },
    ]);
    const state = await bench.state();
    expect(state.maxRunning).toBe(DEFAULT_MAX_RUNNING_AGENTS);
    expect(state.links).toEqual([expect.objectContaining({ threadId: "child-1", parentThreadId: "parent", status: "running" })]);
  });

  it("gives a child its own worktree, reports what it changed, and applies it back", async () => {
    // A real folder, because creating a worktree really does make its parent.
    const root = await mkdtemp(join(tmpdir(), "tau-agent-host-"));
    const project = join(root, "project");
    const calls: string[][] = [];
    const runGit: AgentGitRunner = async (cwd, args) => {
      calls.push([cwd, ...args]);
      const command = args.join(" ");
      if (command === "symbolic-ref --quiet HEAD") return `refs/heads/${calls.find((call) => call[1] === "worktree" && call[2] === "add")?.[4]}\n`;
      if (command.startsWith("rev-parse --verify refs/heads/")) return "headcommit\n";
      if (command.startsWith("config --get branch.") && command.endsWith(".tau-review-target")) return "";
      if (command.startsWith("rev-parse --is-inside-work-tree")) return "true\n";
      if (command.startsWith("rev-parse --verify HEAD")) return "headcommit\n";
      if (command.startsWith("rev-parse --path-format=absolute")) return `${project}/.git\n`;
      if (command === "rev-parse --show-toplevel") return `${project}\n`;
      if (command === "rev-parse headcommit^{tree}") return "headtree\n";
      if (command.startsWith("commit-tree")) return "snapshotcommit\n";
      if (command.startsWith("config --get")) return "snapshotcommit\n";
      if (command.startsWith("write-tree")) return "childtree\n";
      if (command.startsWith("diff --numstat")) return "3\t1\tanswer.md\n";
      if (command.startsWith("diff --binary")) return "patch bytes";
      if (command.startsWith("rev-list")) return "0\n";
      if (command.startsWith("status --porcelain")) return " M answer.md\n";
      return "";
    };
    const bench = await activated({ runGit });
    const parent = bench.runtime("parent", project);

    const spawned = await parent.call("tau_spawn_thread", { prompt: "Write the answer" }) as { threadId: string; branch: string; workspace: string };
    expect(spawned.workspace).toBe("worktree");
    expect(spawned.branch).toMatch(/^tau\/agent-/u);
    // The thread runs in the worktree, not in the parent's checkout.
    expect(bench.started[0]?.cwd).toBe(join(root, "project-worktrees", spawned.branch.replace("/", "-")));
    // The parent's working copy differs from HEAD, so the child starts from a state commit on it.
    expect(calls.some(([, ...args]) => args.join(" ").startsWith("commit-tree childtree -p headcommit"))).toBe(true);
    expect(calls.some(([, ...args]) => args.join(" ").startsWith(`worktree add -b ${spawned.branch}`))).toBe(true);

    bench.threads.get(spawned.threadId)!.streaming = false;
    await bench.notify("ended", spawned.threadId);
    // The panel learns what it changed when it ends, before anyone asks.
    await vi.waitFor(async () => expect((await bench.state()).links[0]?.workspace?.changes).toMatchObject({ files: 1, added: 3, removed: 1 }));
    const status = await parent.call("tau_get_thread_status", { threadId: spawned.threadId }) as {
      workspace?: { branch: string; changes?: { files: number; added: number } };
    };
    expect(status.workspace?.branch).toBe(spawned.branch);
    expect(status.workspace?.changes).toMatchObject({ files: 1, added: 3, removed: 1, uncommitted: 1 });

    const applied = await parent.call("tau_apply_thread_changes", { threadId: spawned.threadId }) as { detail: string };
    expect(applied.detail).toContain("Applied 1 file");
    expect(calls.some(([cwd, ...args]) => cwd === project && args.join(" ").startsWith("apply --binary"))).toBe(true);
    expect(calls.some(([, ...args]) => args.join(" ") === `branch -D ${spawned.branch}`)).toBe(true);
    // Its worktree is gone, so there is nothing left to take.
    await expect(parent.call("tau_apply_thread_changes", { threadId: spawned.threadId })).rejects.toThrow(/already applied/u);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it.each(["child branch", "detached child", "parent branch", "parent branch with patch"])("keeps the child's work when Apply refuses a changed %s", async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "tau-agent-apply-branch-"));
    try {
      const project = join(root, "project");
      await mkdir(project);
      const git = (cwd: string, ...args: string[]) =>
        execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString().trim();
      git(project, "init", "-q", "-b", "main");
      git(project, "config", "user.name", "Tau");
      git(project, "config", "user.email", "tau@example.invalid");
      await writeFile(join(project, "original.txt"), "original\n");
      git(project, "add", "-A");
      git(project, "commit", "-qm", "initial");
      const bench = await activated({ runGit: runAgentGit, settingsPath: join(root, "settings.json") });
      bench.setProject(project);
      const parent = bench.runtime("parent", project);
      const spawned = await parent.call("tau_spawn_thread", { prompt: "Write a result" }) as { threadId: string; branch: string };
      const child = bench.started[0]!.cwd;
      if (scenario === "child branch") git(child, "switch", "-c", "other-work");
      if (scenario === "detached child") git(child, "switch", "--detach");
      await writeFile(join(child, "result.txt"), "child work\n");
      if (scenario !== "parent branch with patch") {
        git(child, "add", "-A");
        git(child, "commit", "-qm", "result");
      }
      if (scenario.startsWith("parent branch")) git(project, "switch", "-c", "other-target");
      bench.threads.get(spawned.threadId)!.streaming = false;
      await bench.notify("ended", spawned.threadId);
      const head = git(project, "rev-parse", "HEAD");
      const childHead = git(child, "rev-parse", "HEAD");
      const index = git(project, "write-tree");
      const status = git(project, "status", "--porcelain");

      await expect(parent.call("tau_apply_thread_changes", { threadId: spawned.threadId }))
        .rejects.toThrow(scenario.startsWith("parent branch") ? /main.*other-target/u : /recorded branch/u);
      expect(git(project, "rev-parse", "HEAD")).toBe(head);
      expect(git(project, "write-tree")).toBe(index);
      expect(git(project, "status", "--porcelain")).toBe(status);
      await expect(readFile(join(project, "result.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(git(project, "worktree", "list")).toContain(child);
      expect(git(project, "branch", "--list", spawned.branch)).toContain(spawned.branch);
      expect(git(child, "rev-parse", "HEAD")).toBe(childHead);
      expect(await readFile(join(child, "result.txt"), "utf8")).toBe("child work\n");
      expect((await bench.state()).links[0]?.workspace?.settled).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it.each(["tau-base", "tau-review-target"])("cleans up a child's failed worktree setup when writing %s fails", async (key) => {
    const root = await mkdtemp(join(tmpdir(), "tau-child-setup-failure-"));
    try {
      const project = join(root, "project");
      await mkdir(project);
      const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "pipe" }).toString().trim();
      git("init", "-q", "-b", "main");
      git("config", "user.name", "Tau");
      git("config", "user.email", "tau@example.com");
      await writeFile(join(project, "README.md"), "start\n");
      git("add", "-A");
      git("commit", "-qm", "first");
      const runGit: AgentGitRunner = (cwd, args, options) => {
        if (args[0] === "config" && args[1].endsWith(key)) return Promise.reject(new Error("config is read-only"));
        return runAgentGit(cwd, args, options);
      };
      const bench = await activated({ runGit, settingsPath: join(root, "settings.json") });
      bench.setProject(project);
      try {
        const result = await bench.runtime("parent", project).call("tau_spawn_thread", { prompt: "Read the fixture", workspace: "worktree" }) as { status: string; error?: string };
        expect(result).toMatchObject({ status: "failed", error: "config is read-only" });
        expect(bench.started).toEqual([]);
        expect((await bench.state()).links[0]?.workspace).toBeUndefined();
        expect(git("worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
        expect(git("branch", "--list", "tau/*")).toBe("");
      } finally {
        await bench.registry().deactivate(AGENTS_HOST_EXTENSION_ID);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])("verifies a whole-repo apply before removing a child's worktree (skipped paths: %s)", async (skipOutside) => {
    const root = await mkdtemp(join(tmpdir(), "tau-agent-subdirectory-"));
    try {
      const repo = join(root, "project");
      const project = join(repo, "packages", "app");
      await mkdir(project, { recursive: true });
      const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.name", "Tau");
      git(repo, "config", "user.email", "tau@example.invalid");
      await writeFile(join(project, "app.txt"), "original app\n");
      await writeFile(join(repo, "library.txt"), "original library\n");
      await writeFile(join(repo, "obsolete.txt"), "obsolete\n");
      await writeFile(join(repo, "bytes.bin"), Buffer.from([0, 1, 2]));
      await writeFile(join(repo, "move-from.txt"), "move this\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "initial");
      const runGit: AgentGitRunner = (cwd, args, options) =>
        runAgentGit(skipOutside && args[0] === "apply" && !args.includes("--check") && !args.includes("--cached") ? project : cwd, args, options);
      const bench = await activated({ runGit, settingsPath: join(root, "settings.json") });
      bench.setProject(project);
      const parent = bench.runtime("parent", project);
      const spawned = await parent.call("tau_spawn_thread", { prompt: "Update app and library" }) as { threadId: string; branch: string };
      const child = bench.started[0]!.cwd;
      await writeFile(join(child, "packages", "app", "app.txt"), "updated app\n");
      await writeFile(join(child, "library.txt"), "updated library\n");
      await writeFile(join(child, "new-library.txt"), "new library\n");
      await rm(join(child, "obsolete.txt"));
      await writeFile(join(child, "bytes.bin"), Buffer.from([0, 3, 4]));
      await rename(join(child, "move-from.txt"), join(child, "move-to.txt"));
      await writeFile(join(repo, "parent-draft.txt"), "parent work\n");
      bench.threads.get(spawned.threadId)!.streaming = false;
      await bench.notify("ended", spawned.threadId);

      if (skipOutside) {
        await expect(parent.call("tau_apply_thread_changes", { threadId: spawned.threadId })).rejects.toThrow(/not fully applied/u);
        expect(await readFile(join(child, "library.txt"), "utf8")).toBe("updated library\n");
        expect(await readFile(join(child, "new-library.txt"), "utf8")).toBe("new library\n");
        expect(git(repo, "worktree", "list")).toContain(child);
        expect(git(repo, "branch", "--list", spawned.branch)).toContain(spawned.branch);
        expect((await bench.state()).links[0]?.workspace?.settled).toBeUndefined();
        return;
      }
      await parent.call("tau_apply_thread_changes", { threadId: spawned.threadId });
      expect(await readFile(join(project, "app.txt"), "utf8")).toBe("updated app\n");
      expect(await readFile(join(repo, "library.txt"), "utf8")).toBe("updated library\n");
      expect(await readFile(join(repo, "new-library.txt"), "utf8")).toBe("new library\n");
      await expect(readFile(join(repo, "obsolete.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(repo, "bytes.bin"))).toEqual(Buffer.from([0, 3, 4]));
      await expect(readFile(join(repo, "move-from.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(repo, "move-to.txt"), "utf8")).toBe("move this\n");
      expect(await readFile(join(repo, "parent-draft.txt"), "utf8")).toBe("parent work\n");
      expect(git(repo, "worktree", "list")).not.toContain(child);
      expect(git(repo, "branch", "--list", spawned.branch)).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it.each(["uncommitted", "committed", "empty commit", "staged"])("refuses to discard a child with %s work without force", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "tau-agent-discard-"));
    try {
      const project = join(root, "project");
      await mkdir(project);
      const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString().trim();
      git(project, "init", "-q", "-b", "main");
      git(project, "config", "user.name", "Tau");
      git(project, "config", "user.email", "tau@example.invalid");
      await writeFile(join(project, "answer.txt"), "initial\n");
      git(project, "add", "-A");
      git(project, "commit", "-qm", "initial");
      const bench = await activated({ runGit: runAgentGit, settingsPath: join(root, "settings.json") });
      bench.setProject(project);
      const parent = bench.runtime("parent", project);
      const spawned = await parent.call("tau_spawn_thread", { prompt: "Write the answer" }) as { threadId: string; branch: string };
      const child = bench.started[0]!.cwd;
      bench.threads.get(spawned.threadId)!.streaming = false;
      await bench.notify("ended", spawned.threadId);
      // Change it after the status was read, so a cached clean result cannot authorize deletion.
      if (kind !== "empty commit") await writeFile(join(child, "answer.txt"), "child work\n");
      if (kind === "committed" || kind === "staged") git(child, "add", "-A");
      if (kind === "committed" || kind === "empty commit") git(child, "commit", "--allow-empty", "-qm", "child work");
      if (kind === "staged") await writeFile(join(child, "answer.txt"), "initial\n");
      const tip = git(child, "rev-parse", "HEAD");
      const index = git(child, "write-tree");
      const contents = await readFile(join(child, "answer.txt"), "utf8");

      await expect(parent.call("tau_apply_thread_changes", { threadId: spawned.threadId, discard: true })).rejects.toThrow(/force/u);
      await expect(bench.invoke("discard-changes", { threadId: spawned.threadId })).rejects.toThrow(/force/u);
      expect(await readFile(join(child, "answer.txt"), "utf8")).toBe(contents);
      expect(git(project, "worktree", "list")).toContain(child);
      expect(git(project, "rev-parse", spawned.branch)).toBe(tip);
      expect(git(child, "write-tree")).toBe(index);
      expect((await bench.state()).links[0]?.workspace?.settled).toBeUndefined();

      const input = { threadId: spawned.threadId, discard: true, force: true };
      const discarded = await (kind === "staged"
        ? bench.invoke("discard-changes", input)
        : parent.call("tau_apply_thread_changes", input)) as { detail: string };
      const ref = /refs\/tau\/discarded\/[a-f0-9-]+/u.exec(discarded.detail)?.[0];
      expect(ref).toBeTruthy();
      expect(git(project, "show", `${ref}:answer.txt`)).toBe(contents.trim());
      expect(git(project, "rev-parse", `${ref}^^`)).toBe(tip);
      expect(git(project, "rev-parse", `${ref}^^{tree}`)).toBe(index);
      expect(git(project, "worktree", "list")).not.toContain(child);
      expect(git(project, "branch", "--list", spawned.branch)).toBe("");
      expect((await bench.state()).links[0]?.workspace?.settled).toBe("discarded");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("starts a child from HEAD and the uncommitted work, so a commit made after the parent's last turn survives the merge", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-agent-base-"));
    const project = join(root, "project");
    await mkdir(project);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString().trim();
    git(project, "init", "-q", "-b", "main");
    git(project, "config", "user.name", "Here");
    git(project, "config", "user.email", "here@example.invalid");
    await writeFile(join(project, "fruit.txt"), "kiwi\n");
    git(project, "add", "-A");
    git(project, "commit", "-qm", "kiwi");
    // The parent's turn left an uncommitted draft, and its checkpoint holds that working copy.
    await writeFile(join(project, "draft.txt"), "the parent's draft\n");
    const bench = await activated({ runGit: runAgentGit });
    bench.setProject(project);
    const checkpoint = await captureWorktreeTree(project);
    git(project, "update-ref", "refs/tau/checkpoints/parent/turn-1/after", checkpoint);
    bench.threads.get("parent")!.entries.push({
      type: "custom",
      customType: "tau.turn-checkpoint.v1",
      data: { afterSnapshotId: "refs/tau/checkpoints/parent/turn-1/after" },
    });
    // Between that turn and the spawn, the user commits.
    await writeFile(join(project, "fruit.txt"), "pear\n");
    git(project, "commit", "-qm", "pear", "--", "fruit.txt");

    const parent = bench.runtime("parent", project);
    const spawned = await parent.call("tau_spawn_thread", { prompt: "Add a basket" }) as { threadId: string; branch: string };
    const there = bench.started[0]!.cwd;
    expect(await readFile(join(there, "fruit.txt"), "utf8")).toBe("pear\n");
    expect(await readFile(join(there, "draft.txt"), "utf8")).toBe("the parent's draft\n");
    await writeFile(join(there, "basket.txt"), "a basket\n");
    git(there, "add", "basket.txt");
    git(there, "commit", "-qm", "basket");

    bench.threads.get(spawned.threadId)!.streaming = false;
    await bench.notify("ended", spawned.threadId);
    await parent.call("tau_apply_thread_changes", { threadId: spawned.threadId });
    expect(await readFile(join(project, "fruit.txt"), "utf8")).toBe("pear\n");
    expect(await readFile(join(project, "basket.txt"), "utf8")).toBe("a basket\n");
    expect(await readFile(join(project, "draft.txt"), "utf8")).toBe("the parent's draft\n");
    expect(git(project, "log", "--format=%s", "-1", "--", "fruit.txt")).toBe("pear");
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("takes a deleted thread's worktree only when it holds nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-agent-delete-"));
    const project = join(root, "project");
    const calls: string[][] = [];
    let uncommitted = "";
    const runGit: AgentGitRunner = async (cwd, args) => {
      calls.push([cwd, ...args]);
      const command = args.join(" ");
      if (command.startsWith("rev-parse --is-inside-work-tree")) return "true\n";
      if (command.startsWith("rev-parse --verify HEAD")) return "headcommit\n";
      if (command.startsWith("rev-parse --path-format=absolute")) return `${project}/.git\n`;
      if (command.startsWith("config --get")) return "basecommit\n";
      if (command.startsWith("write-tree")) return "childtree\n";
      if (command.startsWith("diff --numstat")) return uncommitted ? "3\t1\tanswer.md\n" : "";
      if (command.startsWith("rev-list")) return "0\n";
      if (command.startsWith("status --porcelain")) return uncommitted;
      return "";
    };
    const bench = await activated({ runGit });
    const parent = bench.runtime("parent", project);
    const first = await parent.call("tau_spawn_thread", { prompt: "one" }) as { threadId: string; branch: string };
    const second = await parent.call("tau_spawn_thread", { prompt: "two" }) as { threadId: string; branch: string };
    const deleted = (sessionId: string) => bench.lifecycles[0]!.threadDeleted!(sessionId, project);

    // Nothing changed in it: the checkout and its branch go with the thread.
    await deleted(first.threadId);
    expect(calls.some(([, ...args]) => args.join(" ") === `branch -D ${first.branch}`)).toBe(true);

    // The second one holds uncommitted work, so it outlives its thread.
    uncommitted = " M answer.md\n";
    await deleted(second.threadId);
    expect(calls.some(([, ...args]) => args.join(" ") === `branch -D ${second.branch}`)).toBe(false);

    // Either way the link is gone: the panel does not list a deleted thread.
    await expect(parent.call("tau_list_threads")).resolves.toEqual({ threads: [] });
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("shares the parent's checkout when asked, and always outside a repository", async () => {
    const runGit: AgentGitRunner = async (_cwd, args) =>
      args[0] === "rev-parse" && args[1] === "--is-inside-work-tree" ? "true\n" : "";
    const bench = await activated({ runGit });
    const parent = bench.runtime("parent");

    const shared = await parent.call("tau_spawn_thread", { prompt: "Read the code", workspace: "shared" }) as { threadId: string; workspace: string };
    expect(shared.workspace).toBe("shared");
    expect(bench.started[0]?.cwd).toBe("/project");
    await expect(parent.call("tau_apply_thread_changes", { threadId: shared.threadId }))
      .rejects.toThrow(/works in your own checkout/u);
  });

  it("takes the model the caller names and refuses a project the host does not have", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    await parent.call("tau_spawn_thread", { prompt: "go", model: "openai/test-model", projectPath: "/other" });
    expect(bench.started[0]).toMatchObject({ cwd: "/other", model: { provider: "openai", id: "test-model" } });
    await expect(parent.call("tau_spawn_thread", { prompt: "go", projectPath: "/nowhere" })).rejects.toThrow("not a project this machine has open");
  });

  it("queues spawns beyond the running budget and starts them in order as slots free", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const spawns = [];
    for (let index = 0; index < 20; index += 1) {
      spawns.push(await parent.call("tau_spawn_thread", { prompt: `task ${index}`, title: `T${index}` }) as { status: string });
    }
    // Exactly the budget started; every later spawn was accepted, not refused.
    expect(spawns.filter((entry) => entry.status === "running")).toHaveLength(DEFAULT_MAX_RUNNING_AGENTS);
    expect(spawns.filter((entry) => entry.status === "pending")).toHaveLength(20 - DEFAULT_MAX_RUNNING_AGENTS);
    expect(bench.started.map((entry) => entry.title)).toEqual(["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7"]);

    // Two of them finish; the two oldest queued agents take their slots.
    for (const threadId of ["child-1", "child-2"]) {
      bench.threads.get(threadId)!.streaming = false;
      await bench.notify("ended", threadId, "completed");
    }
    expect(bench.started.map((entry) => entry.title)).toEqual(["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9"]);

    const listed = await parent.call("tau_list_threads") as { threads: Array<{ title: string; status: string }> };
    expect(listed.threads).toHaveLength(20);
    expect(listed.threads.filter((entry) => entry.status === "pending")).toHaveLength(10);
    expect(listed.threads.filter((entry) => entry.status === "completed")).toHaveLength(2);
  });

  it("starts twenty simultaneous spawns concurrently, up to the running budget", async () => {
    const bench = await activated();
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    bench.holdStarts(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => { releases.push(resolve); });
      inFlight -= 1;
    });
    const parent = bench.runtime("parent");
    // One turn's worth of tool calls: every spawn is issued before any of them
    // has a thread, which is the case the serial pump used to turn into a queue.
    const spawns = Array.from({ length: 20 }, (_, index) =>
      parent.call("tau_spawn_thread", { prompt: `task ${index}`, title: `T${index}` }) as Promise<{ status: string }>);
    await vi.waitFor(() => { expect(inFlight).toBe(DEFAULT_MAX_RUNNING_AGENTS); });
    // The overlap is the point: the budget's worth of threads is being built at
    // the same moment, not one after another.
    expect(peak).toBe(DEFAULT_MAX_RUNNING_AGENTS);
    expect(bench.started).toHaveLength(DEFAULT_MAX_RUNNING_AGENTS);
    for (const release of releases) release();
    const results = await Promise.all(spawns);
    expect(results.filter((entry) => entry.status === "running")).toHaveLength(DEFAULT_MAX_RUNNING_AGENTS);
    expect(results.filter((entry) => entry.status === "pending")).toHaveLength(20 - DEFAULT_MAX_RUNNING_AGENTS);
  });

  it("never runs more than the budget while a batch is still being built", async () => {
    const bench = await activated();
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    bench.holdStarts(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => { releases.push(resolve); });
      inFlight -= 1;
    });
    const parent = bench.runtime("parent");
    const spawns = Array.from({ length: 12 }, (_, index) =>
      parent.call("tau_spawn_thread", { prompt: `task ${index}` }) as Promise<{ status: string }>);
    await vi.waitFor(() => { expect(releases).toHaveLength(DEFAULT_MAX_RUNNING_AGENTS); });
    for (const release of releases.splice(0)) release();
    await Promise.all(spawns);
    // Four agents are still queued; nothing started them behind the budget's back.
    expect(peak).toBe(DEFAULT_MAX_RUNNING_AGENTS);
    expect(bench.started).toHaveLength(DEFAULT_MAX_RUNNING_AGENTS);
    await expect(bench.state()).resolves.toMatchObject({ maxRunning: DEFAULT_MAX_RUNNING_AGENTS });
  });

  it("honours the running budget the user configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agents-settings-"));
    const path = join(directory, "agents.json");
    await writeFile(path, JSON.stringify({ maxRunningAgents: 2 }), "utf8");
    try {
      await expect(readAgentsSettings(path)).resolves.toEqual({ maxRunning: 2, priority: "low" });
      const bench = await activated({ settingsPath: path });
      await expect(bench.state()).resolves.toMatchObject({ maxRunning: 2 });
      const parent = bench.runtime("parent");
      const statuses = [];
      for (const index of [0, 1, 2]) {
        statuses.push(((await parent.call("tau_spawn_thread", { prompt: `t${index}` })) as { status: string }).status);
      }
      expect(statuses).toEqual(["running", "running", "pending"]);
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("records the parent's turn a spawn came from, in the links file and both session files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agents-turn-"));
    const linksPath = join(directory, "agents-links.json");
    const bench = await activated({ linksPath });
    try {
      const prompt = (text: string) => ({ type: "message", message: { role: "user", content: text } });
      // The fake journal holds custom entries only; a real one holds the prompts too.
      (bench.threads.get("parent")!.entries as unknown[]).push(prompt("Split it"), { type: "message", message: { role: "assistant" } }, prompt("And the rest"));
      const handle = handleOf(await bench.runtime("parent").call("tau_spawn_thread", { prompt: "Reply with ALPHA" }));

      expect((await bench.state()).links[0]).toMatchObject({ threadId: handle, turn: 2 });
      expect(bench.threads.get("parent")!.entries.at(-1)).toMatchObject({ customType: AGENT_CHILD_ENTRY, data: expect.objectContaining({ turn: 2 }) });
      expect(linksFromEntries("parent", [bench.threads.get("parent")!.entries.at(-1)])[0]).toMatchObject({ turn: 2 });
      await vi.waitFor(async () => expect((await readAgentLinks(linksPath))[0]).toMatchObject({ threadId: handle, turn: 2 }));
    } finally {
      await bench.registry().dispose();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("names a tool with what it worked on, for the panel's progress line", () => {
    expect(toolLine({ name: "edit", args: { path: "src/routes/products.ts" } })).toBe("edit src/routes/products.ts");
    expect(toolLine({ name: "bash", args: { command: "vitest   run\ncustomers" } })).toBe("bash vitest run customers");
    expect(toolLine({ name: "mcp__tau__tau_list_threads", args: {} })).toBe("tau_list_threads");
    expect(toolLine({ name: "bash", args: { command: "x".repeat(200) } })).toHaveLength(80);
  });

  it("reports status from the host's own view of the thread", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const handle = handleOf(await parent.call("tau_spawn_thread", { prompt: "Reply with ALPHA" }));
    await expect(parent.call("tau_get_thread_status", { threadId: handle })).resolves.toMatchObject({ status: "running", turns: 0 });

    const child = bench.threads.get(handle)!;
    child.messages = [{ role: "assistant", text: "ALPHA" } as UiMessage];
    child.streaming = false;
    await bench.notify("toolEnded", handle, { name: "bash" });
    await bench.notify("ended", handle, "completed");

    await expect(parent.call("tau_get_thread_status", { threadId: handle })).resolves.toEqual({
      threadId: handle,
      title: "Reply with ALPHA",
      status: "completed",
      turns: 1,
      lastAssistantMessage: "ALPHA",
    });
    const state = await bench.state();
    expect(state.links[0]).toMatchObject({ lastTool: "bash", result: "ALPHA", status: "completed" });
    await expect(parent.call("tau_get_thread_status", { threadId: "someone-else" })).rejects.toThrow("not a thread this one spawned");
  });

  it("keeps a child that is still at work when its first turn was accepted before the start returned", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    // The host waits for the first prompt's admission inside `sessions.start`.
    bench.holdStarts(async () => { await bench.notify("accepted", "child-1"); });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const handle = handleOf(await parent.call("tau_spawn_thread", { prompt: "run 900" }));
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      await expect(parent.call("tau_get_thread_status", { threadId: handle })).resolves.toMatchObject({ status: "running" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the tool an agent is running now, before it ends", async () => {
    const bench = await activated();
    const handle = handleOf(await bench.runtime("parent").call("tau_spawn_thread", { prompt: "go" }));
    bench.runtime(handle).fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "vitest run customers" } });
    expect((await bench.state()).links[0]).toMatchObject({ lastTool: "bash vitest run customers" });
  });

  it("surfaces a question the agent is holding as waiting, not as an answer for the parent", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const handle = handleOf(await parent.call("tau_spawn_thread", { prompt: "go" }));
    bench.threads.get(handle)!.streaming = false;
    bench.runtime(handle).fire("ui_prompt_start", { kind: "confirm", title: "Run rm -rf?" });

    await expect(parent.call("tau_get_thread_status", { threadId: handle }))
      .resolves.toMatchObject({ status: "waiting", pendingToolPrompt: "Run rm -rf?" });
  });

  it("releases an MCP parent's wait when a child on another runtime asks a question", async () => {
    const bench = await activated();
    try {
      bench.backends.set("parent", "codex");
      const parent = await bench.mcpThread("parent");
      const handle = handleOf(await parent.call("tau_spawn_thread", { runtime: "opencode", prompt: "Inspect the index", workspace: "shared" }));
      const waiting = parent.call("tau_wait_for_thread", { threadId: handle, timeoutMs: 100 });
      const answered = bench.prompt({ id: "question-1", sessionId: handle, kind: "input", title: "Which index?" });

      const result = await waiting;
      expect(result).toMatchObject({ status: "waiting", pendingToolPrompt: "Which index?" });
      expect(result).not.toHaveProperty("timedOut");
      expect(bench.sent).toEqual([]);

      answered();
      await expect(parent.call("tau_get_thread_status", { threadId: handle })).resolves.toMatchObject({ status: "running" });
      expect((await bench.state()).links[0]?.pendingToolPrompt).toBeUndefined();
    } finally { await bench.registry().deactivate(AGENTS_HOST_EXTENSION_ID); }
  });

  it("keeps another child dialog visible when an earlier question is dismissed", async () => {
    const bench = await activated();
    try {
      const handle = handleOf(await bench.runtime("parent").call("tau_spawn_thread", { prompt: "go" }));
      const first = bench.prompt({ id: "first", sessionId: handle, kind: "confirm", title: "Allow read?" });
      const second = bench.prompt({ id: "second", sessionId: handle, kind: "input", title: "Which table?" });

      first();
      // The Pi event for the old dialog must not erase the remaining shared dialog.
      bench.runtime(handle).fire("ui_prompt_end", {});
      expect((await bench.state()).links[0]).toMatchObject({ status: "waiting", pendingToolPrompt: "Which table?" });

      second();
      expect((await bench.state()).links[0]?.pendingToolPrompt).toBeUndefined();
    } finally { await bench.registry().deactivate(AGENTS_HOST_EXTENSION_ID); }
  });

  it("retains a question opened before the child start returns", async () => {
    const bench = await activated();
    let dismiss: (() => void) | undefined;
    bench.holdStarts(async () => {
      dismiss = bench.prompt({ id: "early", sessionId: "child-1", kind: "input", title: "Which folder?" });
    });
    try {
      const parent = await bench.mcpThread("parent");
      const handle = handleOf(await parent.call("tau_spawn_thread", { runtime: "opencode", prompt: "Inspect files", workspace: "shared" }));
      await expect(parent.call("tau_wait_for_thread", { threadId: handle, timeoutMs: 100 }))
        .resolves.toMatchObject({ status: "waiting", pendingToolPrompt: "Which folder?" });
      dismiss!();
      expect((await bench.state()).links[0]?.pendingToolPrompt).toBeUndefined();
    } finally { await bench.registry().deactivate(AGENTS_HOST_EXTENSION_ID); }
  });

  it("returns to the earlier question when the newest dialog closes", async () => {
    const bench = await activated();
    try {
      const handle = handleOf(await bench.runtime("parent").call("tau_spawn_thread", { prompt: "go" }));
      const first = bench.prompt({ id: "first", sessionId: handle, kind: "input", title: "Which folder?" });
      const second = bench.prompt({ id: "second", sessionId: handle, kind: "confirm", title: "Allow write?" });
      second();
      expect((await bench.state()).links[0]).toMatchObject({ pendingToolPrompt: "Which folder?" });
      first();
      expect((await bench.state()).links[0]?.pendingToolPrompt).toBeUndefined();
    } finally { await bench.registry().deactivate(AGENTS_HOST_EXTENSION_ID); }
  });

  it.each(["reset", "closed"] as const)("ignores old dialog cleanup after the child is %s", async (event) => {
    const bench = await activated();
    try {
      const handle = handleOf(await bench.runtime("parent").call("tau_spawn_thread", { prompt: "go" }));
      const old = bench.prompt({ id: "reused", sessionId: handle, kind: "input", title: "Old question" });
      await bench.notify(event, handle);
      expect((await bench.state()).links[0]?.pendingToolPrompt).toBeUndefined();
      const current = bench.prompt({ id: "reused", sessionId: handle, kind: "input", title: "New question" });
      old();
      expect((await bench.state()).links[0]).toMatchObject({ pendingToolPrompt: "New question" });
      current();
      expect((await bench.state()).links[0]?.pendingToolPrompt).toBeUndefined();
    } finally { await bench.registry().deactivate(AGENTS_HOST_EXTENSION_ID); }
  });

  it("counts an unanswered question below the parent only while its child runs", async () => {
    const bench = await activated();
    try {
      const parent = bench.runtime("parent");
      const handle = handleOf(await parent.call("tau_spawn_thread", { prompt: "go" }));
      const child = bench.threads.get(handle)!;
      await bench.notify("accepted", handle);
      bench.runtime(handle).fire("ui_prompt_start", { kind: "input", title: "Which index?" });
      child.idle = false;
      expect(waitingBelow(await bench.state(), "parent").map((entry) => entry.threadId)).toEqual([handle]);

      await parent.call("tau_send_to_thread", { threadId: handle, message: "Check the next table", mode: "queue" });
      expect(waitingBelow(await bench.state(), "parent").map((entry) => entry.threadId)).toEqual([handle]);

      child.streaming = false;
      await bench.notify("ended", handle, "completed");
      expect(waitingBelow(await bench.state(), "parent")).toEqual([]);
      expect((await bench.state()).links[0]).toMatchObject({ pendingToolPrompt: "Which index?" });

      // The queued turn starts with the same dialog still open.
      await bench.notify("accepted", handle);
      expect(waitingBelow(await bench.state(), "parent").map((entry) => entry.threadId)).toEqual([handle]);
      await bench.notify("ended", handle, "failed");
      expect(waitingBelow(await bench.state(), "parent")).toEqual([]);
    } finally { await bench.registry().deactivate(AGENTS_HOST_EXTENSION_ID); }
  });

  it("waits for the agent's turn to end and returns its final answer", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const handle = handleOf(await parent.call("tau_spawn_thread", { prompt: "Reply with BETA" }));
    const waiting = parent.call("tau_wait_for_thread", { threadId: handle, timeoutMs: 5_000 });

    const child = bench.threads.get(handle)!;
    child.messages = [{ role: "assistant", text: "BETA" } as UiMessage];
    child.streaming = false;
    await bench.notify("ended", handle, "completed");

    await expect(waiting).resolves.toMatchObject({ status: "completed", lastAssistantMessage: "BETA", turns: 1 });
  });

  it("gives up on the tool's own abort signal instead of holding the turn open", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const handle = handleOf(await parent.call("tau_spawn_thread", { prompt: "go" }));
    const controller = new AbortController();
    const waiting = parent.call("tau_wait_for_thread", { threadId: handle }, controller.signal);
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
      { id: "child-9", threadId: "child-9", parentThreadId: "parent", spawnedBy: "tau_spawn_thread", spawnedAt: 5, projectPath: "/project", depth: 1, title: "Nine" },
    ]);

    await bench.lifecycles[0]!.beforeOpen?.({ sessionId: "parent", entries: () => entries } as never);
    await expect(bench.state()).resolves.toMatchObject({
      links: [expect.objectContaining({ threadId: "child-9", parentThreadId: "parent" })],
    });
  });

  it("restores its links from disk before it is active, and prunes what the index lost", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agents-links-"));
    const linksPath = join(directory, "agents-links.json");
    try {
      await writeAgentLinks([
        { threadId: "child-a", parentThreadId: "parent", depth: 1, spawnedAt: 1, projectPath: "/project", title: "A", spawnedBy: "tau_spawn_thread" },
        { threadId: "child-b", parentThreadId: "parent", depth: 1, spawnedAt: 2, projectPath: "/project", title: "B", spawnedBy: "tau_spawn_thread" },
        // A link whose parent is gone: that thread is an ordinary thread again.
        { threadId: "child-c", parentThreadId: "vanished", depth: 1, spawnedAt: 3, projectPath: "/project", title: "C", spawnedBy: "tau_spawn_thread" },
      ], linksPath);
      const bench = await activated({ linksPath });

      // Activation itself published the lineage; the navigator hides the
      // children on its first paint, without any session being opened.
      expect(bench.events.filter((event) => event.type === "extension-event")).toEqual([]);
      await settle();
      const published = bench.events.at(-1) as { name: string; payload: AgentsState };
      expect(published.name).toBe("state");
      expect(published.payload.links.map((link) => link.threadId).sort()).toEqual(["child-a", "child-b", "child-c"]);
      await expect(bench.state()).resolves.toMatchObject({
        links: [
          expect.objectContaining({ threadId: "child-a", parentThreadId: "parent", title: "A", status: "idle" }),
          expect.objectContaining({ threadId: "child-b" }),
          expect.objectContaining({ threadId: "child-c" }),
        ],
      });

      await bench.lifecycles[0]!.sweep?.({
        sessions: [{ sessionId: "parent", path: "/sessions/parent.jsonl", cwd: "/project" }, { sessionId: "child-a", path: "/sessions/child-a.jsonl", cwd: "/project" }],
        liveThreads: [],
        projectPaths: ["/project"],
        deleted: [],
      });
      // child-b no longer has a session file, child-c no longer has a parent.
      await expect(bench.state()).resolves.toMatchObject({ links: [expect.objectContaining({ threadId: "child-a" })] });
      await vi.waitFor(async () => expect(await readAgentLinks(linksPath)).toEqual([expect.objectContaining({ threadId: "child-a" })]));
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("writes a spawned agent into the index file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agents-links-"));
    const linksPath = join(directory, "agents-links.json");
    const bench = await activated({ linksPath });
    try {
      await bench.runtime("parent").call("tau_spawn_thread", { prompt: "Reply with ALPHA" });
      await vi.waitFor(async () => expect(await readAgentLinks(linksPath)).toEqual([
        { threadId: "child-1", id: expect.any(String), runtime: "pi", model: "anthropic/parent-model", parentThreadId: "parent", depth: 1, spawnedAt: expect.any(Number), projectPath: "/project", title: "Reply with ALPHA", spawnedBy: "tau_spawn_thread", startedAt: expect.any(Number), pendingTurns: 1 },
      ]));
    } finally {
      await bench.registry().dispose();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("keeps when an agent ran in the index, and reads a v1 file without those times", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agents-links-"));
    const linksPath = join(directory, "agents-links.json");
    try {
      const bench = await activated({ linksPath });
      const parent = bench.runtime("parent");
      const handle = handleOf(await parent.call("tau_spawn_thread", { prompt: "Reply with ALPHA" }));
      bench.threads.get(handle)!.streaming = false;
      await bench.notify("ended", handle, "completed");
      await vi.waitFor(async () => {
        const [stored] = await readAgentLinks(linksPath);
        expect(stored?.startedAt).toEqual(expect.any(Number));
        expect(stored?.endedAt).toBeGreaterThanOrEqual(stored!.startedAt!);
      });

      await bench.registry().dispose();
      // A file the previous build wrote has no times; every other field reads on.
      await writeFile(linksPath, JSON.stringify({
        version: 1,
        links: [{ threadId: "old-child", parentThreadId: "parent", depth: 1, spawnedAt: 7, projectPath: "/project", title: "Old", spawnedBy: "tau_spawn_thread" }],
      }), "utf8");
      await expect(readAgentLinks(linksPath)).resolves.toEqual([
        { threadId: "old-child", parentThreadId: "parent", depth: 1, spawnedAt: 7, projectPath: "/project", title: "Old", spawnedBy: "tau_spawn_thread" },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("keeps its links in the state folder the host gave it", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tau-agents-state-"));
    const bench = await activated({ stateDir });
    try {
      const parent = bench.runtime("parent");
      await parent.call("tau_spawn_thread", { prompt: "go", title: "Index 1" });
      // The registry gives every extension its own folder under the root.
      await vi.waitFor(async () => expect(await readAgentLinks(join(stateDir, AGENTS_HOST_EXTENSION_ID, "agents-links.json"))).toEqual([
        expect.objectContaining({ parentThreadId: "parent", title: "Index 1" }),
      ]));
    } finally {
      await bench.registry().dispose();
      await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("takes the links of the run before the file moved into the state folder", async () => {
    const home = await mkdtemp(join(tmpdir(), "tau-agents-home-"));
    const stateDir = await mkdtemp(join(tmpdir(), "tau-agents-state-"));
    const legacy = join(home, ".tau", "agents-links.json");
    try {
      await writeAgentLinks([
        { threadId: "child-a", parentThreadId: "parent", depth: 1, spawnedAt: 1, projectPath: "/project", title: "A", spawnedBy: "tau_spawn_thread" },
      ], legacy);
      await expect(readAgentLinksWithMigration(join(stateDir, "agents-links.json"), legacy)).resolves.toEqual([
        expect.objectContaining({ threadId: "child-a" }),
      ]);
      // Copied once: the old file stays where an older Tau still looks for it.
      await expect(readAgentLinks(join(stateDir, "agents-links.json"))).resolves.toEqual([
        expect.objectContaining({ threadId: "child-a" }),
      ]);
      await expect(readAgentLinks(legacy)).resolves.toEqual([expect.objectContaining({ threadId: "child-a" })]);

      // A second run reads its own file; the old one is not consulted again.
      await writeAgentLinks([], join(stateDir, "agents-links.json"));
      await expect(readAgentLinksWithMigration(join(stateDir, "agents-links.json"), legacy)).resolves.toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("shows a restored agent's duration after a restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agents-links-"));
    const linksPath = join(directory, "agents-links.json");
    try {
      await writeAgentLinks([{
        threadId: "child-1", parentThreadId: "parent", depth: 1, spawnedAt: 1_000,
        projectPath: "/project", title: "Index 1", spawnedBy: "tau_spawn_thread",
        startedAt: 1_100, endedAt: 4_600,
      }], linksPath);
      const bench = await activated({ linksPath });
      const [restored] = (await bench.state()).links;
      expect(restored).toMatchObject({ threadId: "child-1", startedAt: 1_100, endedAt: 4_600 });
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("reads an index file it does not recognise as empty", async () => {
    expect(decodeStoredLinks(undefined)).toEqual([]);
    expect(decodeStoredLinks({ links: "nonsense" })).toEqual([]);
    expect(decodeStoredLinks({ links: [{ threadId: "a" }, { threadId: "b", parentThreadId: "b" }] })).toEqual([]);
    expect(decodeStoredLinks({ links: [{ threadId: "a", parentThreadId: "p" }] })).toEqual([
      { threadId: "a", parentThreadId: "p", depth: 1, spawnedAt: 0, projectPath: "", title: "Sub-agent", spawnedBy: "tau_spawn_thread" },
    ]);
    await expect(readAgentLinks(join(tmpdir(), `tau-agents-missing-${randomUUID()}.json`))).resolves.toEqual([]);
  });

  it("survives its threads going away", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const handle = handleOf(await parent.call("tau_spawn_thread", { prompt: "go" }));
    bench.threads.delete(handle);
    bench.threads.delete("parent");
    await bench.notify("closed", handle);

    await expect(parent.call("tau_get_thread_status", { threadId: handle })).resolves.toMatchObject({ status: "idle", turns: 0 });
    await bench.lifecycles[0]!.sweep?.({ sessions: [], liveThreads: [], projectPaths: [], deleted: [{ sessionId: handle, cwd: "/project" }] });
    await expect(parent.call("tau_list_threads")).resolves.toEqual({ threads: [] });
  });

  it("takes back an agent the index still names after its own links file was lost", async () => {
    const bench = await activated();
    await bench.lifecycles[0]!.sweep?.({
      sessions: [
        { sessionId: "parent", path: "/sessions/parent.jsonl", cwd: "/project" },
        { sessionId: "child-a", path: "/sessions/child-a.jsonl", cwd: "/project", parentThreadId: "parent" },
        { sessionId: "loose", path: "/sessions/loose.jsonl", cwd: "/project" },
      ],
      liveThreads: [],
      projectPaths: ["/project"],
      deleted: [],
    });

    await expect(bench.state()).resolves.toMatchObject({
      links: [expect.objectContaining({ threadId: "child-a", parentThreadId: "parent", status: "idle" })],
    });
    await expect(bench.runtime("parent").call("tau_list_threads")).resolves
      .toMatchObject({ threads: [expect.objectContaining({ threadId: "child-a" })] });
  });
});

describe("Agents Kit definitions", () => {
  const REVIEWER = [
    "---",
    "description: Reviews the change and answers in one word",
    "model: openai/reviewer-model",
    "tools: [read, grep]",
    "access: read-only",
    "workspace: shared",
    "---",
    "Answer every task with the single word PERSONA.",
  ].join("\n");

  const withProject = async (files: Record<string, string>) => {
    const dir = await mkdtemp(join(tmpdir(), "tau-agents-defs-"));
    await mkdir(join(dir, ".tau", "agents"), { recursive: true });
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, ".tau", "agents", name), text);
    const bench = harness();
    bench.setProject(dir);
    bench.open("parent");
    await bench.activate({ linksPath: join(dir, "links.json") });
    // The kit's links file is written after a spawn settles; a slow machine can still be writing it.
    return { dir, bench, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
  };

  it.each(["codex", "claude-code"])("routes panel definitions by runtime and model on %s and refuses native thread restrictions", async (backend) => {
    const { bench, cleanup } = await withProject({
      "simple.md": "---\ndescription: Reviews natively\nmodel: openai/reviewer-model\n---\nReport concrete findings.",
      "restricted.md": REVIEWER,
      "elsewhere.md": "---\ndescription: Different runtime\nruntime: pi\n---\nRead carefully.",
      "different-model.md": "---\ndescription: Different model\nmodel: test/alternate\n---\nRead carefully.",
    });
    try {
      bench.backends.set("parent", backend);
      bench.models.set("parent", parseModel(REVIEWER.match(/model: (.+)/u)![1]!));
      await bench.invoke("start", { parentThreadId: "parent", agent: "simple", prompt: "Check the diff" });
      expect(bench.started).toEqual([]);
      expect(bench.sent).toEqual([expect.objectContaining({ sessionId: "parent", text: expect.stringContaining("Delegate this task to a native subagent.") })]);
      expect(bench.sent[0]?.text).toContain("Use model openai/reviewer-model.");
      await expect(bench.invoke("start", { parentThreadId: "parent", agent: "restricted", prompt: "Check it" })).rejects.toThrow("native agent configuration");
      expect(bench.started).toEqual([]);
      expect(bench.sent).toHaveLength(1);
      const existing = bench.choices.findIndex((choice) => choice.backend.kind === backend);
      if (existing >= 0) bench.choices.splice(existing, 1);
      bench.choices.push({ backend: { kind: backend, label: "Parent" }, enabled: true, readiness: { kind: backend, label: "Parent", state: "ready" }, catalog: { kind: backend, models: [{ provider: "test", id: "alternate", name: "Alternate" }], thinkingLevels: {} } });
      await bench.invoke("start", { parentThreadId: "parent", agent: "elsewhere", prompt: "Check it" });
      expect(bench.started[0]).toMatchObject({ backend: "pi", parent: { threadId: "parent" } });
      await bench.invoke("start", { parentThreadId: "parent", agent: "different-model", prompt: "Check it" });
      expect(bench.started[1]).toMatchObject({ backend, model: { provider: "test", id: "alternate" } });
      const tools = await bench.mcpThread("parent", bench.services.cwd());
      await tools.call("tau_spawn_thread", { prompt: "Check it", agent: "elsewhere" });
      expect(bench.started[2]).toMatchObject({ backend: "pi" });
      await tools.call("tau_spawn_thread", { prompt: "Check it", agent: "elsewhere", runtime: backend, model: "test/alternate" });
      expect(bench.started[3]).toMatchObject({ backend, model: { provider: "test", id: "alternate" } });
    } finally { await bench.registry().dispose(); await cleanup(); }
  });

  /** What Pi hands an extension handler: the session's own entries, and a cwd. */
  const piContext = (entries: unknown[], cwd: string) => ({ cwd, sessionManager: { getEntries: () => entries } });

  it("spawns from a definition and writes its persona into the child's session", async () => {
    const { dir, bench, cleanup } = await withProject({ "reviewer.md": REVIEWER });
    try {
      const spawned = await bench.runtime("parent", dir).call("tau_spawn_thread", { prompt: "Look at the diff", agent: "reviewer" });
      expect(spawned).toMatchObject({ threadId: "child-1", agent: "reviewer", workspace: "shared" });
      expect(bench.started).toEqual([expect.objectContaining({
        cwd: dir,
        prompt: "Look at the diff",
        // The definition's model wins over the parent's.
        model: { provider: "openai", id: "reviewer-model" },
        parent: {
          threadId: "parent",
          details: expect.objectContaining({
            agent: "reviewer",
            persona: {
              name: "reviewer",
              file: join(dir, ".tau", "agents", "reviewer.md"),
              systemPrompt: "Answer every task with the single word PERSONA.",
              tools: ["read", "grep"],
              access: "read-only",
            },
          }),
        },
      })]);
      expect(bench.started[0]!.backend).toBe("pi");
      // The child's session carries the persona, and the parent's names the definition.
      const childEntries = bench.threads.get("child-1")!.entries;
      expect(childEntries[0]!.data).toMatchObject({ persona: { systemPrompt: "Answer every task with the single word PERSONA." } });
      expect(bench.threads.get("parent")!.entries[0]!.data).toMatchObject({ agent: "reviewer", threadId: "child-1" });
      expect((await bench.state()).links).toEqual([expect.objectContaining({ threadId: "child-1", agent: "reviewer" })]);
    } finally {
      await cleanup();
    }
  });

  it("puts the persona into the child's system prompt and keeps only its tools", async () => {
    const { dir, bench, cleanup } = await withProject({ "reviewer.md": REVIEWER });
    try {
      await bench.runtime("parent", dir).call("tau_spawn_thread", { prompt: "Look", agent: "reviewer" });
      const child = bench.runtime("child-1", dir, ["read", "grep", "edit", "write", "bash"]);
      const ctx = piContext(bench.threads.get("child-1")!.entries, dir);
      await child.fire("session_start", { type: "session_start", reason: "new" }, ctx);
      // No Access Kit in this bench: the read-only thread also loses what writes.
      expect(child.active()).toEqual(["read", "grep"]);
      const result = await child.fire("before_agent_start", { type: "before_agent_start", prompt: "Look", systemPrompt: "BASE" }, ctx) as { systemPrompt: string };
      expect(result.systemPrompt).toMatch(/^BASE\n\n# Agent definition: reviewer\n/u);
      expect(result.systemPrompt).toContain("Answer every task with the single word PERSONA.");
      // The child has no tau_spawn_thread left, so it is not told about definitions.
      expect(result.systemPrompt).not.toContain("# Agent definitions");
    } finally {
      await cleanup();
    }
  });

  it("keeps a read-only child from loading more tools when no Access Kit holds it", async () => {
    const { dir, bench, cleanup } = await withProject({ "reviewer.md": REVIEWER.replace("tools: [read, grep]\n", "") });
    try {
      await bench.runtime("parent", dir).call("tau_spawn_thread", { prompt: "Look", agent: "reviewer" });
      const child = bench.runtime("child-1", dir, ["read", "edit", "tool_search"]);
      await child.fire("session_start", { type: "session_start", reason: "new" }, piContext(bench.threads.get("child-1")!.entries, dir));
      expect(child.active()).toContain("read");
      expect(child.active()).not.toEqual(expect.arrayContaining(["edit"]));
      expect(child.active()).not.toContain("tool_search");
    } finally {
      await cleanup();
    }
  });

  it("asks Access Kit to hold the child to the definition's access level", async () => {
    const { dir, bench, cleanup } = await withProject({ "reviewer.md": REVIEWER.replace("tools: [read, grep]\n", "") });
    try {
      const levels: unknown[] = [];
      await bench.registry().activate({
        id: "tau.access",
        name: "Access",
        activate: (context) => {
          context.registerCommand("thread-level", (input) => { levels.push(input); return "read-only"; }, { callers: ["tau.agents"] });
        },
      });
      await bench.runtime("parent", dir).call("tau_spawn_thread", { prompt: "Look", agent: "reviewer" });
      const child = bench.runtime("child-1", dir, ["read", "edit", "bash"]);
      await child.fire("session_start", { type: "session_start", reason: "new" }, piContext(bench.threads.get("child-1")!.entries, dir));
      expect(levels).toEqual([{ threadId: "child-1", level: "read-only" }]);
      // Access Kit gates the writes, so the child keeps its tools.
      expect(child.active()).toEqual(expect.arrayContaining(["read", "edit", "bash"]));
    } finally {
      await cleanup();
    }
  });

  it("tells a thread that may spawn which definitions exist", async () => {
    const { dir, bench, cleanup } = await withProject({ "reviewer.md": REVIEWER });
    try {
      const parent = bench.runtime("parent", dir);
      const result = await parent.fire("before_agent_start", { type: "before_agent_start", prompt: "hi", systemPrompt: "BASE" }, piContext([], dir)) as { systemPrompt: string };
      expect(result.systemPrompt).toBe([
        "BASE",
        "",
        "# Agent definitions",
        "",
        "This project defines agents in .tau/agents/. Pass one as `agent` to tau_spawn_thread to start a thread with its instructions, model and tools:",
        "- reviewer: Reviews the change and answers in one word",
      ].join("\n"));
      // A project without definitions leaves the system prompt alone.
      const bare = harness();
      bare.open("parent");
      await bare.activate({ linksPath: join(dir, "bare-links.json") });
      await expect(bare.runtime("parent", join(dir, "nowhere")).fire("before_agent_start", { systemPrompt: "BASE" }, piContext([], dir))).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("refuses an unknown or broken definition by name and keeps spawning without one", async () => {
    const { dir, bench, cleanup } = await withProject({
      "reviewer.md": REVIEWER,
      "broken.md": "---\nname: broken\n---\nNo description.",
    });
    try {
      const parent = bench.runtime("parent", dir);
      await expect(parent.call("tau_spawn_thread", { prompt: "go", agent: "ghost" })).rejects.toThrow('No agent definition "ghost"');
      await expect(parent.call("tau_spawn_thread", { prompt: "go", agent: "broken" })).rejects.toThrow('"broken"');
      expect(bench.started).toEqual([]);
      await expect(parent.call("tau_spawn_thread", { prompt: "plain" })).resolves.toMatchObject({ threadId: "child-1" });
      expect(bench.started[0]!.parent!.details).not.toHaveProperty("persona");

      const listed = await bench.invoke("definitions", {}) as { definitions: Array<{ name: string }>; problems: Array<{ message: string }> };
      expect(listed.definitions.map((definition) => definition.name)).toEqual(["reviewer"]);
      expect(listed.definitions[0]).not.toHaveProperty("systemPrompt");
      expect(listed.problems).toEqual([expect.objectContaining({ message: expect.stringContaining('"description" is required') })]);
    } finally {
      await cleanup();
    }
  });

  it("inherits a runtime for a persona and honours an explicit runtime override", async () => {
    const { dir, bench, cleanup } = await withProject({
      "reader.md": "---\ndescription: Reads here\ntools: [read]\n---\nRead carefully.",
      "pi-reader.md": "---\ndescription: Reads with Pi\nruntime: pi\n---\nRead with Pi.",
      "limited.md": "---\ndescription: Restricted\naccess: read-only\n---\nRead only.",
    });
    try {
      bench.backends.set("parent", "opencode");
      bench.models.set("parent", { provider: "openai", id: "parent-model" });
      const parent = await bench.mcpThread("parent", dir);
      await parent.call("tau_spawn_thread", { prompt: "Look", agent: "reader" });
      expect(bench.started[0]).toMatchObject({ backend: "opencode", tools: ["read"], model: { provider: "openai", id: "parent-model" }, prompt: expect.stringContaining("Read carefully.") });
      expect(bench.started[0]!.parent!.details).not.toHaveProperty("persona");
      await parent.call("tau_spawn_thread", { prompt: "Look", agent: "pi-reader" });
      expect(bench.started[1]).toMatchObject({ backend: "pi", prompt: "Look" });
      expect(bench.started[1]!.model).toBeUndefined();
      expect(bench.started[1]!.parent!.details).toHaveProperty("persona");
      await expect(parent.call("tau_spawn_thread", { prompt: "Look", agent: "limited" })).rejects.toThrow('"access" only applies on the pi runtime');
      expect(bench.started).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it("starts a definition on another runtime with the persona at the head of its first message", async () => {
    const { dir, bench, cleanup } = await withProject({
      "coder.md": "---\ndescription: Codes elsewhere\nruntime: opencode\n---\nWrite tests first.",
    });
    try {
      await bench.runtime("parent", dir).call("tau_spawn_thread", { prompt: "Fix it", agent: "coder" });
      const start = bench.started[0]!;
      expect(start.backend).toBe("opencode");
      // The parent's own model belongs to Pi; the other runtime picks its own.
      expect(start.model).toBeUndefined();
      expect(start.prompt).toMatch(/^You are working as the agent "coder"\./u);
      expect(start.prompt).toContain("Write tests first.");
      expect(start.prompt.endsWith("Fix it")).toBe(true);
      expect(start.parent!.details).not.toHaveProperty("persona");
    } finally {
      await cleanup();
    }
  });

  it("hands another runtime the definition's tools, and records its refusal as the spawn's error", async () => {
    const { dir, bench, cleanup } = await withProject({
      "scout.md": "---\ndescription: Reads elsewhere\nruntime: opencode\ntools: [read, grep]\n---\nOnly read.",
    });
    try {
      const parent = bench.runtime("parent", dir);
      await parent.call("tau_spawn_thread", { prompt: "Look", agent: "scout" });
      expect(bench.started[0]).toMatchObject({ backend: "opencode", tools: ["read", "grep"] });
      expect(bench.started[0]!.parent!.details).not.toHaveProperty("persona");

      bench.holdStarts(async () => { throw new Error("The Antigravity runtime cannot restrict its tools."); });
      await expect(parent.call("tau_spawn_thread", { prompt: "Look again", agent: "scout" }))
        .resolves.toMatchObject({ status: "failed", error: "The Antigravity runtime cannot restrict its tools." });
    } finally {
      await cleanup();
    }
  });

  it("lets the user start a definition as a child of the thread they read", async () => {
    const { bench, cleanup } = await withProject({ "reviewer.md": REVIEWER });
    try {
      await expect(bench.invoke("start", { parentThreadId: "parent", agent: "reviewer", prompt: "Review it" }))
        .resolves.toMatchObject({ threadId: "child-1", agent: "reviewer" });
      expect((await bench.state()).links).toEqual([expect.objectContaining({ parentThreadId: "parent", agent: "reviewer", spawnedBy: "agents-panel" })]);
      await expect(bench.invoke("start", { parentThreadId: "parent", agent: "reviewer" })).rejects.toThrow('needs "prompt"');
      await expect(bench.invoke("start", { parentThreadId: "gone", agent: "reviewer", prompt: "x" })).rejects.toThrow("Open the thread");
    } finally {
      await cleanup();
    }
  });
});

describe("Agents Kit spawn for another kit", () => {
  const definition = { name: "pr-guide", description: "Writes a guide", systemPrompt: "You write guides.", tools: ["read", "submit_pull_request_guide"], access: "read-only", runtime: "pi" };

  it("starts an agent from a definition the caller carries, in a worktree of the revision it names", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-agent-spawn-"));
    const project = join(root, "project");
    const calls: string[][] = [];
    const runGit: AgentGitRunner = async (cwd, args) => {
      calls.push([cwd, ...args]);
      const command = args.join(" ");
      if (command.startsWith("rev-parse --is-inside-work-tree")) return "true\n";
      if (command.startsWith("rev-parse --verify abc1234^{commit}")) return "abc1234full\n";
      if (command.startsWith("rev-parse --path-format=absolute")) return `${project}/.git\n`;
      return "";
    };
    const bench = await activated({ runGit });
    bench.setProject(project);
    try {
      const spawned = await bench.invoke("spawn", { parentThreadId: "parent", prompt: "Write it", title: "Guide", startAt: "abc1234", model: "anthropic/small-model", thinkingLevel: "high", source: "tau.review", definition }) as { threadId: string; branch: string; agent: string };
      expect(spawned).toMatchObject({ threadId: "child-1", agent: "pr-guide" });
      // The worktree starts from that commit, not from the parent's HEAD and uncommitted work.
      expect(calls.some(([, ...args]) => args.join(" ").startsWith(`worktree add -b ${spawned.branch}`) && args.at(-1) === "abc1234full")).toBe(true);
      expect(calls.some(([, ...args]) => args.join(" ").startsWith("commit-tree"))).toBe(false);
      expect(bench.started[0]).toMatchObject({ title: "Guide", thinkingLevel: "high", model: { provider: "anthropic", id: "small-model" }, parent: { threadId: "parent", details: expect.objectContaining({ spawnedBy: "tau.review", agent: "pr-guide", persona: expect.objectContaining({ name: "pr-guide", access: "read-only", tools: ["read", "submit_pull_request_guide"] }) }) } });
      // No wake is owed to a parent that did not use its own tool.
      expect((await bench.state()).links[0]).toMatchObject({ spawnedBy: "tau.review" });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it.each(["codex", "claude-code"])("admits a trusted kit's %s worktree child before prompting while preserving native delegation defaults", async (runtime) => {
    const root = await mkdtemp(join(tmpdir(), "tau-guide-admission-"));
    const project = join(root, "project");
    const runGit: AgentGitRunner = async (_cwd, args) => {
      if (args.includes("--is-inside-work-tree")) return "true\n";
      if (args.includes("--verify")) return "abc1234full\n";
      if (args.includes("--path-format=absolute")) return `${project}/.git\n`;
      return "";
    };
    const bench = await activated({ runGit }); bench.setProject(project);
    if (runtime === "claude-code") bench.choices.push({ ...bench.choices.find((choice) => choice.backend.kind === "codex")!, backend: { kind: runtime, label: "Claude" }, readiness: { kind: runtime, label: "Claude", state: "ready" } });
    bench.backends.set("parent", runtime); bench.models.set("parent", { provider: "openai", id: "parent-model" });
    const beforePrompt = vi.fn(async (thread: HostThread) => {
      expect(thread.backendKind).toBe(runtime);
      expect(thread.isStreaming()).toBe(false);
      expect(bench.started).toHaveLength(1);
    });
    try {
      const { access: _access, ...restricted } = definition;
      expect(await bench.invoke("spawn", { parentThreadId: "parent", prompt: "Write it", startAt: "abc1234", beforePrompt, definition: { ...restricted, runtime } })).toMatchObject({ threadId: "child-1" });
      expect(beforePrompt).toHaveBeenCalledTimes(1);
      expect(bench.started[0]).toMatchObject({ backend: runtime, tools: definition.tools, model: { provider: "openai", id: "parent-model" } });
      const parent = await bench.mcpThread("parent", project);
      await expect(parent.call("tau_spawn_thread", { prompt: "Same runtime" })).rejects.toThrow("native subagents");
      await expect(bench.invoke("spawn", { parentThreadId: "parent", prompt: "x", beforePrompt: "bad", definition })).rejects.toThrow("in-process callback");
    } finally { await bench.registry().dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it("reports a queued kit job's cancellation before any thread is created", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-guide-queued-"));
    const settingsPath = join(directory, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ maxRunningAgents: 1 }));
    const bench = await activated({ settingsPath });
    const onStartFailed = vi.fn();
    try {
      const parent = await bench.mcpThread("parent");
      await parent.call("tau_spawn_thread", { prompt: "Occupy capacity" });
      const pending = await bench.invoke("spawn", { parentThreadId: "parent", prompt: "Write guide", definition, onStartFailed }) as { threadId: string; status: string };
      expect(pending.status).toBe("pending");
      expect(onStartFailed).not.toHaveBeenCalled();
      await bench.invoke("stop-agent", { threadId: pending.threadId });
      expect(onStartFailed).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("cancelled"));
      expect(bench.started).toHaveLength(1);
    } finally { await bench.registry().dispose(); await rm(directory, { recursive: true, force: true }); }
  });

  it("reports a queued kit job's startup failure before admission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-guide-failed-start-"));
    const settingsPath = join(directory, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ maxRunningAgents: 1 }));
    const bench = await activated({ settingsPath, runGit: async () => { throw new Error("Fixture cannot create worktree"); } });
    const onStartFailed = vi.fn();
    try {
      const parent = await bench.mcpThread("parent");
      await parent.call("tau_spawn_thread", { prompt: "Occupy capacity" });
      await bench.invoke("spawn", { parentThreadId: "parent", prompt: "Write guide", definition, onStartFailed });
      // A queued retry uses sessions.start; reject before its admission callback.
      bench.holdStarts(async () => { throw new Error("Fixture start failed before admission"); });
      bench.threads.get("child-1")!.streaming = false;
      await bench.notify("accepted", "child-1");
      await bench.notify("ended", "child-1");
      await vi.waitFor(() => expect(onStartFailed).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("start failed")));
    } finally { await bench.registry().dispose(); await rm(directory, { recursive: true, force: true }); }
  });

  it("retains a queued child's effort across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-spawn-effort-"));
    const linksPath = join(directory, "links.json");
    const settingsPath = join(directory, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ maxRunningAgents: 1 }));
    const first = await activated({ linksPath, settingsPath });
    let second: Awaited<ReturnType<typeof activated>> | undefined;
    try {
      const parent = await first.mcpThread("parent");
      await parent.call("tau_spawn_thread", { prompt: "Occupy capacity" });
      const queued = await first.invoke("spawn", { parentThreadId: "parent", prompt: "Write it", thinkingLevel: "high", model: "anthropic/small-model", definition }) as { threadId: string; status: string };
      expect(queued.status).toBe("pending");
      await first.registry().dispose();
      second = await activated({ linksPath, settingsPath });
      const recovered = await second.mcpThread("parent");
      await recovered.call("tau_send_to_thread", { threadId: queued.threadId, message: "Continue", mode: "queue" });
      expect(second.started[0]).toMatchObject({ thinkingLevel: "high", model: { provider: "anthropic", id: "small-model" } });
    } finally {
      await first.registry().dispose();
      await second?.registry().dispose();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("refuses a definition without a usable name or prompt, a bad revision and a parent that is not open", async () => {
    const bench = await activated();
    await expect(bench.invoke("spawn", { parentThreadId: "parent", prompt: "x", definition: { name: "Bad Name", systemPrompt: "y" } })).rejects.toThrow("definition takes");
    await expect(bench.invoke("spawn", { parentThreadId: "parent", prompt: "x", definition: { name: "ok", systemPrompt: " " } })).rejects.toThrow("definition takes");
    await expect(bench.invoke("spawn", { parentThreadId: "parent", prompt: "x", startAt: "--upload-pack=x", definition })).rejects.toThrow("commit id");
    await expect(bench.invoke("spawn", { parentThreadId: "gone", prompt: "x", definition })).rejects.toThrow("not open");
  });
});

/** A settings file that lets a thread run `count` children at a time. */
async function settingsWith(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tau-agents-settings-"));
  const path = join(dir, "agents.json");
  await writeFile(path, JSON.stringify({ maxRunningAgents: count }), "utf8");
  return path;
}

describe("Agents Kit orchestration", () => {
  const recoverUncertainNotice = async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agents-notice-ack-"));
    const linksPath = join(directory, "links.json");
    const first = await activated({ linksPath });
    let release!: () => void;
    first.holdSends(() => new Promise<void>((resolve) => { release = resolve; }));
    const child = handleOf(await first.runtime("parent").call("tau_spawn_thread", { prompt: "Retain the complete answer", workspace: "shared" }));
    first.threads.get(child)!.streaming = false;
    first.threads.get(child)!.messages = [{ id: "answer", role: "assistant", text: "Complete retained answer: " + "abcdefghijklmnopqrstuvwxyz".repeat(30), timestamp: 1 }];
    await first.notify("ended", child);
    await expect.poll(() => first.sent).toHaveLength(1);
    await first.registry().dispose();
    const recovered = await activated({ linksPath });
    return { directory, linksPath, child, recovered, cleanup: async () => {
      release();
      await first.registry().dispose();
      await recovered.registry().dispose();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } };
  };

  it("does not acknowledge a new answer that finishes while a follow-up is being admitted", async () => {
    const f = await recoverUncertainNotice();
    let again: Awaited<ReturnType<typeof activated>> | undefined;
    const answer = "New follow-up result: " + "abcdefghijklmnopqrstuvwxyz".repeat(30);
    try {
      f.recovered.open("parent").streaming = true;
      f.recovered.holdSends(async () => {
        const child = f.recovered.open(f.child);
        child.streaming = false;
        child.messages = [{ id: "new-answer", role: "assistant", text: answer, timestamp: 2 }];
        await f.recovered.notify("ended", f.child);
      });
      await expect(f.recovered.runtime("parent").call("tau_send_to_thread", { threadId: f.child, message: "Finish immediately" })).resolves.toMatchObject({ delivered: "started" });
      await f.recovered.registry().dispose();
      again = await activated({ linksPath: f.linksPath });
      expect(await again.runtime("parent").call("tau_get_thread_status", { threadId: f.child })).toMatchObject({ lastAssistantMessage: answer });
      expect(again.sent).toEqual([]);
    } finally {
      await again?.registry().dispose();
      await f.cleanup();
    }
  });

  it("does not reject or repeat an admitted follow-up when its old notice ACK cannot be written", async () => {
    const f = await recoverUncertainNotice();
    const backup = `${f.directory}-retained`;
    let blocked = false;
    try {
      await rename(f.directory, backup);
      await writeFile(f.directory, "Reject notice ACK, not runtime admission");
      blocked = true;
      const parent = f.recovered.runtime("parent");
      const request = { threadId: f.child, message: "Accepted follow-up", clientRequestId: "accepted-follow-up" };
      await expect(parent.call("tau_send_to_thread", request)).resolves.toMatchObject({ delivered: "started", acknowledgmentWarning: expect.any(String) });
      expect(await parent.call("tau_list_threads")).toMatchObject({ threads: [expect.objectContaining({ recovery: expect.objectContaining({ state: "held" }) })] });
      await rm(f.directory);
      await rename(backup, f.directory);
      blocked = false;
      await expect(parent.call("tau_send_to_thread", request)).resolves.toMatchObject({ delivered: "started" });
      expect(f.recovered.sent.filter((send) => send.text === "Accepted follow-up")).toHaveLength(1);
    } finally {
      if (blocked) { await rm(f.directory, { force: true }); await rename(backup, f.directory); }
      await f.cleanup();
    }
  });

  it("retains a notice when status ACK and an in-flight wake both fail their receipt writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agents-concurrent-notice-ack-"));
    const linksPath = join(directory, "links.json");
    const backup = `${directory}-retained`;
    const first = await activated({ linksPath });
    let release!: () => void;
    let blocked = false;
    let recovered: Awaited<ReturnType<typeof activated>> | undefined;
    first.holdSends(() => new Promise<void>((resolve) => { release = resolve; }));
    try {
      const child = handleOf(await first.runtime("parent").call("tau_spawn_thread", { prompt: "Concurrent ACK and wake", workspace: "shared" }));
      first.threads.get(child)!.streaming = false;
      first.threads.get(child)!.messages = [{ id: "answer", role: "assistant", text: "Complete retained answer: " + "abcdefghijklmnopqrstuvwxyz".repeat(30), timestamp: 1 }];
      await first.notify("ended", child);
      await expect.poll(() => first.sent).toHaveLength(1);
      await rename(directory, backup);
      await writeFile(directory, "Reject both receipt writes");
      blocked = true;
      // This ACK must finish with an error without waiting for parent admission.
      await expect(first.runtime("parent").call("tau_get_thread_status", { threadId: child })).rejects.toThrow();
      release();
      await expect.poll(() => first.runtime("parent").call("tau_list_threads")).toMatchObject({ threads: [expect.objectContaining({ recovery: expect.objectContaining({ state: "held", reason: expect.stringContaining("uncertain") }) })] });
      await rm(directory);
      await rename(backup, directory);
      blocked = false;
      await first.runtime("parent").call("tau_spawn_thread", { prompt: "Unrelated durable save", workspace: "shared" });
      await first.registry().dispose();
      recovered = await activated({ linksPath });
      await recovered.notify("ended", "parent");
      expect(recovered.sent).toEqual([]);
      expect(await recovered.runtime("parent").call("tau_get_thread_status", { threadId: child })).toMatchObject({ recovery: { state: "held", reason: expect.stringContaining("uncertain") }, lastAssistantMessage: "Complete retained answer: " + "abcdefghijklmnopqrstuvwxyz".repeat(30) });
      expect(first.sent).toHaveLength(1);
    } finally {
      release?.();
      if (blocked) { await rm(directory, { force: true }); await rename(backup, directory); }
      await first.registry().dispose();
      await recovered?.registry().dispose();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("retains an uncertain answer after a failed status ACK and an unrelated save", async () => {
    const f = await recoverUncertainNotice();
    const backup = `${f.directory}-retained`;
    let blocked = false;
    let again: Awaited<ReturnType<typeof activated>> | undefined;
    try {
      await rename(f.directory, backup);
      await writeFile(f.directory, "Not a directory: reject the ACK write");
      blocked = true;
      const parent = f.recovered.runtime("parent");
      await expect(parent.call("tau_get_thread_status", { threadId: f.child })).rejects.toThrow();
      expect(await parent.call("tau_list_threads")).toMatchObject({ threads: [expect.objectContaining({ recovery: expect.objectContaining({ state: "held", reason: expect.stringContaining("uncertain") }) })] });
      await rm(f.directory);
      await rename(backup, f.directory);
      blocked = false;
      await parent.call("tau_spawn_thread", { prompt: "Unrelated accepted work", workspace: "shared" });
      await f.recovered.notify("ended", "parent");
      expect(f.recovered.sent).toEqual([]);
      await f.recovered.registry().dispose();
      again = await activated({ linksPath: f.linksPath });
      expect(await again.runtime("parent").call("tau_get_thread_status", { threadId: f.child })).toMatchObject({ recovery: { state: "held", reason: expect.stringContaining("uncertain") }, lastAssistantMessage: "Complete retained answer: " + "abcdefghijklmnopqrstuvwxyz".repeat(30) });
      expect(again.sent).toEqual([]);
    } finally {
      if (blocked) { await rm(f.directory, { force: true }); await rename(backup, f.directory); }
      await again?.registry().dispose();
      await f.cleanup();
    }
  });

  it("retains an uncertain answer when an explicit steer of its idle child is rejected", async () => {
    const f = await recoverUncertainNotice();
    try {
      const parent = f.recovered.runtime("parent");
      await expect(parent.call("tau_send_to_thread", { threadId: f.child, message: "Rejected action", mode: "steer" })).rejects.toThrow("not running");
      expect(await parent.call("tau_list_threads")).toMatchObject({ threads: [expect.objectContaining({ recovery: expect.objectContaining({ state: "held", reason: expect.stringContaining("uncertain") }) })] });
      expect(await parent.call("tau_get_thread_status", { threadId: f.child })).toMatchObject({ lastAssistantMessage: "Complete retained answer: " + "abcdefghijklmnopqrstuvwxyz".repeat(30) });
      expect(f.recovered.sent).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("keeps a child's worktree identity available through status after recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-agents-worktree-recovery-"));
    const project = join(root, "project");
    await mkdir(project);
    const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: project, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    await writeFile(join(project, "readme.txt"), "fixture\n");
    git("add", "readme.txt");
    git("commit", "-qm", "fixture");
    const linksPath = join(root, "links.json");
    const first = await activated({ linksPath, runGit: runAgentGit });
    first.setProject(project);
    let second: Awaited<ReturnType<typeof activated>> | undefined;
    try {
      const spawned = await first.runtime("parent", project).call("tau_spawn_thread", { prompt: "Read the fixture", workspace: "worktree" }) as { threadId: string; branch: string };
      const workspace = first.started[0]!.cwd;
      await first.registry().dispose();
      second = await activated({ linksPath, runGit: runAgentGit });
      second.setProject(project);
      expect(await second.runtime("parent", project).call("tau_get_thread_status", { threadId: spawned.threadId })).toMatchObject({ workspace: { branch: spawned.branch, path: workspace } });
    } finally {
      await first.registry().dispose();
      await second?.registry().dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("does not invent a parent wake for a child restored from a legacy link-only store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agents-legacy-no-wake-"));
    const linksPath = join(directory, "links.json");
    await writeFile(linksPath, JSON.stringify({ version: 1, links: [{ threadId: "legacy-child", parentThreadId: "parent", depth: 1, spawnedAt: 1, projectPath: "/project", title: "Legacy child", spawnedBy: "tau_spawn_thread" }] }));
    const recovered = await activated({ linksPath });
    try {
      const child = recovered.open("legacy-child");
      child.messages = [{ id: "answer", role: "assistant", text: "No persisted wake obligation", timestamp: 1 }];
      await recovered.notify("ended", "legacy-child");
      await recovered.notify("ended", "parent");
      expect(await recovered.runtime("parent").call("tau_get_thread_status", { threadId: "legacy-child" })).toMatchObject({ status: "completed", lastAssistantMessage: "No persisted wake obligation" });
      expect(recovered.sent).toEqual([]);
    } finally {
      await recovered.registry().dispose();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("holds a child's ambiguous parent notification after recovery instead of replaying it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agents-uncertain-wake-"));
    const linksPath = join(directory, "links.json");
    const first = await activated({ linksPath });
    let second: Awaited<ReturnType<typeof activated>> | undefined;
    let release!: () => void;
    first.holdSends(() => new Promise<void>((resolve) => { release = resolve; }));
    try {
      const child = handleOf(await first.runtime("parent").call("tau_spawn_thread", { prompt: "Finish before restart", workspace: "shared" }));
      first.threads.get(child)!.streaming = false;
      first.threads.get(child)!.messages = [{ id: "answer", role: "assistant", text: "Retain this answer without paying again", timestamp: 1 }];
      await first.notify("ended", child);
      await expect.poll(() => first.sent).toHaveLength(1);
      await first.registry().dispose();
      second = await activated({ linksPath });
      const recovered = second.runtime("parent");
      expect(await recovered.call("tau_list_threads")).toMatchObject({ threads: [expect.objectContaining({ recovery: expect.objectContaining({ state: "held", reason: expect.stringContaining("uncertain") }) })] });
      await second.notify("ended", "parent");
      await second.notify("ended", child);
      expect(second.sent).toEqual([]);
      expect(await recovered.call("tau_get_thread_status", { threadId: child })).toMatchObject({ lastAssistantMessage: "Retain this answer without paying again", recovery: { state: "held", reason: expect.stringContaining("uncertain") } });
      await second.notify("ended", "parent");
      expect(second.sent).toEqual([]);
    } finally {
      release?.();
      await first.registry().dispose();
      await second?.registry().dispose();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("delivers a completed child's unreported answer after a busy parent recovers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agents-inbox-recovery-"));
    const linksPath = join(directory, "links.json");
    const first = await activated({ linksPath });
    let second: Awaited<ReturnType<typeof activated>> | undefined;
    try {
      first.threads.get("parent")!.streaming = true;
      const child = handleOf(await first.runtime("parent").call("tau_spawn_thread", { prompt: "Answer while parent is busy", workspace: "shared" }));
      const thread = first.threads.get(child)!;
      thread.streaming = false;
      thread.messages = [{ id: "answer", role: "assistant", text: "Ready for the recovered parent", timestamp: 1 }];
      await first.notify("ended", child);
      expect(first.sent).toEqual([]);
      await first.registry().dispose();
      second = await activated({ linksPath });
      // Recovery has no child transcript: the definitely-unsent outcome itself must be durable.
      await second.notify("ended", "parent");
      const recovered = second;
      await expect.poll(() => recovered.sent.map((entry) => entry.text)).toEqual([expect.stringContaining("Ready for the recovered parent")]);
    } finally {
      await first.registry().dispose();
      await second?.registry().dispose();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it.each(["auto", "queue"])("retains an accepted capacity-queued child's handle after recovery and releases with %s", async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agents-pending-recovery-"));
    const linksPath = join(directory, "links.json");
    const settingsPath = join(directory, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ maxRunningAgents: 1 }));
    const first = await activated({ linksPath, settingsPath });
    let second: Awaited<ReturnType<typeof activated>> | undefined;
    try {
      const parent = first.runtime("parent");
      await parent.call("tau_spawn_thread", { prompt: "Occupy the slot", workspace: "shared" });
      const queued = handleOf(await parent.call("tau_spawn_thread", { prompt: "Accepted but not started", workspace: "shared", clientRequestId: "queued-intent" }));
      expect(await parent.call("tau_get_thread_status", { threadId: queued })).toMatchObject({ status: "pending" });
      await first.registry().dispose();
      second = await activated({ linksPath, settingsPath });
      const recovered = second.runtime("parent");
      expect(await recovered.call("tau_list_threads")).toMatchObject({
        threads: expect.arrayContaining([expect.objectContaining({ threadId: queued, recovery: expect.objectContaining({ state: "held" }) })]),
      });
      second.open("child-1").streaming = false;
      await second.notify("ended", "child-1");
      await second.notify("ended", "parent");
      expect(second.started).toEqual([]);
      const retried = await recovered.call("tau_spawn_thread", { prompt: "Accepted but not started", workspace: "shared", clientRequestId: "queued-intent" });
      expect(handleOf(retried)).toBe(queued);
      expect(second.started).toEqual([]);
      const occupant = handleOf(await recovered.call("tau_spawn_thread", { prompt: "Still capacity guarded", workspace: "shared" }));
      await recovered.call("tau_send_to_thread", { threadId: queued, message: "Explicit release", mode });
      expect(second.started).toHaveLength(1);
      second.threads.get(occupant)!.streaming = false;
      await second.notify("ended", occupant);
      await expect.poll(() => second!.started).toHaveLength(2);
      expect(second.started[1]).toMatchObject({ prompt: "Accepted but not started\n\nExplicit release" });
    } finally {
      await first.registry().dispose();
      await second?.registry().dispose();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("refuses a spawn before paid admission when its intent cannot be persisted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agents-intent-write-failure-"));
    const blocked = join(directory, "not-a-directory");
    await writeFile(blocked, "fixture");
    const bench = await activated({ linksPath: join(blocked, "links.json") });
    try {
      await expect(bench.runtime("parent").call("tau_spawn_thread", { prompt: "Do not charge for an undurable request", workspace: "shared" })).rejects.toThrow();
      expect(bench.started).toEqual([]);
      expect(await bench.runtime("parent").call("tau_list_threads")).toEqual({ threads: [] });
    } finally {
      await bench.registry().dispose();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("persists a pending child's full definition, backend and model before acknowledging its handle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agents-full-intent-"));
    const linksPath = join(directory, "links.json");
    const settingsPath = join(directory, "settings.json");
    const definitionsDir = join(directory, ".tau", "agents");
    await mkdir(definitionsDir, { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ maxRunningAgents: 1 }));
    const definition = join(definitionsDir, "reader.md");
    await writeFile(definition, "---\ndescription: Saved persona\nruntime: opencode\nmodel: openai/reviewer-model\nworkspace: shared\n---\nUse the original saved persona.");
    const first = await activated({ linksPath, settingsPath });
    first.setProject(directory);
    let second: Awaited<ReturnType<typeof activated>> | undefined;
    try {
      const parent = first.runtime("parent", directory);
      await parent.call("tau_spawn_thread", { prompt: "Occupy capacity", workspace: "shared" });
      const queued = handleOf(await parent.call("tau_spawn_thread", { prompt: "Full original task", agent: "reader" }));
      // Reopen without a dispose/flush: the ACK itself must imply durable intent.
      await writeFile(definition, "---\ndescription: Replaced persona\nruntime: pi\n---\nDo not use this replacement.");
      second = await activated({ linksPath, settingsPath });
      second.setProject(directory);
      const recovered = second.runtime("parent", directory);
      expect(await recovered.call("tau_get_thread_status", { threadId: queued })).toMatchObject({ status: "pending", recovery: { state: "held", reason: expect.any(String) } });
      expect(second.started).toEqual([]);
      await first.registry().dispose();
      await recovered.call("tau_send_to_thread", { threadId: queued, message: "Release original intent", mode: "queue" });
      expect(second.started).toHaveLength(1);
      expect(second.started[0]).toMatchObject({ cwd: directory, backend: "opencode", model: { provider: "openai", id: "reviewer-model" }, prompt: expect.stringContaining("Full original task\n\nRelease original intent") });
      expect(second.started[0]!.prompt).toContain("Use the original saved persona.");
      expect(second.started[0]!.prompt).not.toContain("Do not use this replacement.");
    } finally {
      await first.registry().dispose();
      await second?.registry().dispose();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("retains an accepted child when the kit closes before its coalesced save", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agents-close-"));
    const linksPath = join(directory, "links.json");
    const first = await activated({ linksPath });
    let second: Awaited<ReturnType<typeof activated>> | undefined;
    try {
      const child = handleOf(await first.runtime("parent").call("tau_spawn_thread", { prompt: "Keep this child", workspace: "shared" }));
      await first.registry().dispose();
      second = await activated({ linksPath });
      expect(await second.runtime("parent").call("tau_list_threads")).toMatchObject({ threads: [{ threadId: child }] });
    } finally {
      await first.registry().dispose();
      await second?.registry().dispose();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("wakes an idle parent for a tool-started child that finishes after kit recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agents-recovery-"));
    const linksPath = join(directory, "links.json");
    const registries: Array<Awaited<ReturnType<typeof activated>>> = [];
    try {
      const first = await activated({ linksPath });
      registries.push(first);
      const child = handleOf(await first.runtime("parent").call("tau_spawn_thread", { prompt: "Recover this task", workspace: "shared" }));
      await first.registry().dispose();
      const recovered = await activated({ linksPath });
      registries.push(recovered);
      expect(await recovered.runtime("parent").call("tau_list_threads")).toMatchObject({ threads: [{ threadId: child }] });
      const restoredChild = recovered.open(child);
      restoredChild.messages = [{ id: "result", role: "assistant", text: "Recovered answer", timestamp: 1 }];
      await recovered.notify("ended", child);
      await expect.poll(() => recovered.sent.filter((entry) => entry.sessionId === "parent").map((entry) => entry.text)).toEqual([
        expect.stringContaining("Recovered answer"),
      ]);
      await recovered.notify("ended", child);
      expect(recovered.sent.filter((entry) => entry.sessionId === "parent")).toHaveLength(1);
    } finally {
      for (const bench of registries) await bench.registry().dispose();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  /** A child that answered and whose turn the host reported over. */
  const finish = async (bench: Awaited<ReturnType<typeof activated>>, threadId: string, answer: string) => {
    const child = bench.threads.get(threadId)!;
    child.streaming = false;
    child.messages.push({ id: `${threadId}-answer`, role: "assistant", text: answer, timestamp: 2 });
    await bench.notify("ended", threadId, "completed");
  };

  it("sends a child more work in each mode", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const child = handleOf(await parent.call("tau_spawn_thread", { prompt: "Start" }));
    await bench.notify("accepted", child);

    // Running: auto steers, queue waits for the turn, steer joins it.
    expect(await parent.call("tau_send_to_thread", { threadId: child, message: "also this" })).toMatchObject({ delivered: "steered" });
    expect(await parent.call("tau_send_to_thread", { threadId: child, message: "after that", mode: "queue" })).toMatchObject({ delivered: "queued" });
    expect(await parent.call("tau_send_to_thread", { threadId: child, message: "now", mode: "steer" })).toMatchObject({ delivered: "steered" });
    // Restart stops the running turn first.
    expect(await parent.call("tau_send_to_thread", { threadId: child, message: "start over", mode: "restart" })).toMatchObject({ delivered: "restarted", status: "running" });
    expect(bench.aborted).toEqual([child]);

    // Idle: auto starts a turn, and steering has nothing to join.
    await finish(bench, child, "done");
    expect(await parent.call("tau_send_to_thread", { threadId: child, message: "next task" })).toMatchObject({ delivered: "started", status: "running" });
    bench.threads.get(child)!.streaming = false;
    await expect(parent.call("tau_send_to_thread", { threadId: child, message: "x", mode: "steer" })).rejects.toThrow("is not running");
    await expect(parent.call("tau_send_to_thread", { threadId: child, message: "x", mode: "later" })).rejects.toThrow("mode must be one of");

    const toChild = bench.sent.filter((entry) => entry.sessionId === child);
    expect(toChild.map((entry) => [entry.delivery, entry.text])).toEqual([
      ["steer", "also this"], ["queue", "after that"], ["steer", "now"], ["prompt", "start over"], ["prompt", "next task"],
    ]);
    expect(toChild.every((entry) => entry.from === "parent")).toBe(true);
    // The queued turn is still to come, so the parent has not been woken yet.
    expect(bench.sent.filter((entry) => entry.sessionId === "parent")).toEqual([]);
  });

  it("queues when a running child's runtime cannot steer", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const child = handleOf(await parent.call("tau_spawn_thread", { prompt: "Start" }));
    bench.refuseSteer();
    expect(await parent.call("tau_send_to_thread", { threadId: child, message: "more" })).toMatchObject({ delivered: "queued" });
    await expect(parent.call("tau_send_to_thread", { threadId: child, message: "more", mode: "steer" })).rejects.toThrow("cannot steer");
  });

  it("adds a message for a queued child to its first prompt", async () => {
    const bench = await activated({ settingsPath: await settingsWith(1) });
    const parent = bench.runtime("parent");
    await parent.call("tau_spawn_thread", { prompt: "First" });
    const queued = handleOf(await parent.call("tau_spawn_thread", { prompt: "Second" }));
    expect(await parent.call("tau_send_to_thread", { threadId: queued, message: "and mind the tests" })).toMatchObject({ delivered: "with its first prompt", status: "pending" });
    await expect(parent.call("tau_send_to_thread", { threadId: queued, message: "x", mode: "steer" })).rejects.toThrow("has not started yet");
    await finish(bench, "child-1", "one");
    await vi.waitFor(() => expect(bench.started[1]?.prompt).toBe("Second\n\nand mind the tests"));
  });

  it("does the work of a retried call once", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const first = await parent.call("tau_spawn_thread", { prompt: "Once", clientRequestId: "req-1" });
    const again = await parent.call("tau_spawn_thread", { prompt: "Once", clientRequestId: "req-1" });
    expect(again).toEqual(first);
    expect(bench.started).toHaveLength(1);
    // Another thread's key is its own.
    bench.open("other-parent");
    await bench.runtime("other-parent").call("tau_spawn_thread", { prompt: "Once", clientRequestId: "req-1" });
    expect(bench.started).toHaveLength(2);

    const child = handleOf(first);
    await parent.call("tau_send_to_thread", { threadId: child, message: "more", mode: "queue", clientRequestId: "send-1" });
    await parent.call("tau_send_to_thread", { threadId: child, message: "more", mode: "queue", clientRequestId: "send-1" });
    expect(bench.sent).toHaveLength(1);
    // A call that failed did nothing, so its key may be tried again.
    await expect(parent.call("tau_send_to_thread", { threadId: child, message: "x", mode: "nope", clientRequestId: "send-2" })).rejects.toThrow();
    await parent.call("tau_send_to_thread", { threadId: child, message: "x", mode: "queue", clientRequestId: "send-2" });
    expect(bench.sent).toHaveLength(2);
  });

  it("cancels a queued child before it starts and stops a running one", async () => {
    const bench = await activated({ settingsPath: await settingsWith(1) });
    const parent = bench.runtime("parent");
    const running = handleOf(await parent.call("tau_spawn_thread", { prompt: "First" }));
    const queued = handleOf(await parent.call("tau_spawn_thread", { prompt: "Second" }));

    expect(await parent.call("tau_cancel_thread", { threadId: queued })).toEqual({ threadId: queued, status: "cancelled", cancelled: true });
    expect(await parent.call("tau_cancel_thread", { threadId: running })).toMatchObject({ threadId: running, status: "cancelled", cancelled: true });
    expect(bench.aborted).toEqual([running]);
    await bench.notify("ended", running, "completed");
    await settle();
    // The freed slot does not start the cancelled one, and nothing wakes the parent.
    expect(bench.started).toHaveLength(1);
    expect(bench.sent).toEqual([]);
    expect((await bench.state()).links.map((link) => link.status)).toEqual(["cancelled", "cancelled"]);
    // A finished or cancelled thread stays as it is.
    expect(await parent.call("tau_cancel_thread", { threadId: running })).toMatchObject({ cancelled: false, status: "cancelled" });
    // New work starts it again.
    expect(await parent.call("tau_send_to_thread", { threadId: running, message: "go on" })).toMatchObject({ delivered: "started", status: "running" });
  });

  it("records the reasoning effort a child's runtime runs at, and none for off", async () => {
    const bench = await activated();
    const child = handleOf(await bench.runtime("parent").call("tau_spawn_thread", { prompt: "Think" }));
    const runtime = bench.runtime(child);
    await runtime.fire("before_agent_start", { systemPrompt: "base" }, { cwd: "/project", sessionManager: { getEntries: () => [] } });
    expect((await bench.state()).links[0]!.effort).toBeUndefined();
    bench.thinking.set(child, "high");
    await runtime.fire("before_agent_start", { systemPrompt: "base" }, { cwd: "/project", sessionManager: { getEntries: () => [] } });
    expect((await bench.state()).links[0]!.effort).toBe("high");

    // A first turn that starts before the kit knows the thread is not lost.
    bench.thinking.set("child-2", "medium");
    await bench.runtime("child-2").fire("before_agent_start", { systemPrompt: "base" }, { cwd: "/project", sessionManager: { getEntries: () => [] } });
    const second = handleOf(await bench.runtime("parent").call("tau_spawn_thread", { prompt: "Early" }));
    expect(second).toBe("child-2");
    expect((await bench.state()).links.find((link) => link.threadId === second)!.effort).toBe("medium");
  });

  it("stops an agent with everything it started, deepest levels included", async () => {
    const bench = await activated({ settingsPath: await settingsWith(1) });
    const child = handleOf(await bench.runtime("parent").call("tau_spawn_thread", { prompt: "Child" }));
    const grandchild = handleOf(await bench.runtime(child).call("tau_spawn_thread", { prompt: "Grandchild" }));
    await bench.runtime(child).call("tau_spawn_thread", { prompt: "Behind the budget" });
    const great = handleOf(await bench.runtime(grandchild).call("tau_spawn_thread", { prompt: "Great-grandchild" }));
    const links = (await bench.state()).links;
    expect(links.map((link) => link.depth).sort()).toEqual([1, 2, 2, 3]);

    expect(await bench.invoke("stop-agent", { threadId: child })).toMatchObject({ cancelled: true, alsoStopped: 3 });
    expect(bench.aborted.sort()).toEqual([child, grandchild, great].sort());
    expect((await bench.state()).links.map((link) => link.status)).toEqual(["cancelled", "cancelled", "cancelled", "cancelled"]);
    // Nothing of the subtree wakes the parent, and the queued one never starts.
    await settle();
    expect(bench.started).toHaveLength(3);
    expect(bench.sent).toEqual([]);
    await expect(bench.invoke("stop-agent", { threadId: "nobody" })).rejects.toThrow("gone");
  });

  it.skipIf(process.platform === "win32").each(["parent Stop", "stop-agent", "cancel"])("%s ends child shell commands and their grandchildren", async (ending) => {
    const bench = await activated();
    const trees: Array<Awaited<ReturnType<typeof ownedProcessTree>>> = [];
    try {
      const child = handleOf(await bench.runtime("parent").call("tau_spawn_thread", { prompt: "Child", workspace: "shared" }));
      const grandchild = handleOf(await bench.runtime(child).call("tau_spawn_thread", { prompt: "Grandchild", workspace: "shared" }));
      const commands = new Map<string, Awaited<ReturnType<typeof ownedProcessTree>>>();
      for (const id of [child, grandchild]) {
        const tree = await ownedProcessTree();
        trees.push(tree);
        commands.set(id, tree);
      }
      const unrelated = await ownedProcessTree();
      trees.push(unrelated);
      const abort = bench.services.sessions.abort!;
      bench.services.sessions.abort = async (id) => {
        await abort(id);
        await commands.get(id)?.stop();
      };
      if (ending === "parent Stop") {
        for (const observer of bench.observers) await observer.stopped?.("parent");
      } else if (ending === "stop-agent") {
        await bench.invoke("stop-agent", { threadId: child });
      } else {
        await bench.runtime("parent").call("tau_cancel_thread", { threadId: child });
      }
      await expect.poll(() => [...commands.values()].flatMap((tree) => tree.alive()), { timeout: 20_000 }).toEqual([]);
      expect(unrelated.alive()).toEqual(unrelated.pids);
      expect(bench.sent).toEqual([]);
    } finally {
      await Promise.all(trees.map((tree) => tree.close()));
      await bench.registry().dispose();
    }
  });

  it("stops three running children and two pending children without waking their parent", async () => {
    const bench = await activated({ settingsPath: await settingsWith(3) });
    try {
      const parent = bench.runtime("parent");
      const children: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        children.push(handleOf(await parent.call("tau_spawn_thread", { prompt: `Task ${index}`, workspace: "shared" })));
      }
      expect(bench.started).toHaveLength(3);
      expect((await bench.state()).links.map((link) => link.status)).toEqual(["running", "running", "running", "pending", "pending"]);
      bench.threads.get("parent")!.streaming = true;
      for (const observer of bench.observers) await observer.stopped?.("parent");
      bench.threads.get("parent")!.streaming = false;
      await bench.notify("ended", "parent");
      for (const child of children.slice(0, 3)) await finish(bench, child, "Late result");
      expect(bench.aborted).toEqual(children.slice(0, 3));
      expect(bench.started).toHaveLength(3);
      expect(bench.sent).toEqual([]);
      expect((await bench.state()).links.map((link) => link.status)).toEqual(Array(5).fill("cancelled"));

      await bench.notify("accepted", "parent");
      const next = handleOf(await parent.call("tau_spawn_thread", { prompt: "New task", workspace: "shared" }));
      await finish(bench, next, "New result");
      await expect.poll(() => bench.sent).toHaveLength(1);
      expect(bench.started).toHaveLength(4);
      expect(bench.sent[0]!.text).toContain("New result");
      expect(bench.sent[0]!.text).not.toContain("Late result");
    } finally {
      await bench.registry().dispose();
    }
  });

  it("drops completed child results still waiting for a busy parent when it stops", async () => {
    const linksPath = join(tmpdir(), `tau-agents-stop-${randomUUID()}.json`);
    const bench = await activated({ linksPath });
    try {
      bench.threads.get("parent")!.streaming = true;
      const child = handleOf(await bench.runtime("parent").call("tau_spawn_thread", { prompt: "Task", workspace: "shared" }));
      await finish(bench, child, "Finished before Stop");
      for (const observer of bench.observers) await observer.stopped?.("parent");
      expect((await readAgentLinks(linksPath)).every((link) => link.notice === undefined)).toBe(true);
      bench.threads.get("parent")!.streaming = false;
      await bench.notify("ended", "parent");
      await bench.notify("accepted", "parent");
      await bench.notify("ended", "parent");
      await bench.registry().dispose();
      expect(bench.sent).toEqual([]);
    } finally {
      await bench.registry().dispose();
      await rm(linksPath, { force: true });
    }
  });

  it("stops descendants below a completed child and never starts their pending work", async () => {
    const bench = await activated({ settingsPath: await settingsWith(1) });
    try {
      const child = handleOf(await bench.runtime("parent").call("tau_spawn_thread", { prompt: "Child", workspace: "shared" }));
      const grandchild = handleOf(await bench.runtime(child).call("tau_spawn_thread", { prompt: "Grandchild", workspace: "shared" }));
      await bench.runtime(child).call("tau_spawn_thread", { prompt: "Pending grandchild", workspace: "shared" });
      bench.threads.get("parent")!.streaming = true;
      await finish(bench, child, "Delegated the task");
      for (const observer of bench.observers) await observer.stopped?.("parent");
      bench.threads.get("parent")!.streaming = false;
      await finish(bench, grandchild, "Late result");
      expect(bench.aborted).toEqual([grandchild]);
      expect(bench.started).toHaveLength(2);
      expect(bench.sent).toEqual([]);
      expect((await bench.state()).links.map((link) => link.status)).toEqual(["completed", "cancelled", "cancelled"]);
    } finally {
      await bench.registry().dispose();
    }
  });

  it("aborts a child whose thread becomes available after its parent stopped", async () => {
    const bench = await activated();
    let release!: () => void;
    let starting!: () => void;
    const reachedStart = new Promise<void>((resolve) => { starting = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    bench.holdStarts(() => { starting(); return gate; });
    try {
      const spawning = bench.runtime("parent").call("tau_spawn_thread", { prompt: "Task", workspace: "shared" });
      await reachedStart;
      for (const observer of bench.observers) await observer.stopped?.("parent");
      release();
      const child = handleOf(await spawning);
      await finish(bench, child, "Late result");
      expect(bench.aborted).toEqual([child]);
      expect(bench.sent).toEqual([]);
      expect((await bench.state()).links[0]!.status).toBe("cancelled");
    } finally {
      release();
      await bench.registry().dispose();
    }
  });

  it("drops a result still being read when Stop arrives, including after the parent resumes", async () => {
    const bench = await activated();
    let release!: () => void;
    let reading!: () => void;
    const reachedRead = new Promise<void>((resolve) => { reading = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const parent = bench.runtime("parent");
      const child = handleOf(await parent.call("tau_spawn_thread", { prompt: "Task", workspace: "shared" }));
      let reads = 0;
      bench.holdTranscripts(async (id) => {
        if (id === child) {
          reads += 1;
          if (reads === 2) { reading(); await gate; }
        }
      });
      const ending = finish(bench, child, "Old result");
      await reachedRead;
      for (const observer of bench.observers) await observer.stopped?.("parent");
      await bench.notify("accepted", "parent");
      release();
      await ending;
      const next = handleOf(await parent.call("tau_spawn_thread", { prompt: "New task", workspace: "shared" }));
      await finish(bench, next, "New result");
      await expect.poll(() => bench.sent).toHaveLength(1);
      expect(bench.sent[0]!.text).toContain("New result");
      expect(bench.sent[0]!.text).not.toContain("Old result");
    } finally {
      release();
      await bench.registry().dispose();
    }
  });

  it("wakes an idle parent with the answer of a child it was not waiting for", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const child = handleOf(await parent.call("tau_spawn_thread", { prompt: "Find the bug", title: "Bug hunt" }));
    await finish(bench, child, "It is in parse.ts line 12.");
    await vi.waitFor(() => expect(bench.sent).toHaveLength(1));
    expect(bench.sent[0]).toMatchObject({ sessionId: "parent", delivery: "queue", wake: { source: "background", label: "Sub-agent finished" } });
    expect(bench.sent[0]!.text).toContain(`"Bug hunt" (threadId ${child}): completed`);
    expect(bench.sent[0]!.text).toContain("It is in parse.ts line 12.");

    // A turn the user started in the child is not the parent's business.
    bench.threads.get(child)!.streaming = true;
    await finish(bench, child, "chatting with the user");
    await settle();
    expect(bench.sent).toHaveLength(1);
  });

  it("wakes the parent after the last turn it gave the child, or at once when one fails", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const child = handleOf(await parent.call("tau_spawn_thread", { prompt: "One" }));
    await parent.call("tau_send_to_thread", { threadId: child, message: "Then two", mode: "queue" });
    await finish(bench, child, "one");
    await settle();
    expect(bench.sent.filter((entry) => entry.sessionId === "parent")).toEqual([]);
    await finish(bench, child, "two");
    await vi.waitFor(() => expect(bench.sent.filter((entry) => entry.sessionId === "parent")).toHaveLength(1));
    expect(bench.sent.at(-1)!.text).toContain("two");
    // The wake started a turn of the parent; it is over by the time the next child fails.
    bench.threads.get("parent")!.streaming = false;

    await parent.call("tau_send_to_thread", { threadId: child, message: "Three" });
    await parent.call("tau_send_to_thread", { threadId: child, message: "Four", mode: "queue" });
    bench.threads.get(child)!.streaming = false;
    await bench.notify("ended", child, "failed");
    await vi.waitFor(() => expect(bench.sent.filter((entry) => entry.sessionId === "parent")).toHaveLength(2));
  });

  it("wakes the parent when the user stops a child whose queued turns were held", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const child = handleOf(await parent.call("tau_spawn_thread", { prompt: "One" }));
    await parent.call("tau_send_to_thread", { threadId: child, message: "Then two", mode: "queue" });
    // Stop holds the child's queue before it tells the kits, so "Then two" never starts.
    for (const observer of bench.observers) await observer.stopped?.(child);
    await finish(bench, child, "stopped halfway");
    await vi.waitFor(() => expect(bench.sent.filter((entry) => entry.sessionId === "parent")).toHaveLength(1));
    expect(bench.sent.at(-1)!.text).toContain(`threadId ${child}`);
  });

  it("wakes nobody when the parent waited for the child, and waits for a busy parent's turn to end", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const waited = handleOf(await parent.call("tau_spawn_thread", { prompt: "One" }));
    const waiting = parent.call("tau_wait_for_thread", { threadId: waited });
    await finish(bench, waited, "one");
    expect(await waiting).toMatchObject({ status: "completed", lastAssistantMessage: "one" });
    await settle();
    expect(bench.sent).toEqual([]);

    const later = handleOf(await parent.call("tau_spawn_thread", { prompt: "Two" }));
    bench.threads.get("parent")!.streaming = true;
    await finish(bench, later, "two");
    await settle();
    expect(bench.sent).toEqual([]);
    bench.threads.get("parent")!.streaming = false;
    await bench.notify("ended", "parent", "completed");
    await vi.waitFor(() => expect(bench.sent.map((entry) => entry.sessionId)).toEqual(["parent"]));
    expect(bench.sent[0]!.text).toContain("two");
  });

  it("keeps a child whose wake the parent refused, and tells it with the next one", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const first = handleOf(await parent.call("tau_spawn_thread", { prompt: "One", title: "First" }));
    const second = handleOf(await parent.call("tau_spawn_thread", { prompt: "Two", title: "Second" }));
    bench.refusePrompts(1);
    await finish(bench, first, "one");
    await settle();
    expect(bench.sent).toEqual([]);
    await finish(bench, second, "two");
    await vi.waitFor(() => expect(bench.sent).toHaveLength(1));
    expect(bench.sent[0]!.text).toContain("2 threads you started have finished.");
    expect(bench.sent[0]!.text).toContain('"First"');
    expect(bench.sent[0]!.text).toContain('"Second"');
  });

  it("does not wake a parent that already read the answer", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const child = handleOf(await parent.call("tau_spawn_thread", { prompt: "One" }));
    bench.threads.get("parent")!.streaming = true;
    await finish(bench, child, "one");
    expect(await parent.call("tau_get_thread_status", { threadId: child })).toMatchObject({ status: "completed" });
    bench.threads.get("parent")!.streaming = false;
    await bench.notify("ended", "parent", "completed");
    await settle();
    expect(bench.sent).toEqual([]);
  });
});
