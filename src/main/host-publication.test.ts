import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { HostPublication } from "./host-publication.js";
import type { HostSnapshot } from "../shared/contracts.js";
import type { HostPublicationDeps } from "./host-publication.js";
import { ThreadProjection } from "./thread-projection.js";
import { ClientTurnLedger } from "./client-turn-ledger.js";
import { ThreadRuntime } from "./thread-runtime.js";

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
        transcriptPage: async () => ({ sessionId: "sess-1", messages: [], hasMore: false }),
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

  it.each([40, 4_000])("bounds warm active history projection for %i Pi turns", async (turns) => {
    let contentReads = 0;
    const manager = SessionManager.inMemory("/repo");
    for (let index = 0; index < turns * 2; index++) {
      manager.appendMessage({
        role: index % 2 ? "assistant" : "user", timestamp: index,
        get content() { contentReads += 1; return [{ type: "text", text: `Message ${index}` }]; },
      } as never);
    }
    const entries = vi.fn(() => manager.getBranch());
    const models = vi.fn(async () => []);
    const state = vi.fn(() => ({ streaming: false, idle: true, activeTools: [], title: "History" }));
    const completions = { models: vi.fn(() => new Promise<never>(() => {})) };
    const thread = new ThreadRuntime({
      kind: "pi", threadId: "history", providerSessionId: "history", cwd: "/repo",
      runtimeAdapter: { id: "pi", capabilities: { skillInvocationDialect: "pi" } },
      capabilities: { journal: { entries }, tree: { leafEntryId: () => manager.getLeafId() ?? undefined } },
      composerCommands: () => [], models,
      state,
      catalogView: () => ({ thinkingLevel: "off", thinkingLevels: [], allTools: [] }),
    } as never, { session: { sessionManager: manager } } as never);
    const projection = new ThreadProjection(new ClientTurnLedger(), () => undefined, new Set(), () => ({}) as never, () => {});
    const { pub, view } = makePublication({ projection, completions });
    // Exercise the endpoint the original public getThreadDetail route forwards to.
    view.active.mockReturnValue(thread);
    const initial = await pub.threadDetail();
    await pub.threadDetail(initial.olderCursor);
    contentReads = 0;
    entries.mockClear();
    state.mockClear();
    const older = await pub.threadDetail(initial.olderCursor);
    console.info(JSON.stringify({ turns, branchReads: entries.mock.calls.length, contentReads, pageMessages: older.messages.length }));
    expect(older.messages).toHaveLength(40);
    expect(entries).not.toHaveBeenCalled();
    expect(contentReads).toBe(0);
    expect(state).not.toHaveBeenCalled();
    expect(models).not.toHaveBeenCalled();
    expect(completions.models).not.toHaveBeenCalled();
  });

  it("keeps hidden thread providers out of new-thread runtime pickers", () => {
    const { pub } = makePublication({ backends: () => [
      { kind: "machine", hidden: true, adapter: { capabilities: {} } },
      { kind: "codex", label: "Codex", order: 20, adapter: { capabilities: {} } },
    ] as never });
    expect(pub.runtimeBackends().map((backend) => backend.kind)).toEqual(["pi", "codex"]);
  });

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

  it("keeps a discovered remote catalog in bootstrap while its next read is stalled", async () => {
    const known = [{ provider: "openai", id: "gpt", name: "GPT" }];
    const models = vi.fn().mockResolvedValueOnce(known).mockImplementation(() => new Promise(() => {}));
    const { pub, view } = makePublication();
    view.active.mockReturnValue({ threadId: "remote-thread", backend: { models } } as unknown as ThreadRuntime);
    await pub.ensureModels();
    expect((await pub.bootstrap()).catalog.models).toEqual(known);
  });

  it("returns the remote transcript before an undiscovered remote catalog answers", async () => {
    const models = vi.fn(() => new Promise<never>(() => {}));
    const { pub, view } = makePublication();
    view.active.mockReturnValue({ threadId: "remote-thread", backend: { models } } as unknown as ThreadRuntime);
    const bootstrap = await pub.bootstrap();
    expect(bootstrap.detail.sessionId).toBe("remote-thread");
    expect(bootstrap.catalog.models).toEqual([]);
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

  it.each(["classification", "models"])("returns first content while %s discovery is stalled", async (stalled) => {
    const { thread } = localThread("saved-thread");
    const { pub, view } = makePublication(stalled === "classification" ? {
      projects: { label: () => undefined, settleClassifications: () => new Promise(() => {}) },
    } : {});
    if (stalled === "models") view.active.mockReturnValue(thread);
    const result = await Promise.race([
      pub.bootstrap(),
      new Promise<undefined>((resolve) => setTimeout(resolve, 50)),
    ]);
    expect(result?.detail.sessionId).toBe(stalled === "models" ? "saved-thread" : "sess-1");
  });

  it("publishes the discovered models after the initial response", async () => {
    const { thread, models, release } = localThread("saved-thread");
    const { pub, view, emitUpdate } = makePublication();
    view.active.mockReturnValue(thread);
    const bootstrap = await pub.bootstrap();
    expect(bootstrap.catalog.models).toEqual([]);
    expect(emitUpdate).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
      type: "catalog", catalog: expect.objectContaining({ models: [{ provider: "openai", id: "gpt" }] }),
    })));
    expect(models).toHaveBeenCalledOnce();
    expect((await pub.bootstrap()).catalog.models).toEqual([{ provider: "openai", id: "gpt" }]);
  });
});
