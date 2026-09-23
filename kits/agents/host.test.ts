import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PARENT_LINK_ENTRY,
  parentLinkEntry,
  type GlobalHostEvent,
  type HostExtensionServices,
  type HostThread,
  type HostThreadLifecycle,
  type HostThreadStartOptions,
  type HostTurnObserver,
  type RuntimeExtensionContribution,
  type UiMessage,
  type UiToolRun,
} from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
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
  writeAgentLinks,
} from "./host.js";
import type { AgentGitRunner } from "../workspace/agent-worktrees.js";
import { AgentThreadBook, decodeSpawnRequest, decodeThreadId, decodeTimeout, deriveStatus, parseModel, readMaxRunningAgents } from "./threads.js";

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
  let projectCwd = "/project";

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
      backendKind: "pi",
      sessionFile: `/sessions/${threadId}.jsonl`,
      isStreaming: () => found.streaming,
      isIdle: () => found.idle,
      transcript: async () => found.messages,
      entries: () => found.entries,
      appendEntry: (customType: string, data: unknown) => { found.entries.push({ type: "custom", customType, data }); },
    } as unknown as HostThread;
  };

  /** Holds `sessions.start` open, so a test can watch how many run at once. */
  let startGate: (() => Promise<void>) | undefined;

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
    removePackage: async () => { throw new Error("no installer in this test"); },
    updatePackages: async () => [],
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
        thread.streaming = true;
        // The host records the link in the new session before its first prompt.
        if (startOptions.parent) {
          thread.entries.push({
            type: "custom",
            customType: PARENT_LINK_ENTRY,
            data: parentLinkEntry(startOptions.parent.threadId, startOptions.parent.details),
          });
        }
        return { sessionId, cwd: startOptions.cwd, ...(startOptions.title ? { title: startOptions.title } : {}) };
      },
      exclusive: (work) => work(),
      remove: async () => undefined, restore: async () => undefined, trash: async () => [], purge: async () => undefined,
      refreshIndex: async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }),
    },
    clients: { observe: () => () => undefined, count: () => 1 },
    registerThreadLifecycle: (lifecycle) => { lifecycles.push(lifecycle); return () => undefined; },
    registerTurnObserver: (observer) => { observers.push(observer); return () => undefined; },
    pinTranscriptEntries: () => () => undefined,
    decorateUiPrompt: () => () => undefined,
    registerRuntimeExtension: (name, factory, extensionOptions) => { runtimeExtensions.push({ name, factory, ...extensionOptions }); return () => undefined; },
    loadRuntimeExtension: async () => { throw new Error("no runtime packages in this test"); },
    loadDependency: async () => { throw new Error("no dependencies in this test"); },
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
    } as never, { sessionId, cwd });
    return {
      call: async (name: string, params: unknown = {}, signal?: AbortSignal) =>
        (await tools.get(name)!.execute("call-1", params, signal, undefined, { model: { provider: "anthropic", id: "sonnet" } })).details,
      fire: (event: string, payload: unknown, ctx?: unknown) => piEvents.get(event)?.(payload, ctx),
      names: () => [...tools.keys()],
      active: () => active ?? all(),
    };
  };

  /** The kit registers one turn observer; this is the host telling it what happened. */
  const notify = async (event: "accepted" | "ended" | "closed" | "toolEnded", sessionId: string, extra?: unknown) => {
    for (const observer of observers) {
      if (event === "accepted") observer.accepted?.(sessionId, "turn-1", { deferBefore: false });
      if (event === "ended") await observer.ended?.(sessionId, "turn-1", (extra as "completed" | "failed") ?? "completed");
      if (event === "closed") await observer.closed?.(sessionId);
      if (event === "toolEnded") observer.toolEnded?.(sessionId, extra as UiToolRun, "/project");
    }
  };

  const state = async (): Promise<AgentsState> => await invoke("state") as AgentsState;

  const holdStarts = (gate: () => Promise<void>) => { startGate = gate; };

  return { activate, services, threads, started, events, observers, lifecycles, runtime, open, notify, state, holdStarts, invoke: (command: string, input?: unknown) => invoke(command, input), registry: () => registry!, setProject: (dir: string) => { projectCwd = dir; } };
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

