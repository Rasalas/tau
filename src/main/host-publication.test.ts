import { describe, expect, it, vi } from "vitest";
import { HostPublication } from "./host-publication.js";
import type { HostSnapshot } from "../shared/contracts.js";
import type { HostPublicationDeps } from "./host-publication.js";
import type { ThreadRuntime } from "./thread-runtime.js";

describe("HostPublication", () => {
  const makePublication = (overrides: Partial<HostPublicationDeps> = {}) => {
    const emitUpdate = vi.fn();
    const index = {
      byId: vi.fn((id: string) => ({ id, title: "Test Shell" })),
      snapshot: vi.fn(() => ({ projects: [], sessions: [] })),
      publishLabel: vi.fn(),
    } as any;
    const workspaces = {
      ref: vi.fn((cwd: string) => ({ workspaceId: "ws-1", displayPath: cwd })),
    } as any;
    const metrics = {
      recordIpc: vi.fn(),
    } as any;
    const view = { active: vi.fn((): ThreadRuntime | undefined => undefined), cwd: vi.fn(() => "/test/dir"), extensionCount: vi.fn(() => 0) };

    const pub = new HostPublication({
      index,
      workspaces,
      metrics,
      emitUpdate,
      view,
      projection: {
        hostSnapshot: (thread, models, cwd) => ({ ...makeSnapshot(thread?.threadId, cwd), models }),
        catalog: (_thread, models) => ({ models }) as never,
      },
      projects: { label: () => undefined, settleClassifications: async () => undefined },
      completions: { models: () => new Promise<never>(() => undefined) },
      modelsKey: (cwd) => `key:${cwd}`,
      backends: () => [],
      piModes: () => [],
      defaultBackendKind: "pi",
      isCurrentActivation: () => true,
      log: vi.fn(),
      errorMessage: (error) => String(error),
      fail: vi.fn(),
      ...overrides,
    });

    return { pub, emitUpdate, index, workspaces, metrics, view };
  };

  /** A thread the host runs itself, whose catalog read waits for `release`. */
  const localThread = (threadId: string) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const models = vi.fn(async () => { await gate; return [{ provider: "openai", id: "gpt" }]; });
    return { thread: { threadId, runtime: {}, backend: { models } } as unknown as ThreadRuntime, models, release };
  };

  function makeSnapshot(sessionId = "sess-1", cwd = "/test/dir"): HostSnapshot {
    return {
    sessionId,
    cwd,
    projectLabel: "my-project",
    model: { provider: "anthropic", id: "claude-3-7-sonnet" },
    models: [],
    thinkingLevels: [],
    allTools: [],
    composerCommands: [],
    tools: [],
    messages: [],
    activeTools: [],
    taskHistory: [],
    turnActivityHistory: [],
    runtimeCommands: [],
    agentStatus: "idle",
    } as unknown as HostSnapshot;
  }

  it("projects detail for snapshot and caches in detailStore", () => {
    const { pub } = makePublication();
    const snap = makeSnapshot();
    const detail = pub.detailForSnapshot(snap, "req-123" as any);

    expect(detail.requestId).toBe("req-123");
    expect(pub.detailStore.get(snap.sessionId)).toBeDefined();
  });

  it("produces project metadata with workspace references", () => {
    const { pub, workspaces } = makePublication();
    const meta = pub.projectMetadata("/test/dir", "label");

    expect(workspaces.ref).toHaveBeenCalledWith("/test/dir");
    expect(meta.cwd).toBe("/test/dir");
    expect(meta.label).toBe("label");
    expect(meta.workspaceId).toBe("ws-1");
  });

  it("assembles lifecycle updates including shell, detail, catalog, and project", () => {
    const { pub, index } = makePublication();
    const snap = makeSnapshot();
    const updates = pub.lifecycleUpdates(snap);

    expect(index.byId).toHaveBeenCalledWith(snap.sessionId);
    expect(updates).toHaveLength(4);
    expect(updates.map((u) => u.type)).toEqual(["thread-shell", "thread-detail", "catalog", "project"]);
    expect(updates[3]).toMatchObject({ type: "project", sessionId: snap.sessionId });
  });

  it("publishes initial session updates via emitUpdate", () => {
    const { pub, emitUpdate } = makePublication();
    const snap = makeSnapshot();

    pub.publishInitialSessionUpdates(snap);
    expect(emitUpdate).toHaveBeenCalledTimes(3);
    expect(emitUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ type: "project", sessionId: snap.sessionId }));
  });

  it("scans a local runtime's model catalog once per resource key", async () => {
    const { thread, models, release } = localThread("sess-1");
    release();
    let key = "first";
    const { pub, view } = makePublication({ modelsKey: () => key });
    view.active.mockReturnValue(thread);

    await pub.ensureModels();
    await pub.ensureModels();
    expect(models).toHaveBeenCalledTimes(1);
    key = "second";
    await pub.ensureModels();
    expect(models).toHaveBeenCalledTimes(2);
    pub.invalidateModels();
    await pub.ensureModels();
    expect(models).toHaveBeenCalledTimes(3);
  });

  it("asks a runtime it does not build for its models on every read", async () => {
    const models = vi.fn(async () => []);
    const { pub, view } = makePublication();
    view.active.mockReturnValue({ threadId: "sess-1", backend: { models } } as unknown as ThreadRuntime);

    await pub.ensureModels();
    await pub.ensureModels();
    expect(models).toHaveBeenCalledTimes(2);
  });

  it("answers an empty result when a newer activation took the screen", async () => {
    let current = true;
    const { pub } = makePublication({ isCurrentActivation: () => current });
    expect((await pub.activeUpdates(1)).updates).toHaveLength(4);
    current = false;
    expect((await pub.activeUpdates(1)).updates).toEqual([]);
  });

  it("publishes a new thread's first detail before its catalog read, then the full updates with the request id", async () => {
    const { thread, release } = localThread("new-thread");
    const { pub, view, emitUpdate } = makePublication();
    view.active.mockReturnValue(thread);

    const publishing = pub.publishNewSessionUpdates(1, "new-thread-request" as never, "new-thread");
    expect(emitUpdate.mock.calls.map(([update]) => update.type)).toEqual(["thread-shell", "thread-detail", "project"]);
    expect(emitUpdate.mock.calls[1]![0].detail).toMatchObject({ sessionId: "new-thread", requestId: "new-thread-request" });

    release();
    await publishing;
    const later = emitUpdate.mock.calls.slice(3).map(([update]) => update);
    expect(later.map((update) => update.type)).toEqual(["thread-shell", "thread-detail", "catalog", "project"]);
    expect(later[1].detail).toMatchObject({ requestId: "new-thread-request" });
  });

  it("publishes nothing for a new thread a newer activation replaced", async () => {
    const { pub, emitUpdate } = makePublication({ isCurrentActivation: () => false });
    await pub.publishNewSessionUpdates(1, undefined, "new-thread");
    expect(emitUpdate).not.toHaveBeenCalled();
  });

  it("keeps the open workspace's label for the bootstrap and ignores another's", async () => {
    const { pub, emitUpdate, index } = makePublication();
    pub.publishLabel("/elsewhere", "other");
    expect(emitUpdate).not.toHaveBeenCalled();
    pub.publishLabel("/test/dir", "main");
    expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({ type: "project", project: { cwd: "/test/dir", label: "main" } }));
    expect(index.publishLabel).toHaveBeenCalledTimes(2);

    expect((await pub.bootstrap()).project).toMatchObject({ cwd: "/test/dir", label: "main" });
  });

  it("hands a client that connects mid-run the running threads and when each run began", async () => {
    const { pub } = makePublication({ runs: () => ({ "thread-a": 1_000 }) });
    expect((await pub.bootstrap()).threadIndex).toEqual({ projects: [], sessions: [], runs: { "thread-a": 1_000 } });
  });
});
