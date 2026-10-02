// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UiSession, UiToolRun } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import { agentsExtension } from "./desktop.js";
import { createAgentsStore, createDefinitionsStore, definitionsStore, lineageOf, remoteAgentThreads } from "./store.js";
import { agentsPanelModel, definitionRows, doneLabel, formatCost, formatElapsed, machineTitle, questionLine, rowStand, shortModel, spawnCardModel, spawnedThreadId, viewRows, worktreeLine } from "./model.js";
import { machineChoiceText } from "./settings.js";
import { panelRows, viewCounts } from "./panel.js";
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
    // The finished agent sits under its "Done" line, inside its parent's group.
    expect(panelRows(model).map((row) => row.kind)).toEqual(["group", "agent", "section", "agent", "group", "agent"]);
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

  it("says where a row stands at the end of its mono line", () => {
    expect(rowStand({ id: "a", title: "A", status: "running", lastTool: "edit src/a.ts" })).toBe("edit src/a.ts");
    expect(rowStand({ id: "a", title: "A", status: "running" })).toBe("working");
    expect(rowStand({ id: "a", title: "A", status: "pending" })).toBe("queued");
    expect(rowStand({ id: "a", title: "A", status: "failed", error: "boom" })).toBe("boom");
    expect(rowStand({ id: "a", title: "A", status: "completed", result: "first\nsecond" })).toBe("first");
    expect(rowStand({ id: "a", title: "A", status: "completed" })).toBe("done");
    expect(shortModel("openai/gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(shortModel(undefined)).toBeUndefined();
  });

  it("says what a held agent asks, as design 1c words it, and an approval in its own words", () => {
    expect(questionLine({ pendingToolPrompt: "[Index] Paginate by id?\n\n1. Yes" })).toBe("Asks: Paginate by id?");
    expect(questionLine({ pendingToolPrompt: "Wants to edit" })).toBe("Wants to edit");
    expect(questionLine({})).toBe("Question");
    expect(rowStand({ id: "a", title: "A", status: "waiting" })).toBe("Question");
  });

  it("keeps elapsed time the rail's m:ss clock", () => {
    expect(formatElapsed(4_400)).toBe("0:04");
    expect(formatElapsed(184_000)).toBe("3:04");
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
  });

  it("puts questions first, then work, and the finished agents under it by turn", () => {
    const agents: AgentsState = {
      maxRunning: 8,
      links: [
        link("done-1", "parent", "completed", 1, { turn: 1 }),
        link("queued", "parent", "pending", 2, { turn: 2 }),
        link("run", "parent", "running", 3, { turn: 2 }),
        link("ask", "parent", "waiting", 4, { turn: 2, pendingToolPrompt: "Index or id?" }),
        link("done-2", "parent", "failed", 5, { turn: 2 }),
        link("done-3", "parent", "completed", 6, { turn: 1 }),
        link("old", "parent", "completed", 7),
      ],
    };
    const model = agentsPanelModel(agents, "parent", []);
    expect(viewCounts(model)).toEqual({ running: 2, asks: 1, done: 4 });
    const rows = model.groups[0]!.rows;
    const running = viewRows(rows, "running");
    expect(running.open.map((row) => row.id)).toEqual(["ask", "run", "queued"]);
    expect(running.done.map((section) => [doneLabel(section), section.rows.map((row) => row.id)])).toEqual([
      ["Done · 1 — from turn 2", ["done-2"]],
      ["Done · 2 — from turn 1", ["done-1", "done-3"]],
      ["Done · 1", ["old"]],
    ]);
    expect(viewRows(rows, "asks")).toEqual({ open: [expect.objectContaining({ id: "ask" })], done: [] });
    expect(viewRows(rows, "done").open).toEqual([]);
    expect(panelRows(model, "done").map((row) => row.kind)).toEqual(["section", "agent", "section", "agent", "agent", "section", "agent"]);
    expect(panelRows(model, "asks").map((row) => row.key)).toEqual(["ask"]);
    // Sorted by start, the open ones keep the order they were spawned in.
    expect(panelRows(model, "running", "started").filter((row) => row.kind === "agent").slice(0, 3).map((row) => row.key)).toEqual(["queued", "run", "ask"]);
  });

  it("shows four finished agents per turn under the running ones, the rest one click away", () => {
    const agents: AgentsState = {
      maxRunning: 8,
      links: Array.from({ length: 12 }, (_, index) => link(`done-${index}`, "parent", "completed", index, { turn: 1 })),
    };
    const model = agentsPanelModel(agents, "parent", []);
    const running = panelRows(model, "running");
    expect(running.map((row) => row.kind)).toEqual(["section", "agent", "agent", "agent", "agent", "more"]);
    expect(running.at(-1)).toMatchObject({ kind: "more", count: 8 });
    expect(panelRows(model, "done").filter((row) => row.kind === "agent")).toHaveLength(12);
  });
});


