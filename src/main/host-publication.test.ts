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
});
