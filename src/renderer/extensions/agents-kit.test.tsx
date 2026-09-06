// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiMessage, UiSession } from "../../shared/contracts";
import {
  AGENTS_HOST_EXTENSION_ID,
  type AgentThreadLink,
  type AgentThreadStatus,
  type AgentsState,
} from "../../shared/agents-kit-protocol";
import { setHostClient } from "../host-client-context";
import { setClientStorage } from "../client-storage";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { renderApp } from "../test-support/render-app";
import { workspaceHostStub } from "../test-support/workspace-host-stub";
import { createAgentsStore, lineageOf } from "./agents-store";
import { activityLine, agentsPanelModel, formatCost, formatElapsed } from "./agents-model";
import { panelRows } from "./agents-panel";
import { visibleThreads } from "./project-navigation";

/**
 * jsdom gives a scroll rail no height, so the real virtualizer would render no
 * row at all. A fixed window of eight instead proves the panel hands the whole
 * list to the virtualizer and mounts only what it gets back.
 */
const VIRTUAL_WINDOW = 8;
vi.mock("@tanstack/react-virtual", () => ({
  defaultRangeExtractor: (range: { startIndex: number; endIndex: number }) =>
    Array.from({ length: range.endIndex - range.startIndex + 1 }, (_, offset) => range.startIndex + offset),
  useVirtualizer: ({ count, getItemKey, estimateSize }: {
    count: number;
    getItemKey?: (index: number) => string | number;
    estimateSize?: (index: number) => number;
  }) => ({
    getTotalSize: () => count * 58,
    getVirtualItems: () => Array.from({ length: Math.min(count, VIRTUAL_WINDOW) }, (_, index) => ({
      index,
      key: getItemKey?.(index) ?? index,
      start: index * 58,
      size: estimateSize?.(index) ?? 58,
    })),
    measureElement: () => undefined,
    scrollToIndex: () => undefined,
    scrollToOffset: () => undefined,
  }),
}));

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

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

function appWith(agents: AgentsState, sessions: UiSession[], activeThreadId: string, messages: UiMessage[] = []) {
  return createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 3 }], sessions },
      detail: { sessionId: activeThreadId, messages, isStreaming: false, activeTools: [] },
      catalog: { sessionId: activeThreadId, models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
      project: { cwd: "/project" },
    }),
    invokeHostExtension: workspaceHostStub({}, {
      [AGENTS_HOST_EXTENSION_ID]: async (command) => command === "state" ? agents : undefined,
    }),
  });
}

describe("the Agents panel", () => {
  it("lists sixty agents without mounting sixty rows", async () => {
    const many: AgentsState = {
      maxRunning: 8,
      links: Array.from({ length: 60 }, (_, index) =>
        link(`agent-${index}`, "parent", index < 8 ? "running" : "pending", index, { startedAt: Date.now() - 5_000 })),
    };
    const sessions = [session("parent", "Parent thread", 100), ...many.links.map((entry, index) => session(entry.id, `Agent ${index}`, 60 - index))];
    renderApp(appWith(many, sessions, "parent"));

    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    const heading = await screen.findByRole("heading", { name: "Agents" });
    const panel = heading.closest(".agents-panel") as HTMLElement;
    await waitFor(() => expect(panel.querySelectorAll(".agent-row").length).toBeGreaterThan(0));

    expect(panel.querySelectorAll(".agent-row")).toHaveLength(VIRTUAL_WINDOW);
    expect(panel.textContent).toContain("8 running");
    expect(panel.textContent).toContain("52 pending");
    expect(panel.querySelector(".agent-total-cost")!.textContent).toBe("–");
  });

  it("switches to the agent's thread when its row is clicked", async () => {
    const switchSession = vi.fn(async () => ({ version: 1 as const, updates: [] }));
    const client = appWith(state, [session("parent", "Parent thread", 3), session("alpha", "Alpha reply", 2), session("beta", "Beta reply", 1)], "parent");
    client.switchSession = switchSession;
    renderApp(client);

    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Alpha reply, running" }));
    await waitFor(() => expect(switchSession).toHaveBeenCalledWith("/sessions/alpha.jsonl"));
  });
});

describe("the navigator with agent threads", () => {
  it("hides spawned threads until a search or the toggle asks for them", () => {
    const threads = [session("parent", "Parent", 3), session("alpha", "Alpha", 2), session("beta", "Beta", 1)];
    const parents = { alpha: "parent", beta: "parent" };
    expect(visibleThreads(threads, parents, { showAgents: false, searching: false }).map((entry) => entry.id)).toEqual(["parent"]);
    expect(visibleThreads(threads, parents, { showAgents: true, searching: false }).map((entry) => entry.id)).toEqual(["parent", "alpha", "beta"]);
    expect(visibleThreads(threads, parents, { showAgents: false, searching: true }).map((entry) => entry.id)).toEqual(["parent", "alpha", "beta"]);
    // The thread on screen is never hidden, however it was created.
    expect(visibleThreads(threads, parents, { showAgents: false, searching: false, activeThreadId: "beta" }).map((entry) => entry.id))
      .toEqual(["parent", "beta"]);
  });

  it("hides a spawned thread the index named even when no extension published lineage", () => {
    const threads = [
      session("parent", "Parent", 3),
      session("alpha", "Alpha", 2, undefined, "parent"),
      session("beta", "Beta", 1, undefined, "parent"),
    ];
    expect(visibleThreads(threads, {}, { showAgents: false, searching: false }).map((entry) => entry.id)).toEqual(["parent"]);
    expect(visibleThreads(threads, {}, { showAgents: true, searching: false }).map((entry) => entry.id)).toEqual(["parent", "alpha", "beta"]);
    expect(visibleThreads(threads, {}, { showAgents: false, searching: false, activeThreadId: "alpha" }).map((entry) => entry.id))
      .toEqual(["parent", "alpha"]);
  });

  it("offers the way back from a child the index alone knows", async () => {
    const sessions = [session("parent", "Parent thread", 3), session("alpha", "Alpha reply", 2, undefined, "parent")];
    renderApp(appWith({ maxRunning: 8, links: [] }, sessions, "alpha", [
      { id: "m1", role: "user", text: "Reply with A", timestamp: 1 },
    ]));
    expect(await screen.findByText(/spawned by Parent thread/)).toBeTruthy();
  });

  it("keeps agents out of the rail, badges the parent, and reveals them on request", async () => {
    const sessions = [session("parent", "Parent thread", 3), session("alpha", "Alpha reply", 2), session("beta", "Beta reply", 1)];
    renderApp(appWith(state, sessions, "parent"));
    await screen.findByRole("navigation", { name: "Threads" });

    await waitFor(() => expect(screen.getByLabelText("1 agent running")).toBeTruthy());
    expect(screen.queryByText("Alpha reply")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show agent threads" }));
    expect(await screen.findByText("Alpha reply")).toBeTruthy();
  });
});