describe("agents on another machine", () => {
  const remote = link("h1", "parent", "running", 1, {
    threadId: undefined,
    machine: { id: "rex-id", name: "rex", link: "l1", thread: "rex-t1", costUsd: 0.5, reason: "rex has room" },
  });

  it("gives the row the machine, its cost there and a line for an unreachable machine", () => {
    const row = agentsPanelModel({ maxRunning: 8, links: [remote] }, "parent", [session("parent", "P", 1)]).groups[0]!.rows[0]!;
    expect(row).toMatchObject({ machine: { id: "rex-id", name: "rex", thread: "rex-t1", reason: "rex has room" }, costUsd: 0.5 });
    expect(machineTitle(row.machine!)).toBe("Runs on rex. rex has room");
    expect(rowStand({ ...row, machine: { ...row.machine!, offline: true } })).toBe("rex offline · may still be running");
    expect(machineTitle({ ...row.machine!, offline: true, reason: undefined })).toBe("rex is offline; the thread may still be running there.");
    expect(worktreeLine({ ...row, workspace: { mode: "worktree", path: "/x", branch: "tau/rex/word", changes: { files: 2, added: 0, removed: 0, commits: 1, uncommitted: 0 } } })).toBe("2 files · tau/rex/word");
  });

  it("names the machine on the spawn card and opens nothing here", () => {
    const tool = { id: "call-1", name: "tau_spawn_thread", args: { prompt: "x", machine: "rex" }, status: "done", output: JSON.stringify({ threadId: "h1" }), startedAt: 0, endedAt: 1 } as unknown as UiToolRun;
    const card = spawnCardModel([tool], { maxRunning: 8, links: [remote] }, []);
    expect(card.rows[0]).toMatchObject({ id: "h1", machine: "rex", costUsd: 0.5 });
    expect(card.rows[0]!.threadId).toBeUndefined();
  });

  it("tells the Machines rail which threads there are this host's agents", () => {
    const store = createAgentsStore();
    const service = remoteAgentThreads(store);
    const seen = vi.fn();
    service.subscribe(seen);
    expect(service.threadsOn("rex-id").size).toBe(0);
    store.set({ maxRunning: 8, links: [remote, link("local", "parent", "running", 2)] });
    expect([...service.threadsOn("rex-id")]).toEqual(["rex-t1"]);
    expect(service.threadsOn("other").size).toBe(0);
    expect(seen).toHaveBeenCalled();
  });

  it("says in Settings → Agents where sub-agents go and how many run there", () => {
    const rex = { id: "rex-id", name: "rex", status: "connected" as const, budget: 2 };
    expect(machineChoiceText("local", [rex])).toMatch(/this computer/u);
    expect(machineChoiceText("rex-id", [rex])).toBe("Sub-agents run on rex, 2 at a time (its cores); the rest wait. Their work comes back here as a branch.");
    expect(machineChoiceText("rex-id", [{ ...rex, status: "offline" }])).toMatch(/rex is offline now/u);
    expect(machineChoiceText("gone-id", [rex])).toMatch(/no longer reach/u);
    expect(machineChoiceText("auto", [rex])).toMatch(/Tau picks/u);
  });

  it("adds Settings → Agents", () => {
    const { registry } = createKitHarness();
    registry.activate(agentsExtension);
    expect(registry.getSettingsPages().map((page) => page.id)).toContain("agents.settings");
  });

  it("offers the machines in a menu on Settings → Agents, and draws each row the search lists", async () => {
    const invoke = vi.fn(async (_id: string, command: string) => command === "machines"
      ? { available: true, machines: [{ id: "rex-id", name: "rex", status: "connected" }, { id: "ro-id", name: "watcher", status: "connected", readOnly: true }] }
      : undefined);
    const { registry, preferences } = createKitHarness(invoke);
    registry.activate(agentsExtension);
    const page = registry.getSettingsPages().find((entry) => entry.id === "agents.settings")!;
    render(<TestProviders preferences={preferences}><page.Component onNotify={vi.fn()} /></TestProviders>);
    const menu = screen.getByRole("combobox", { name: "Run sub-agents on" });
    await waitFor(() => expect(within(menu).getAllByRole("option").map((option) => option.textContent)).toEqual(["This computer", "rex", "Automatic"]));
    for (const row of page.rows ?? []) expect(document.getElementById(row.id), row.id).toBeTruthy();
    cleanup();
  });

  it("says when the machines did not load, and asks again", async () => {
    let fail = true;
    const invoke = vi.fn(async (_id: string, command: string) => {
      if (command !== "machines") return undefined;
      if (fail) throw new Error("The host is gone.");
      return { available: true, machines: [] };
    });
    const { registry, preferences } = createKitHarness(invoke);
    registry.activate(agentsExtension);
    const page = registry.getSettingsPages().find((entry) => entry.id === "agents.settings")!;
    render(<TestProviders preferences={preferences}><page.Component onNotify={vi.fn()} /></TestProviders>);
    expect((await screen.findByRole("alert")).textContent).toContain("The host is gone.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/pair a machine in Settings → Machines/u)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();
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
    expect(model.summary).toBe("Started 2 agents · 1 running");
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
    expect(model.summary).toBe("Started 1 agent · all done");
  });

  it("reads a failed call as a failed agent", () => {
    const model = spawnCardModel([spawn("call-1", { status: "error" })], undefined, []);
    expect(model.summary).toBe("Started 1 agent · 1 failed");
    expect(model.status).toBe("failed");
  });

  it("reads a call still in flight as an agent that has not started", () => {
    const model = spawnCardModel([spawn("call-1", { status: "running", endedAt: undefined })], undefined, []);
    expect(model.summary).toBe("Started 1 agent · 1 queued");
  });

  it("counts a batch as the design says it: running, questions, then what is done", () => {
    const tools = ["a", "b", "c", "d"].map((id) => spawn(`call-${id}`, { output: JSON.stringify({ threadId: id }) }));
    const batch: AgentsState = {
      maxRunning: 8,
      links: [link("a", "p", "running", 1), link("b", "p", "running", 1), link("c", "p", "waiting", 1), link("d", "p", "completed", 1)],
    };
    const model = spawnCardModel(tools, batch, []);
    expect(model.headline).toBe("Started 4 agents");
    expect(model.parts.map((part) => part.kind)).toEqual(["running", "question"]);
    expect(model.summary).toBe("Started 4 agents · 2 running · 1 question");
    const settled = spawnCardModel(tools, { maxRunning: 8, links: batch.links.map((entry) => ({ ...entry, status: entry.id === "a" ? "failed" as const : "completed" as const })) }, []);
    expect(settled.summary).toBe("Started 4 agents · 1 failed · 3 done");
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
