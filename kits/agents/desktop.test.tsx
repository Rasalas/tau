// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { UiSession, UiToolRun } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { agentsExtension } from "./desktop.js";
import { createAgentsStore, createDefinitionsStore, definitionsStore, lineageOf } from "./store.js";
import { activityLine, agentsPanelModel, definitionRows, formatCost, formatElapsed, spawnCardModel, spawnedThreadId } from "./model.js";
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

  it("lists the threads started from the same prompt on other models, without the one on screen", () => {
    const model = agentsPanelModel(undefined, "alpha", threads, { ids: ["alpha", "beta"], running: ["beta"] });
    expect(model.groups).toEqual([expect.objectContaining({ parentThreadId: "siblings", parentTitle: "Same prompt, other models" })]);
    expect(model.groups[0]!.rows.map((row) => [row.threadId, row.status])).toEqual([["beta", "running"]]);
    expect(agentsPanelModel(undefined, "alpha", threads, { ids: [], running: [] }).groups).toEqual([]);
  });

  it("groups the active thread's agents and totals its cost with theirs", () => {
    const model = agentsPanelModel(state, "parent", threads);
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]).toMatchObject({ parentThreadId: "parent", active: true });
    expect(model.groups[0]!.rows.map((row) => [row.title, row.status, row.costUsd]))
      .toEqual([["Alpha reply", "running", 0.25], ["Beta reply", "completed", 0.25]]);
    expect(model).toMatchObject({ running: 1, completed: 1, waiting: 0, failed: 0, pending: 0, totalCostUsd: 1 });
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


describe("the spawn card", () => {
  const spawn = (id: string, partial: Partial<UiToolRun> = {}): UiToolRun => ({
    id,
    name: "tau_spawn_thread",
    args: { prompt: `do ${id}` },
    status: "done",
    startedAt: 1,
    endedAt: 3,
    ...partial,
  });

  it("names each agent of the batch from the thread the call reported", () => {
    const model = spawnCardModel(
      [spawn("call-1", { output: '{"threadId":"alpha"}' }), spawn("call-2", { output: '{"threadId":"beta"}' })],
      state,
      [session("alpha", "Index the code", 1, 0.25), session("beta", "Write the docs", 2, 0.5)],
    );
    expect(model.headline).toBe("Started 2 agents · 1 working");
    expect(model.status).toBe("running");
    expect(model.totalCostUsd).toBe(0.75);
    expect(model.rows.map((row) => [row.title, row.status, row.threadId])).toEqual([
      ["Index the code", "running", "alpha"],
      ["Write the docs", "completed", "beta"],
    ]);
  });

  it("falls back to the links spawned in the call's own window", () => {
    const model = spawnCardModel([spawn("call-1"), spawn("call-2")], state, []);
    expect(model.rows.map((row) => row.threadId)).toEqual(["alpha", "beta"]);
  });

  it("finds the links of a spawn another runtime made over MCP", () => {
    const model = spawnCardModel([spawn("call-1", { name: "mcp__tau__tau_spawn_thread" })], state, []);
    expect(model.rows.map((row) => row.threadId)).toEqual(["alpha"]);
  });

  it("still names an agent from the prompt when nothing else knows it", () => {
    const model = spawnCardModel([spawn("call-1", { args: { prompt: "Read the code\nand report" } })], undefined, []);
    expect(model.rows[0]).toMatchObject({ title: "Read the code", status: "completed" });
    expect(model.rows[0].threadId).toBeUndefined();
    expect(model.headline).toBe("Started 1 agent · all done");
  });

  it("reads a failed call as a failed agent", () => {
    const model = spawnCardModel([spawn("call-1", { status: "error" })], undefined, []);
    expect(model.headline).toBe("Started 1 agent · 1 failed");
    expect(model.status).toBe("failed");
  });

  it("reads a call still in flight as an agent that has not started", () => {
    const model = spawnCardModel([spawn("call-1", { status: "running", endedAt: undefined })], undefined, []);
    expect(model.headline).toBe("Started 1 agent · 1 queued");
  });

  it("reads the thread out of a result that is not JSON without throwing", () => {
    expect(spawnedThreadId(spawn("call-1", { output: "not json" }))).toBeUndefined();
    expect(spawnedThreadId(spawn("call-1", { output: '{"id":"gamma"}' }))).toBe("gamma");
  });
});

