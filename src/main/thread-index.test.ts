import { describe, expect, it, vi } from "vitest";
import type { HostEvent, UiSession } from "../shared/contracts.js";
import type { HostUpdate } from "../shared/host-protocol.js";
import { HostThreadLifecycleSet } from "./host-extensions.js";
import { ProjectFactsCache } from "./project-facts-cache.js";
import { ThreadIndex } from "./thread-index.js";
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
} = {}) {
  const events: HostEvent[] = [];
  const updates: HostUpdate[] = [];
  const noop = () => undefined;
  const projects = new ProjectFactsCache({
    onLabel: noop, onNesting: noop, recordBackground: noop, log: noop,
    errorMessage: (error) => String(error),
  });
  const index = new ThreadIndex({
    cwd: () => "/repo",
    safeMode: true,
    sessionsDir: undefined,
    projects,
    workspaces: new WorkspaceIdentity("host"),
    projectHistory: {
      list: () => [...(options.projects ?? [{ path: "/repo", name: "repo", lastOpenedAt: 2 }])],
      isHidden: () => false,
    } as never,
    threadLifecycle: options.threadLifecycle ?? new HostThreadLifecycleSet(),
    backends: () => new Map(),
    liveThreads: () => options.live ?? [],
    hostThread: (thread) => ({ sessionId: thread.threadId }) as never,
    emit: (event) => { events.push(event); },
    emitUpdate: (update) => { updates.push(update); },
    log: noop,
    fail: noop,
    errorMessage: (error) => String(error),
  });
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
    expect(update).toMatchObject({ type: "thread-shell", update: { sessionId: "a", shell: { title: "Renamed" } } });
    expect(updates).toHaveLength(1);
    expect(() => index.publishTitle("missing", "Renamed")).toThrow("missing from the session index");
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
      sweep(infos: unknown[], previous: UiSession[], next: UiSession[]): Promise<void>;
    }).sweep.bind(index);

    await sweep([], [gone, kept], [kept]);

    expect(seen).toEqual(["gone"]);
  });
});