/** Waits for the kit's coalesced publish and file write. */
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
    expect(() => parseModel("sonnet")).toThrow("provider/model-id");
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
    expect(deriveStatus({ ...facts, turns: 1, lastOutcome: "completed", live: { streaming: false, idle: true } })).toBe("completed");
    expect(deriveStatus({ ...facts, turns: 1, lastOutcome: "failed" })).toBe("failed");
    expect(deriveStatus({ ...facts, error: "gone" })).toBe("failed");
    expect(deriveStatus(facts)).toBe("idle");
  });

  it("stops nesting at depth 2 and hands out slots oldest first", () => {
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

    // A depth-1 agent may still delegate once; its child may not.
    book.assertCanSpawn("t0");
    book.add(link("grand", "t0", 20, 2));
    book.noteStarted("grand", "t2", 21);
    expect(() => book.assertCanSpawn("t2")).toThrow("may nest 2 levels deep");
  });
});

describe("Agents Kit", () => {
  it("registers its five tools on every runtime", async () => {
    const bench = await activated();
    expect(bench.runtime("parent").names()).toEqual([
      "tau_spawn_thread",
      "tau_get_thread_status",
      "tau_wait_for_thread",
      "tau_apply_thread_changes",
      "tau_list_threads",
    ]);
  });

  it("spawns a thread in the caller's project and records the link on both sessions", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const spawned = await parent.call("tau_spawn_thread", { prompt: "Reply with ALPHA" }) as { threadId: string; title: string; status: string };

    // The project of this bench is no repository, so the child shares its checkout.
    expect(spawned).toEqual({ threadId: "child-1", title: "Reply with ALPHA", status: "running", workspace: "shared" });
    expect(bench.started).toEqual([{
      cwd: "/project",
      prompt: "Reply with ALPHA",
      title: "Reply with ALPHA",
      model: { provider: "anthropic", id: "sonnet" },
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
      if (command.startsWith("rev-parse --is-inside-work-tree")) return "true\n";
      if (command.startsWith("rev-parse --verify HEAD")) return "headcommit\n";
      if (command.startsWith("rev-parse --path-format=absolute")) return `${project}/.git\n`;
      if (command.startsWith("rev-parse --verify --quiet refs/tau/checkpoints")) return "treeid\n";
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
    // The parent recorded a checkpoint, so the child starts from that tree.
    bench.threads.get("parent")!.entries.push({
      type: "custom",
      customType: "tau.turn-checkpoint.v1",
      data: { afterSnapshotId: "refs/tau/checkpoints/parent/turn-1/after" },
    });
    const parent = bench.runtime("parent", project);

    const spawned = await parent.call("tau_spawn_thread", { prompt: "Write the answer" }) as { threadId: string; branch: string; workspace: string };
    expect(spawned.workspace).toBe("worktree");
    expect(spawned.branch).toMatch(/^tau\/agent-/u);
    // The thread runs in the worktree, not in the parent's checkout.
    expect(bench.started[0]?.cwd).toBe(join(root, "project-worktrees", spawned.branch.replace("/", "-")));
    expect(calls.some(([, ...args]) => args[0] === "commit-tree")).toBe(true);
    expect(calls.some(([, ...args]) => args.join(" ").startsWith(`worktree add -b ${spawned.branch}`))).toBe(true);

    bench.threads.get(spawned.threadId)!.streaming = false;
    await bench.notify("ended", spawned.threadId);
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
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
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
    await parent.call("tau_spawn_thread", { prompt: "go", model: "openai/gpt-5", projectPath: "/other" });
    expect(bench.started[0]).toMatchObject({ cwd: "/other", model: { provider: "openai", id: "gpt-5" } });
    await expect(parent.call("tau_spawn_thread", { prompt: "go", projectPath: "/nowhere" })).rejects.toThrow("not a project this host has open");
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
      await expect(readAgentsSettings(path)).resolves.toBe(2);
      const bench = await activated({ settingsPath: path });
      await expect(bench.state()).resolves.toMatchObject({ maxRunning: 2 });
      const parent = bench.runtime("parent");
      const statuses = [];
      for (const index of [0, 1, 2]) {
        statuses.push(((await parent.call("tau_spawn_thread", { prompt: `t${index}` })) as { status: string }).status);
      }
      expect(statuses).toEqual(["running", "running", "pending"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

  it("surfaces a question the agent is holding as waiting, not as an answer for the parent", async () => {
    const bench = await activated();
    const parent = bench.runtime("parent");
    const handle = handleOf(await parent.call("tau_spawn_thread", { prompt: "go" }));
    bench.threads.get(handle)!.streaming = false;
    bench.runtime(handle).fire("ui_prompt_start", { kind: "confirm", title: "Run rm -rf?" });

    await expect(parent.call("tau_get_thread_status", { threadId: handle }))
      .resolves.toMatchObject({ status: "waiting", pendingToolPrompt: "Run rm -rf?" });
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
      await settle();
      await expect(readAgentLinks(linksPath)).resolves.toEqual([expect.objectContaining({ threadId: "child-a" })]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes a spawned agent into the index file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agents-links-"));
    const linksPath = join(directory, "agents-links.json");
    try {
      const bench = await activated({ linksPath });
      await bench.runtime("parent").call("tau_spawn_thread", { prompt: "Reply with ALPHA" });
      await settle();
      await expect(readAgentLinks(linksPath)).resolves.toEqual([
        { threadId: "child-1", parentThreadId: "parent", depth: 1, spawnedAt: expect.any(Number), projectPath: "/project", title: "Reply with ALPHA", spawnedBy: "tau_spawn_thread", startedAt: expect.any(Number) },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
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
      await settle();
      const [stored] = await readAgentLinks(linksPath);
      expect(stored?.startedAt).toEqual(expect.any(Number));
      expect(stored?.endedAt).toBeGreaterThanOrEqual(stored!.startedAt!);

      // A file the previous build wrote has no times; every other field reads on.
      await writeFile(linksPath, JSON.stringify({
        version: 1,
        links: [{ threadId: "old-child", parentThreadId: "parent", depth: 1, spawnedAt: 7, projectPath: "/project", title: "Old", spawnedBy: "tau_spawn_thread" }],
      }), "utf8");
      await expect(readAgentLinks(linksPath)).resolves.toEqual([
        { threadId: "old-child", parentThreadId: "parent", depth: 1, spawnedAt: 7, projectPath: "/project", title: "Old", spawnedBy: "tau_spawn_thread" },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps its links in the state folder the host gave it", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tau-agents-state-"));
    try {
      const bench = await activated({ stateDir });
      const parent = bench.runtime("parent");
      await parent.call("tau_spawn_thread", { prompt: "go", title: "Index 1" });
      await settle();
      // The registry gives every extension its own folder under the root.
      await expect(readAgentLinks(join(stateDir, AGENTS_HOST_EXTENSION_ID, "agents-links.json"))).resolves.toEqual([
        expect.objectContaining({ parentThreadId: "parent", title: "Index 1" }),
      ]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
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
      await rm(home, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
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
      await rm(directory, { recursive: true, force: true });
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
    "model: openai/gpt-5.6-luna",
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
        model: { provider: "openai", id: "gpt-5.6-luna" },
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
      expect(bench.started[0]!.backend).toBeUndefined();
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

  it("starts a definition on another runtime with the persona at the head of its first message", async () => {
    const { dir, bench, cleanup } = await withProject({
      "coder.md": "---\ndescription: Codes elsewhere\nruntime: claude-code\n---\nWrite tests first.",
    });
    try {
      await bench.runtime("parent", dir).call("tau_spawn_thread", { prompt: "Fix it", agent: "coder" });
      const start = bench.started[0]!;
      expect(start.backend).toBe("claude-code");
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
