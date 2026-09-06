// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { UiSession } from "tau";
import { createAgentsStore, lineageOf } from "./store.js";
import { activityLine, agentsPanelModel, formatCost, formatElapsed } from "./model.js";
import { panelRows } from "./panel.js";
import type { AgentThreadLink, AgentThreadStatus, AgentsState } from "./protocol.js";

function session(id: string, title: string, modifiedAt: number, costUsd?: number, parentThreadId?: string): UiSession {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    title,
    modifiedAt,
    projectPath: "/project",
    projectName: "project",
    messageCount: 1,
    ...(parentThreadId ? { parentThreadId } : {}),
    ...(costUsd === undefined ? {} : {
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, costUsd, turns: 1 },
    }),
  };
}

function link(id: string, parentThreadId: string, status: AgentThreadStatus, spawnedAt: number, extra: Partial<AgentThreadLink> = {}): AgentThreadLink {
  return {
    id,
    threadId: id,
    parentThreadId,
    spawnedBy: "tau_spawn_thread",
    spawnedAt,
    projectPath: "/project",
    depth: 1,
    title: id.toUpperCase(),
    status,
    ...extra,
  };
}

const state: AgentsState = {
  maxRunning: 8,
  links: [
    link("alpha", "parent", "running", 1, { startedAt: 1_000, lastTool: "bash" }),
    link("beta", "parent", "completed", 2, { result: "BETA" }),
  ],
};

describe("Agents Kit lineage", () => {
  it("names each agent's parent and counts the ones still working", () => {
    expect(lineageOf(state)).toEqual({ parents: { alpha: "parent", beta: "parent" }, workingChildren: { parent: 1 } });
    expect(lineageOf({ maxRunning: 8, links: [link("a", "p", "waiting", 1)] }).workingChildren).toEqual({ p: 1 });
    expect(lineageOf({ maxRunning: 8, links: [link("a", "p", "pending", 1)] }).workingChildren).toEqual({});
    expect(lineageOf(undefined)).toEqual({ parents: {}, workingChildren: {} });
  });

  it("keeps only what the host pushed", () => {
    const store = createAgentsStore();
    const seen = vi.fn();
    store.subscribe(seen);
    store.set({ not: "a state" });
    expect(store.getSnapshot()).toBeUndefined();
    store.set(state);
    expect(store.getSnapshot()).toBe(state);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe("the Agents panel model", () => {
  const threads = [session("parent", "Parent thread", 3, 0.5), session("alpha", "Alpha reply", 2, 0.25), session("beta", "Beta reply", 1, 0.25)];

  it("groups the active thread's agents and totals its cost with theirs", () => {
    const model = agentsPanelModel(state, "parent", threads);
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]).toMatchObject({ parentThreadId: "parent", active: true });
    expect(model.groups[0]!.rows.map((row) => [row.title, row.status, row.costUsd]))
      .toEqual([["Alpha reply", "running", 0.25], ["Beta reply", "completed", 0.25]]);
    expect(model).toMatchObject({ running: 1, completed: 1, waiting: 0, failed: 0, pending: 0, totalCostUsd: 1, runningElsewhere: 0 });
    expect(formatCost(model.totalCostUsd)).toBe("$1.00");
    expect(formatCost(undefined)).toBe("–");
  });

  it("leaves the total unknown when nothing has counted a cost", () => {
    const model = agentsPanelModel(state, "parent", [session("parent", "Parent thread", 3), session("alpha", "Alpha reply", 2)]);
    expect(model.totalCostUsd).toBeUndefined();
    expect(model.groups[0]!.rows[0]!.costUsd).toBeUndefined();
  });

  it("shows an agent its siblings and the thread that spawned it", () => {
    const model = agentsPanelModel(state, "alpha", threads);
    expect(model.groups.map((group) => group.parentThreadId)).toEqual(["parent"]);
    expect(model.groups[0]!.rows.map((row) => row.id)).toEqual(["alpha", "beta"]);
  });

  it("offers a jump when the thread on screen has no agents of its own", () => {
    const model = agentsPanelModel(state, "unrelated", [...threads, session("unrelated", "Something else", 4)]);
    expect(model.groups).toEqual([]);
    expect(model.runningElsewhere).toBe(1);
    expect(model.jumpTo).toEqual({ threadId: "parent", path: "/sessions/parent.jsonl", title: "Parent thread" });
  });

  it("groups by parent once depth 2 is in play", () => {
    const deep: AgentsState = {
      maxRunning: 8,
      links: [...state.links, { ...link("gamma", "alpha", "running", 3), depth: 2 }],
    };
    const model = agentsPanelModel(deep, "parent", [...threads, session("gamma", "Gamma", 0)]);
    expect(model.groups.map((group) => [group.parentThreadId, group.active])).toEqual([["parent", true], ["alpha", false]]);
    expect(panelRows(model).map((row) => row.kind)).toEqual(["group", "agent", "agent", "group", "agent"]);
  });

  it("lists the children the thread index names when the kit has no links at all", () => {
    const indexed = [
      session("parent", "Parent thread", 3, 0.5),
      session("alpha", "Alpha reply", 2, 0.25, "parent"),
      session("beta", "Beta reply", 1, 0.25, "parent"),
    ];
    const model = agentsPanelModel(undefined, "parent", indexed);
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]!.rows.map((row) => [row.threadId, row.title, row.path]))
      .toEqual([["beta", "Beta reply", "/sessions/beta.jsonl"], ["alpha", "Alpha reply", "/sessions/alpha.jsonl"]]);
    expect(model.totalCostUsd).toBe(1);
    // Reading one of them still shows the family it belongs to.
    expect(agentsPanelModel(undefined, "alpha", indexed).groups.map((group) => group.parentThreadId)).toEqual(["parent"]);
  });

  it("prefers the live link over the index row for the same thread", () => {
    const indexed = [
      session("parent", "Parent thread", 3),
      session("alpha", "Alpha reply", 2, undefined, "parent"),
      session("beta", "Beta reply", 1, undefined, "parent"),
    ];
    const model = agentsPanelModel({ maxRunning: 8, links: [link("alpha", "parent", "running", 1)] }, "parent", indexed);
    expect(model.groups[0]!.rows.map((row) => [row.threadId, row.status])).toEqual([["alpha", "running"], ["beta", "idle"]]);
  });

  it("says what a row is doing in one line", () => {
    expect(activityLine({ id: "a", title: "A", status: "running", lastTool: "bash" })).toBe("▸ bash");
    expect(activityLine({ id: "a", title: "A", status: "pending" })).toBe("Queued for a free slot");
    expect(activityLine({ id: "a", title: "A", status: "waiting", pendingToolPrompt: "Run rm?" })).toBe("Needs you: Run rm?");
    expect(activityLine({ id: "a", title: "A", status: "failed", error: "boom" })).toBe("boom");
    expect(activityLine({ id: "a", title: "A", status: "completed", result: "done" })).toBe("done");
  });

  it("keeps elapsed time the same shape at every scale", () => {
    expect(formatElapsed(4_400)).toBe("4s");
    expect(formatElapsed(184_000)).toBe("3m 04s");
    expect(formatElapsed(3_720_000)).toBe("1h 02m");
  });
});