describe("agent definitions in the desktop half", () => {
  const reviewer = { name: "reviewer", description: "Reviews", file: "/project/.tau/agents/reviewer.md", model: "openai/gpt-5.6-luna", access: "read-only" as const, tools: ["read"] };

  it("counts what each definition already runs for the thread on screen", () => {
    const agents: AgentsState = {
      maxRunning: 8,
      links: [
        link("a", "parent", "running", 1, { agent: "reviewer" }),
        link("b", "parent", "completed", 2, { agent: "reviewer" }),
        link("c", "other", "running", 3, { agent: "reviewer" }),
      ],
    };
    expect(definitionRows([reviewer], agents, "parent")).toEqual([
      { definition: reviewer, open: 1, settings: "openai/gpt-5.6-luna · read-only · 1 tool" },
    ]);
  });

  it("names the definition on the spawn card and in the panel row", () => {
    const card = spawnCardModel([{ id: "call-1", name: "tau_spawn_thread", args: { prompt: "look", agent: "reviewer" }, status: "running", startedAt: 1 }], undefined, []);
    expect(card.rows[0]).toMatchObject({ agent: "reviewer", title: "look" });
    const withLink = spawnCardModel(
      [{ id: "call-1", name: "tau_spawn_thread", args: { prompt: "look" }, status: "done", startedAt: 1, endedAt: 2, output: '{"threadId":"a"}' }],
      { maxRunning: 8, links: [link("a", "parent", "running", 1, { agent: "reviewer" })] },
      [],
    );
    expect(withLink.rows[0]!.agent).toBe("reviewer");
    const panel = agentsPanelModel({ maxRunning: 8, links: [link("a", "parent", "running", 1, { agent: "reviewer" })] }, "parent", []);
    expect(panel.groups[0]!.rows[0]!.agent).toBe("reviewer");
  });

  it("lands only the latest read of the definitions", async () => {
    const answers = new Map<string, (value: unknown) => void>();
    const store = createDefinitionsStore({
      invoke: (_command, input) => new Promise((resolve) => { answers.set((input as { sessionId?: string }).sessionId ?? "", resolve); }),
    });
    const first = store.load("one");
    const second = store.load("two");
    answers.get("two")!({ directory: "/two/.tau/agents", definitions: [reviewer], problems: [] });
    answers.get("one")!({ directory: "/one/.tau/agents", definitions: [], problems: [] });
    await Promise.all([first, second]);
    expect(store.getSnapshot()).toEqual({ sessionId: "two", state: { directory: "/two/.tau/agents", definitions: [reviewer], problems: [] } });
    // A refresh reads again for the thread last asked about.
    const again = store.refresh();
    expect([...answers.keys()]).toEqual(["one", "two"]);
    answers.get("two")!({ directory: "/two/.tau/agents", definitions: [], problems: [] });
    await again;
    expect(store.getSnapshot().state?.definitions).toEqual([]);
  });

  it("lists the files that could not be used in the Inspector and clears them with the kit", async () => {
    const { registry } = createKitHarness(async (_extensionId, command) => command === "definitions"
      ? { directory: "/project/.tau/agents", definitions: [], problems: [{ file: "/project/.tau/agents/bad.md", message: '"description" is required.', level: "error" }] }
      : undefined);
    registry.activate(agentsExtension);
    await vi.waitFor(() => expect(registry.getProblems()).toEqual([
      expect.objectContaining({ source: "/project/.tau/agents/bad.md", message: '"description" is required.', level: "error" }),
    ]));
    registry.deactivate(agentsExtension.id);
    expect(registry.getProblems()).toEqual([]);
    expect(definitionsStore.getSnapshot()).toEqual({});
  });
});
