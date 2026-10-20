import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { importSessionFile } from "./session-import.js";
import { threadUsageFrom, type UsageTally } from "./usage-pricing.js";
import type { HostEvent, UiSession } from "../shared/contracts.js";
import type { HostUpdate } from "../shared/host-protocol.js";
import { HostThreadLifecycleSet, type HostBackendThreadRecord, type HostRuntimeBackendProvider } from "./host-extensions.js";
import { ProjectFactsCache } from "./project-facts-cache.js";
import { ThreadIndex, type ThreadIndexPort } from "./thread-index.js";
import { ThreadRuntime } from "./thread-runtime.js";
import { WorkspaceIdentity } from "./workspace-identity.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";

function shell(overrides: Partial<UiSession> & Pick<UiSession, "id" | "path">): UiSession {
  return {
    title: "Untitled thread",
    modifiedAt: 1,
    projectPath: "/repo",
    projectName: "repo",
    messageCount: 0,
    ...overrides,
  } as UiSession;
}

/** The scan is the only writer of the list; a test seeds it the way the scan would. */
function seed(index: ThreadIndex, sessions: UiSession[]): void {
  (index as unknown as { sessions: UiSession[] }).sessions = sessions;
}

function makeIndex(options: {
  projects?: Array<{ path: string; name: string; lastOpenedAt: number }>;
  live?: ThreadRuntime[];
  threadLifecycle?: HostThreadLifecycleSet;
  inTrash?: (sessionId: string) => boolean;
  sessionsDir?: string;
  backends?: HostRuntimeBackendProvider[];
  priceUsage?: ThreadIndexPort["priceUsage"];
  iconFor?: (path: string) => Promise<string | undefined>;
  externalTimeoutMs?: number;
  parentLinksPath?: string;
  legacyParentLinksPath?: string;
} = {}) {
  const events: HostEvent[] = [];
  const updates: HostUpdate[] = [];
  const noop = () => undefined;
  const projects = new ProjectFactsCache({
    onLabel: noop, onName: noop, onNesting: noop, recordBackground: noop, log: noop,
    errorMessage: (error) => String(error),
  });
  const index = new ThreadIndex({
    ...(options.inTrash ? { inTrash: options.inTrash } : {}),
    cwd: () => "/repo",
    safeMode: !options.backends,
    sessionsDir: options.sessionsDir,
    projects,
    workspaces: new WorkspaceIdentity("host"),
    projectHistory: {
      list: () => [...(options.projects ?? [{ path: "/repo", name: "repo", lastOpenedAt: 2 }])],
      isHidden: () => false,
      iconFor: options.iconFor ?? (async () => undefined),
    } as never,
    threadLifecycle: options.threadLifecycle ?? new HostThreadLifecycleSet(),
    backends: () => new Map((options.backends ?? []).map((provider) => [provider.kind, provider])),
    liveThreads: () => options.live ?? [],
    priceUsage: options.priceUsage ?? ((tallies) => threadUsageFrom(tallies, { overrides: () => undefined, apiPrice: () => undefined, subscription: () => false })),
    hostThread: (thread) => ({ sessionId: thread.threadId }) as never,
    emit: (event) => { events.push(event); },
    emitUpdate: (update) => { updates.push(update); },
    log: noop,
    fail: noop,
    errorMessage: (error) => String(error),
  }, { externalTimeoutMs: options.externalTimeoutMs, parentLinksPath: options.parentLinksPath, legacyParentLinksPath: options.legacyParentLinksPath });
  return { index, events, updates, projects };
}

/** Shell publications are coalesced into the next tick. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

function piThread(threadId: string, title?: string) {
  const backend = {
    kind: "pi" as const,
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId,
    providerSessionId: threadId,
    cwd: "/repo",
    turnReporting: "streamed" as const,
    capabilities: {},
    state: () => ({ streaming: false, idle: true, hasMessages: true, sessionFile: `/${threadId}.jsonl`, activeTools: [], supportsImageInput: false, extensionCount: 0, ...(title ? { title } : {}) }),
    catalogView: () => ({ thinkingLevel: "off", thinkingLevels: [], allTools: [] }),
    models: async () => [],
    composerCommands: () => [],
    transcript: async () => [{ role: "user", text: "Rename the widget factory. It is late." }],
    persist: async () => undefined,
    setTitle: async () => undefined,
    preparePrompt: async () => undefined,
    prompt: async () => ({}),
    abort: async () => undefined,
    dispose: async () => undefined,
    start: async () => undefined,
    waitForIdle: async () => undefined,
  };
  return new ThreadRuntime(backend as never);
}

describe("ThreadIndex", () => {
  it("finds and indexes a session created after the first scan through a direct read", async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), "tau-index-late-"));
    const { index } = makeIndex({ sessionsDir });
    const listing = vi.spyOn(SessionManager, "listAll");
    try {
      await index.refresh("none");
      const path = join(sessionsDir, "later.jsonl");
      await writeFile(path, JSON.stringify({ type: "session", version: 3, id: "later", timestamp: "2026-10-12T10:00:00Z", cwd: "/repo" }) + "\n");
      expect(index.byId("later")).toBeUndefined();
      await expect(index.find("later")).resolves.toMatchObject({ id: "later", path });
      expect(index.byId("later")?.path).toBe(path);
      expect(listing).toHaveBeenCalledTimes(1);
    } finally {
      listing.mockRestore();
      await index.dispose();
      await rm(sessionsDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.env.TAU_SESSION_INDEX_BENCHMARK !== "1")("benchmarks 1000 sessions during a synthetic token stream", async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), "tau-index-benchmark-"));
    const { index } = makeIndex({ sessionsDir });
    const delay = monitorEventLoopDelay({ resolution: 1 });
    let tokens = 0;
    let stream: ReturnType<typeof setInterval> | undefined;
    try {
      for (let batch = 0; batch < 1000; batch += 20) {
        await Promise.all(Array.from({ length: 20 }, async (_, offset) => {
          const id = String(batch + offset);
          const entries = [JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-12T10:00:00Z", cwd: "/repo" })];
          for (let turn = 0; turn < 40; turn++) entries.push(JSON.stringify({
            type: "message", id: `${id}-${turn}`, parentId: turn ? `${id}-${turn - 1}` : null,
            message: { role: turn % 2 ? "assistant" : "user", content: "x".repeat(850), provider: "fixture", model: "fixture", timestamp: turn + 1 },
          }));
          await writeFile(join(sessionsDir, `${id}.jsonl`), entries.join("\n") + "\n");
        }));
      }
      await index.refresh("none");
      // Keep the existing usage refill work in the measured host workload.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const unchanged: number[] = [];
      const changed: number[] = [];
      stream = setInterval(() => {
        JSON.stringify({ type: "message-update", sessionId: "0", delta: `token ${tokens++}` });
      }, 5);
      delay.enable();
      for (let sample = 0; sample < 20; sample++) {
        if (sample >= 10) await appendFile(join(sessionsDir, "0.jsonl"), JSON.stringify({
          type: "message", id: `stream-${sample}`, parentId: sample === 10 ? "0-39" : `stream-${sample - 1}`,
          message: { role: "assistant", content: "streamed response", provider: "fixture", model: "fixture", timestamp: 100 + sample },
        }) + "\n");
        const started = performance.now();
        await index.refresh("changes");
        (sample < 10 ? unchanged : changed).push(performance.now() - started);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const p99 = delay.percentile(99) / 1e6;
      console.info("session index benchmark", JSON.stringify({ sessions: index.list().length, unchangedMs: unchanged, changedMs: changed, eventLoopP99Ms: p99, tokens }));
      expect(index.list()).toHaveLength(1000);
      expect(tokens).toBeGreaterThan(0);
      expect(Math.max(...unchanged)).toBeLessThan(50);
      expect(p99).toBeLessThan(24);
    } finally {
      if (stream) clearInterval(stream);
      delay.disable();
      await index.dispose();
      await rm(sessionsDir, { recursive: true, force: true });
    }
  });

  it("does not parse the whole session history again on an unchanged recovery refresh", async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), "tau-index-refresh-"));
    const { index } = makeIndex({ sessionsDir });
    const listing = vi.spyOn(SessionManager, "listAll");
    try {
      await writeFile(join(sessionsDir, "one.jsonl"), [
        JSON.stringify({ type: "session", version: 3, id: "one", timestamp: "2026-10-12T10:00:00Z", cwd: "/repo" }),
        JSON.stringify({ type: "message", id: "u", parentId: null, message: { role: "user", content: "Hello", timestamp: 1 } }),
      ].join("\n"));
      await index.refresh("none");
      listing.mockClear();
      await index.refresh("changes");
      expect(index.byId("one")?.messageCount).toBe(1);
      expect(listing).not.toHaveBeenCalled();
    } finally {
      listing.mockRestore();
      await index.dispose();
      await rm(sessionsDir, { recursive: true, force: true });
    }
  });

  it("publishes only the changed shells of a recovery scan, and nothing when none changed", async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), "tau-index-recovery-"));
    const { index, events, updates } = makeIndex({ sessionsDir });
    const write = (id: string, text: string) => writeFile(join(sessionsDir, `${id}.jsonl`), [
      JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-12T10:00:00Z", cwd: "/repo" }),
      JSON.stringify({ type: "message", id: "u", parentId: null, message: { role: "user", content: text, timestamp: 1 } }),
    ].join("\n"));
    try {
      await write("one", "Hello");
      await write("two", "Hi");
      await index.refresh("index");
      events.length = 0;
      updates.length = 0;
      await index.refresh("changes");
      expect(events).toEqual([]);
      expect(updates).toEqual([]);
      await appendFile(join(sessionsDir, "two.jsonl"), "\n" + JSON.stringify({ type: "message", id: "a", parentId: "u", message: { role: "assistant", content: [{ type: "text", text: "Hey" }], provider: "fixture", model: "fixture", timestamp: 2 } }));
      await index.refresh("changes");
      expect(events).toEqual([]);
      expect(updates).toEqual([expect.objectContaining({ type: "thread-shell", update: { sessionId: "two", shell: expect.objectContaining({ id: "two", workspaceId: expect.any(String) }) } })]);
    } finally {
      await index.dispose();
      await rm(sessionsDir, { recursive: true, force: true });
    }
  });

  it("publishes a remote project icon change even when its threads have not changed", async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), "tau-project-icon-"));
    const record: HostBackendThreadRecord = {
      threadId: "rex~one", cwd: "/remote", title: "Work", updatedAt: 1, messages: [], messageCount: 1,
      machine: { id: "rex", name: "rex" }, workspace: { workspaceId: "remote", displayPath: "/remote" },
      project: { name: "Tau", icon: "data:image/svg+xml,first" },
    };
    const backend = { kind: "machine", listThreads: async () => [record] } as HostRuntimeBackendProvider;
    const { index, events, updates } = makeIndex({ sessionsDir, backends: [backend] });
    try {
      await index.refresh("changed-index");
      events.length = 0;
      record.project = { name: "Tau", icon: "data:image/svg+xml,second" };
      await index.refresh("changed-index");
      expect(events).toContainEqual(expect.objectContaining({ type: "thread-index" }));
      expect(index.snapshot().projects.find((project) => project.workspaceId === "remote")?.icon).toBe(record.project.icon);
      events.length = 0;
      updates.length = 0;
      await index.refresh("changed-index");
      expect(events).toEqual([]);
      expect(updates).toEqual([]);
      index.publishName("/remote", "Local folder");
      expect(index.byId("rex~one")?.projectName).toBe("Tau");
    } finally {
      await index.dispose();
      await rm(sessionsDir, { recursive: true, force: true });
    }
  });

  it("keeps the home identities of proxy workspaces distinct at the same path", () => {
    const { index } = makeIndex();
    const first = shell({ id: "rex~one", path: "machine:rex~one", backendKind: "machine", projectPath: "/home/dev/repo", workspaceId: "ws1_rex", projectDisplayPath: "~/repo" });
    const second = { ...first, id: "mini~one", path: "machine:mini~one", workspaceId: "ws1_mini" };
    seed(index, [first, second]);
    const snapshot = index.snapshot();
    expect(snapshot.sessions.map((session) => session.workspaceId)).toEqual(["ws1_rex", "ws1_mini"]);
    expect(snapshot.projects.filter((project) => project.path === "/home/dev/repo").map((project) => project.workspaceId)).toEqual(["ws1_rex", "ws1_mini"]);
    expect(snapshot.sessions.map((session) => session.projectDisplayPath)).toEqual(["~/repo", "~/repo"]);
  });

  it("draws a shell for a live thread and derives its title from the first message", async () => {
    const { index, updates } = makeIndex();
    await index.refreshShell(piThread("session"), true);
    expect(index.byId("session")?.title).toBe("Rename the widget factory.");
    expect(index.byPath("/session.jsonl")?.id).toBe("session");
    await flush();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ type: "thread-shell", update: { sessionId: "session" } });
  });

  it("prefers the title the thread carries over the derived one", async () => {
    const { index } = makeIndex();
    await index.refreshShell(piThread("session", "Widget factory"), true);
    expect(index.byId("session")?.title).toBe("Widget factory");
  });

  it("coalesces repeated shell publications into one emit", async () => {
    const { index, updates } = makeIndex();
    seed(index, [shell({ id: "a", path: "/a.jsonl" }), shell({ id: "b", path: "/b.jsonl" })]);
    index.retitle("a", "First");
    index.retitle("b", "Second");
    expect(updates).toHaveLength(0);
    await flush();
    expect(updates).toHaveLength(2);
    expect(index.byId("a")?.title).toBe("First");
  });

  it("moves only the provider of a known shell when the model changes", async () => {
    const { index, updates } = makeIndex();
    seed(index, [shell({ id: "session", path: "/session.jsonl", title: "Kept", messageCount: 9_000, modelProvider: "anthropic" })]);
    const thread = piThread("session");
    const transcript = vi.fn(async () => { throw new Error("a model change read the transcript"); });
    Object.assign((thread as unknown as { backend: object }).backend, {
      transcript,
      catalogView: () => ({ model: { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }, thinkingLevel: "off", thinkingLevels: [], allTools: [] }),
    });
    await index.publishModelProvider(thread);
    expect(transcript).not.toHaveBeenCalled();
    expect(index.byId("session")).toMatchObject({ title: "Kept", messageCount: 9_000, modelProvider: "openai", modifiedAt: 1 });
    await flush();
    expect(updates).toHaveLength(1);
    await index.publishModelProvider(thread);
    await flush();
    expect(updates).toHaveLength(1);
  });

  it("publishes a runtime's usage and title report without reading its transcript", async () => {
    const { index, updates } = makeIndex();
    seed(index, [shell({ id: "session", path: "/session.jsonl", title: "Kept", messageCount: 9_000 })]);
    const thread = piThread("session");
    const transcript = vi.fn(async () => { throw new Error("a usage report read the transcript"); });
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, costUsd: 0.01, turns: 1 };
    Object.assign((thread as unknown as { backend: object }).backend, {
      transcript,
      catalogView: () => ({ thinkingLevel: "off", thinkingLevels: [], allTools: [], usage }),
    });
    await index.publishUsage(thread);
    expect(transcript).not.toHaveBeenCalled();
    expect(index.byId("session")).toMatchObject({ title: "Kept", messageCount: 9_000, usage, modifiedAt: 1 });
    thread.adapterTitle = "Renamed";
    await index.publishUsage(thread);
    expect(index.byId("session")?.title).toBe("Renamed");
    await flush();
    expect(updates).toHaveLength(1);
    await index.publishUsage(thread);
    await flush();
    expect(updates).toHaveLength(1);
  });

  it("ignores a retitle of an unknown or unchanged shell", async () => {
    const { index, updates } = makeIndex();
    seed(index, [shell({ id: "a", path: "/a.jsonl", title: "Kept" })]);
    index.retitle("a", "Kept");
    index.retitle("missing", "Other");
    await flush();
    expect(updates).toEqual([]);
  });

  it("publishes a renamed shell at once and refuses one it does not hold", () => {
    const { index, updates } = makeIndex();
    seed(index, [shell({ id: "a", path: "/a.jsonl" })]);
    const update = index.publishTitle("a", "Renamed");
    expect(update).toMatchObject({ type: "thread-shell", update: { sessionId: "a", shell: { title: "Renamed", workspaceId: expect.stringMatching(/^ws1_/u), projectDisplayPath: "/repo" } } });
    expect(updates).toHaveLength(1);
    expect(() => index.publishTitle("missing", "Renamed")).toThrow("missing from the session index");
  });

  it("publishes why a thread's last turn failed until the mark is cleared", async () => {
    const { index, updates } = makeIndex();
    seed(index, [shell({ id: "a", path: "/a.jsonl" })]);
    index.setTurnError("a", "stream disconnected");
    index.setTurnError("a", "stream disconnected");
    await flush();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ type: "thread-shell", update: { sessionId: "a", shell: { turnError: "stream disconnected" } } });
    index.setTurnError("a", undefined);
    await flush();
    expect(updates).toHaveLength(2);
    expect((updates[1] as { update: { shell: UiSession } }).update.shell.turnError).toBeUndefined();
    index.setRuntimeError("a", "The CLI was not found.");
    await flush();
    expect(updates[2]).toMatchObject({ update: { shell: { runtimeError: "The CLI was not found." } } });
  });

  it("carries a project's new label into every shell of that project", async () => {
    const { index, updates } = makeIndex();
    seed(index, [
      shell({ id: "a", path: "/a.jsonl" }),
      shell({ id: "b", path: "/b.jsonl", projectPath: "/other" }),
    ]);
    index.publishLabel("/repo", "main");
    await flush();
    expect(updates).toHaveLength(1);
    expect(index.byId("a")?.projectLabel).toBe("main");
    expect(index.byId("b")?.projectLabel).toBeUndefined();
    // The unchanged label publishes nothing a second time.
    index.publishLabel("/repo", "main");
    await flush();
    expect(updates).toHaveLength(1);
  });

  it("carries a project's name read after the shells were built into each of its shells", async () => {
    const { index, updates } = makeIndex();
    seed(index, [
      shell({ id: "a", path: "/a.jsonl", projectPath: "/repo-2", projectName: "repo-2" }),
      shell({ id: "b", path: "/b.jsonl", projectName: "other" }),
    ]);
    index.publishName("/repo-2", "repo");
    await flush();
    expect(index.byId("a")?.projectName).toBe("repo");
    expect(index.byId("b")?.projectName).toBe("other");
    expect(updates).toHaveLength(1);
    index.publishName("/repo-2", "repo");
    await flush();
    expect(updates).toHaveLength(1);
  });

  it("withholds projects until they are classified and stamps every shape with its workspace", async () => {
    const { index, projects } = makeIndex();
    seed(index, [shell({ id: "a", path: "/a.jsonl" })]);
    expect(index.snapshot().projects).toEqual([]);
    await projects.settleClassifications();
    const snapshot = index.snapshot();
    expect(snapshot.projects.map((project) => project.path)).toEqual(["/repo"]);
    expect(snapshot.projects[0]?.workspaceId).toBeTruthy();
    expect(snapshot.sessions[0]?.workspaceId).toBe(snapshot.projects[0]?.workspaceId);
  });

  it("lists a project a thread names even when the history never saw it", async () => {
    const { index, projects } = makeIndex({ projects: [] });
    seed(index, [shell({ id: "a", path: "/a.jsonl", projectPath: "/found", projectName: "found" })]);
    index.snapshot();
    await projects.settleClassifications();
    expect(index.snapshot().projects.map((project) => project.path)).toEqual(["/found"]);
  });

  it("draws a project only its threads name with its own picture, once that is read", async () => {
    const asked: string[] = [];
    const { index, projects, updates } = makeIndex({
      projects: [],
      iconFor: async (path) => { asked.push(path); return `data:image/svg+xml,${path.slice(1)}`; },
    });
    seed(index, [shell({ id: "a", path: "/a.jsonl", projectPath: "/found", projectName: "found" })]);
    index.snapshot();
    await projects.settleClassifications();
    expect(index.snapshot().projects[0]?.icon).toBeUndefined();
    // The picture arrives first, its publication a tick after.
    await flush();
    await flush();
    expect(updates.some((update) => update.type === "thread-index")).toBe(true);
    expect(index.snapshot().projects[0]?.icon).toBe("data:image/svg+xml,found");
    expect(asked).toEqual(["/found"]);
  });

  it("reads a parent from the link the start wrote", () => {
    const { index } = makeIndex();
    const manager = { appendCustomEntry: vi.fn(), getSessionId: () => "child" };
    index.linkParent(manager as never, { threadId: "parent" });
    expect(manager.appendCustomEntry).toHaveBeenCalled();
    expect(index.parentOf("child")).toBe("parent");
    expect(index.parentOf("unknown")).toBeUndefined();
  });

  it("stops its timers on dispose", async () => {
    const { index } = makeIndex();
    index.startRecovery();
    await expect(index.dispose()).resolves.toBeUndefined();
  });
});

describe("an imported thread", () => {
  it("is indexed with the machine it came from, in the shell and in the sweep", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-index-import-"));
    try {
      const sessionsDir = join(root, "sessions");
      const cwd = join(root, "project");
      await mkdir(cwd);
      const swept: unknown[] = [];
      const threadLifecycle = new HostThreadLifecycleSet();
      threadLifecycle.add({ sweep: async ({ sessions }) => { swept.push(...sessions); } });
      const { index } = makeIndex({ sessionsDir, threadLifecycle, projects: [{ path: cwd, name: "project", lastOpenedAt: 2 }] });
      const jsonl = [
        JSON.stringify({ type: "session", version: 3, id: "a", timestamp: "2026-09-25T10:00:00.000Z", cwd: "/elsewhere" }),
        JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-09-25T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } }),
      ].join("\n");
      const imported = await importSessionFile({ cwd, jsonl, origin: { hostId: "host-a", threadId: "thread-a" } }, { sessionsDir });

      await index.refresh("none");

      expect(index.byId(imported.sessionId)).toMatchObject({ projectPath: cwd, origin: { hostId: "host-a", threadId: "thread-a" } });
      expect(index.byId(imported.sessionId)?.parentThreadId).toBeUndefined();
      expect(swept).toEqual([expect.objectContaining({ sessionId: imported.sessionId, origin: { hostId: "host-a", threadId: "thread-a" } })]);
      await index.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("ThreadIndex readiness", () => {
  it("is ready once the first scan has read the session files, and a later wait costs nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-index-ready-"));
    try {
      const sessionsDir = join(root, "sessions");
      const cwd = join(root, "project");
      await mkdir(cwd);
      const jsonl = JSON.stringify({ type: "session", version: 3, id: "a", timestamp: "2026-09-25T10:00:00.000Z", cwd });
      const saved = await importSessionFile({ cwd, jsonl, origin: { hostId: "host-a", threadId: "thread-a" } }, { sessionsDir });
      const { index } = makeIndex({ sessionsDir });
      let ready = false;
      const waiting = index.ready().then(() => { ready = true; });

      await flush();
      expect(ready).toBe(false);

      const scan = index.refresh("index");
      await waiting;
      expect(index.byId(saved.sessionId)).toBeDefined();
      await scan;
      await expect(index.ready()).resolves.toBeUndefined();
      await index.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tells a waiter when the host stops before its first scan", async () => {
    const { index } = makeIndex();
    const waiting = index.ready();
    await index.dispose();
    await expect(waiting).rejects.toThrow("The host stopped before it read its threads.");
  });
});

describe("thread deletion", () => {
  it("announces a deleted thread once, whichever side noticed it", async () => {
    const seen: string[] = [];
    const threadLifecycle = new HostThreadLifecycleSet();
    threadLifecycle.add({ threadDeleted: async (sessionId, cwd) => { seen.push(`${sessionId} ${cwd}`); } });
    const { index } = makeIndex({ threadLifecycle });

    await index.announceDeleted("gone", "/repo");
    await index.announceDeleted("gone", "/repo");

    expect(seen).toEqual(["gone /repo"]);
  });

  it("announces a session whose file disappeared, and only that one", async () => {
    const seen: string[] = [];
    const threadLifecycle = new HostThreadLifecycleSet();
    threadLifecycle.add({ threadDeleted: async (sessionId) => { seen.push(sessionId); } });
    const { index } = makeIndex({ threadLifecycle });
    const gone = shell({ id: "gone", path: "/sessions/gone.jsonl" });
    const kept = shell({ id: "kept", path: "/sessions/kept.jsonl" });
    const sweep = (index as unknown as {
      sweep(previous: UiSession[], next: UiSession[]): Promise<void>;
    }).sweep.bind(index);

    await sweep([gone, kept], [kept]);

    expect(seen).toEqual(["gone"]);
  });

  it("leaves a thread in the trash unannounced until it is purged", async () => {
    const seen: string[] = [];
    const threadLifecycle = new HostThreadLifecycleSet();
    threadLifecycle.add({ threadDeleted: async (sessionId) => { seen.push(sessionId); } });
    const { index } = makeIndex({ threadLifecycle, inTrash: (id) => id === "trashed" });
    const trashed = shell({ id: "trashed", path: "/sessions/trashed.jsonl" });
    const sweep = (index as unknown as {
      sweep(previous: UiSession[], next: UiSession[]): Promise<void>;
    }).sweep.bind(index);

    await sweep([trashed], []);

    expect(seen).toEqual([]);
  });
});

describe("threads of other runtimes", () => {
  const tally = (costUsd: number, model = "gpt-5.6-luna"): UsageTally => ({ provider: "openai", model, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 120, costUsd, turns: 1 });
  const record = (threadId: string, usage?: UsageTally[]): HostBackendThreadRecord => ({
    threadId, cwd: "/repo", updatedAt: 1, messages: [{ role: "user", text: `Prompt of ${threadId}` }], ...(usage ? { usage } : {}),
  });
  function backend(kind: string, records: HostBackendThreadRecord[]) {
    const listThreads = vi.fn(async () => records);
    const lookup = vi.fn(async () => { throw new Error("the index looked a thread up on its own"); });
    return { provider: { kind, listThreads, lookup } as unknown as HostRuntimeBackendProvider, listThreads, lookup };
  }
  async function inSessionsDir(run: (sessionsDir: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "tau-thread-index-backends-"));
    try {
      await mkdir(join(root, "sessions"));
      await run(join(root, "sessions"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("keeps a delegated thread hidden after its runtime is released and the index rescans", () => inSessionsDir(async (sessionsDir) => {
    const codex = backend("codex", [record("parent"), record("child")]);
    const { index, updates } = makeIndex({ sessionsDir, backends: [codex.provider] });
    try {
      await index.rememberParent("child", "parent");
      await index.refresh("changes");
      expect(index.byId("child")?.parentThreadId).toBe("parent");
      const published = updates.filter((update) => update.type === "thread-index");
      expect(published.length).toBeGreaterThan(0);
      for (const update of published) {
        if (update.type === "thread-index") {
          const child = update.index.sessions.find((session) => session.id === "child");
          if (child) expect(child.parentThreadId).toBe("parent");
        }
      }
    } finally { await index.dispose(); }
  }));

  it("restores a delegated thread's parent before publishing the first index after a restart", () => inSessionsDir(async (sessionsDir) => {
    const parentLinksPath = join(sessionsDir, "thread-parents.json");
    const codex = backend("codex", [record("parent"), record("child")]);
    const first = makeIndex({ sessionsDir, backends: [codex.provider], parentLinksPath });
    await first.index.rememberParent("child", "parent");
    // Persistence must precede the child's first prompt, without relying on shutdown.
    const restarted = makeIndex({ sessionsDir, backends: [codex.provider], parentLinksPath });
    try {
      await restarted.index.refresh("changes");
      expect(restarted.index.byId("child")?.parentThreadId).toBe("parent");
      for (const update of restarted.updates) {
        if (update.type !== "thread-index") continue;
        for (const child of update.index.sessions.filter((session) => session.id === "child")) {
          expect(child.parentThreadId).toBe("parent");
        }
      }
    } finally { await first.index.dispose(); await restarted.index.dispose(); }
  }));

  it("includes released external children in the lifecycle sweep so their subagent links survive", () => inSessionsDir(async (sessionsDir) => {
    const codex = backend("codex", [record("parent"), record("child")]);
    const sweep = vi.fn();
    const threadLifecycle = new HostThreadLifecycleSet();
    threadLifecycle.add({ sweep });
    const { index } = makeIndex({ sessionsDir, backends: [codex.provider], threadLifecycle });
    try {
      await index.rememberParent("child", "parent");
      await index.refresh("none");
      expect(sweep).toHaveBeenCalledWith(expect.objectContaining({ sessions: expect.arrayContaining([
        expect.objectContaining({ sessionId: "parent" }),
        expect.objectContaining({ sessionId: "child", parentThreadId: "parent" }),
      ]) }));
    } finally { await index.dispose(); }
  }));

  it("migrates existing subagent links before the first publication and retains them when a provider disappears", () => inSessionsDir(async (sessionsDir) => {
    const parentLinksPath = join(sessionsDir, "thread-parents.json");
    const legacyParentLinksPath = join(sessionsDir, "agents-links.json");
    await writeFile(legacyParentLinksPath, JSON.stringify({ version: 2, links: [
      { threadId: "child", parentThreadId: "parent" },
      { id: "pending", parentThreadId: "parent" },
    ] }));
    const records = [record("child")]; // Deleting the parent never promotes a child.
    const codex = backend("codex", records);
    const { index, updates } = makeIndex({ sessionsDir, backends: [codex.provider], parentLinksPath, legacyParentLinksPath });
    try {
      await index.refresh("changes");
      expect(index.byId("child")?.parentThreadId).toBe("parent");
      for (const update of updates) {
        if (update.type !== "thread-index") continue;
        for (const child of update.index.sessions.filter((session) => session.id === "child")) {
          expect(child.parentThreadId).toBe("parent");
        }
      }
      records.length = 0;
      await index.refresh("none");
      records.push(record("child"));
      await index.refresh("none");
      expect(index.byId("child")?.parentThreadId).toBe("parent");
      await rm(legacyParentLinksPath);
      const restarted = makeIndex({ sessionsDir, backends: [codex.provider], parentLinksPath });
      try {
        await restarted.index.refresh("none");
        expect(restarted.index.byId("child")?.parentThreadId).toBe("parent");
      } finally { await restarted.index.dispose(); }
    } finally { await index.dispose(); }
  }));

  it("shows what a thread cost before it is opened, from one listing per scan", () => inSessionsDir(async (sessionsDir) => {
    const codex = backend("codex", [record("priced", [tally(0.25), tally(0.5, "gpt-5.6-sol")]), record("unused"), record("empty", [])]);
    const { index } = makeIndex({ sessionsDir, backends: [codex.provider] });
    const { sessions } = await index.refresh("none");
    const byId = new Map(sessions.map((session) => [session.id, session]));
    expect(byId.get("priced")?.usage).toMatchObject({ costUsd: 0.75, totalTokens: 240, inputTokens: 200, outputTokens: 40, turns: 2 });
    expect(byId.get("unused")).not.toHaveProperty("usage");
    expect(byId.get("empty")).not.toHaveProperty("usage");
    expect(codex.listThreads).toHaveBeenCalledTimes(1);
    expect(codex.lookup).not.toHaveBeenCalled();
  }));

  it("prices them again when prices change", () => inSessionsDir(async (sessionsDir) => {
    let overrides: Record<string, { input: number; output: number }> | undefined;
    const codex = backend("codex", [record("priced", [tally(0.25)])]);
    const { index, updates } = makeIndex({
      sessionsDir,
      backends: [codex.provider],
      priceUsage: (tallies) => threadUsageFrom(tallies, { overrides: () => overrides, apiPrice: () => undefined, subscription: () => false }),
    });
    await index.refresh("none");
    expect(index.byId("priced")?.usage?.costUsd).toBe(0.25);
    overrides = { "openai/gpt-5.6-luna": { input: 1_000, output: 1_000 } };
    index.repriceAll();
    await flush();
    expect(index.byId("priced")?.usage?.costUsd).toBeCloseTo(0.12);
    expect(updates).toContainEqual(expect.objectContaining({ type: "thread-shell", update: expect.objectContaining({ sessionId: "priced" }) }));
    expect(codex.listThreads).toHaveBeenCalledTimes(1);
  }));
});

describe("thread index scale with other runtimes' threads", () => {
  const THREADS = 2_000;
  const median = (values: number[]) => values.slice().sort((left, right) => left - right)[Math.floor(values.length / 2)]!;

  it("prices each listed thread once per scan and never reads one on its own", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-thread-index-scale-"));
    try {
      const sessionsDir = join(root, "sessions");
      await mkdir(sessionsDir);
      const tallies = (index: number): UsageTally[] => ["gpt-5.6-luna", "gpt-5.6-sol", "claude-haiku-4-5"].map((model, slot) => ({
        provider: slot === 2 ? "anthropic" : "openai", model, inputTokens: 1_000 + index, outputTokens: 200, cacheReadTokens: 5_000, cacheWriteTokens: 0, totalTokens: 6_200 + index, costUsd: 0.01 * slot, turns: 4,
      }));
      const providers = ["codex", "claude-code"].map((kind, half) => {
        const records: HostBackendThreadRecord[] = Array.from({ length: THREADS / 2 }, (_, index) => ({
          threadId: `${kind}-${index}`, cwd: `/projects/p${index % 12}`, updatedAt: 1_000_000 - index,
          messages: Array.from({ length: 20 }, (__, turn) => ({ role: turn % 2 ? "assistant" as const : "user" as const, text: `Message ${turn} of thread ${index}` })),
          usage: tallies(index + half),
        }));
        const listThreads = vi.fn(async () => records);
        const lookup = vi.fn(async () => { throw new Error("the index looked a thread up on its own"); });
        return { provider: { kind, listThreads, lookup } as unknown as HostRuntimeBackendProvider, listThreads, lookup };
      });
      let priced = 0;
      const source = { overrides: () => undefined, apiPrice: () => ({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }), subscription: () => false };
      const { index } = makeIndex({ sessionsDir, backends: providers.map((entry) => entry.provider), priceUsage: (list) => { priced += 1; return threadUsageFrom(list, source); } });
      const cold = performance.now();
      await index.refresh("none");
      const coldMs = performance.now() - cold;
      const warm: number[] = [];
      for (let round = 0; round < 10; round += 1) {
        const started = performance.now();
        await index.refresh("none");
        warm.push(performance.now() - started);
      }
      const reprice = performance.now();
      index.repriceAll();
      const repriceMs = performance.now() - reprice;
      // Printed for docs/PERFORMANCE.md; the counts below are what the test holds.
      console.info(`[thread-index-scale] threads=${THREADS} cold=${coldMs.toFixed(1)}ms warm=${median(warm).toFixed(1)}ms (median of 10) reprice=${repriceMs.toFixed(1)}ms priced=${priced}`);
      const listed = index.list().filter((session) => session.backendKind !== undefined);
      expect(listed).toHaveLength(THREADS);
      expect(listed.every((session) => (session.usage?.totalTokens ?? 0) > 0)).toBe(true);
      expect(priced).toBe(THREADS * 12);
      for (const entry of providers) {
        expect(entry.listThreads).toHaveBeenCalledTimes(11);
        expect(entry.lookup).not.toHaveBeenCalled();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("finishes a usable index around a hung provider and retains its last rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "tau-hung-index-"));
  const listThreads = vi.fn(() => new Promise<HostBackendThreadRecord[]>(() => {}));
  const provider = { kind: "slow", listThreads } as unknown as HostRuntimeBackendProvider;
  const healthy = { kind: "healthy", listThreads: async () => [{ threadId: "fresh", cwd: "/repo", updatedAt: 2, messages: [] }] } as unknown as HostRuntimeBackendProvider;
  const { index } = makeIndex({ sessionsDir: root, backends: [provider, healthy], externalTimeoutMs: 20 });
  seed(index, [shell({ id: "retained", path: "tau-thread:slow:retained", backendKind: "slow" })]);
  try {
    const answer = await Promise.race([index.refresh("index"), new Promise<undefined>((resolve) => setTimeout(resolve, 100))]);
    expect(answer, "the hung provider must not block the shared index").toBeDefined();
    expect(answer?.complete).toBe(true);
    expect(answer?.sessions.map((row) => row.id).sort()).toEqual(["fresh", "retained"]);
    expect(answer?.unavailableBackends).toEqual(["slow"]);
    await index.refresh("index");
    expect(listThreads).toHaveBeenCalledOnce();
  } finally { await index.dispose(); await rm(root, { recursive: true, force: true }); }
});

it("publishes healthy rows before timeout, then accepts a late successful deletion without duplicate calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "tau-delayed-index-"));
  let resolve!: (value: HostBackendThreadRecord[]) => void;
  const listThreads = vi.fn().mockResolvedValueOnce([{ threadId: "old", cwd: "/repo", updatedAt: 1, messages: [] }])
    .mockImplementationOnce(() => new Promise<HostBackendThreadRecord[]>((done) => { resolve = done; }))
    .mockResolvedValue([]);
  const provider = { kind: "slow", listThreads } as unknown as HostRuntimeBackendProvider;
  let healthyId = "first";
  const healthy = { kind: "healthy", listThreads: async () => [{ threadId: healthyId, cwd: "/repo", updatedAt: 2, messages: [] }] } as unknown as HostRuntimeBackendProvider;
  const { index, updates } = makeIndex({ sessionsDir: root, backends: [provider, healthy], externalTimeoutMs: 40 });
  try {
    await index.refresh("index");
    updates.length = 0;
    healthyId = "changed";
    const pending = index.refresh("index");
    await vi.waitFor(() => expect(updates.some((update) => update.type === "thread-index" && update.index.complete === false && update.index.sessions.some((row) => row.id === "changed"))).toBe(true), { interval: 1, timeout: 30 });
    const failed = await pending;
    expect(failed.sessions.map((row) => row.id).sort()).toEqual(["changed", "old"]);
    expect(failed.unavailableBackends).toEqual(["slow"]);
    await index.refresh("index");
    expect(listThreads).toHaveBeenCalledTimes(2);
    resolve([]);
    await vi.waitFor(() => expect(index.list().some((row) => row.id === "old")).toBe(false), { interval: 1 });
    const recovered = index.snapshot();
    expect(recovered.sessions.map((row) => row.id)).toEqual(["changed"]);
    expect(recovered.unavailableBackends).toEqual([]);
  } finally { await index.dispose(); await rm(root, { recursive: true, force: true }); }
});

it("rejects the late answer of a replaced provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "tau-replaced-index-"));
  let resolve!: (value: HostBackendThreadRecord[]) => void;
  const old = { kind: "runtime", listThreads: () => new Promise<HostBackendThreadRecord[]>((done) => { resolve = done; }) } as unknown as HostRuntimeBackendProvider;
  const backends = [old];
  const { index } = makeIndex({ sessionsDir: root, backends, externalTimeoutMs: 10 });
  try {
    await index.refresh("index");
    backends[0] = { kind: "runtime", listThreads: async () => [{ threadId: "new", cwd: "/repo", updatedAt: 2, messages: [] }] } as unknown as HostRuntimeBackendProvider;
    expect((await index.refresh("index")).sessions.map((row) => row.id)).toEqual(["new"]);
    resolve([{ threadId: "obsolete", cwd: "/repo", updatedAt: 3, messages: [] }]);
    await Promise.resolve(); await Promise.resolve();
    expect((await index.refresh("index")).sessions.map((row) => row.id)).toEqual(["new"]);
  } finally { await index.dispose(); await rm(root, { recursive: true, force: true }); }
});
