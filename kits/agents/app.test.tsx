// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiMessage, UiSession, UiTurnActivityEntry } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { workspaceExtension } from "../workspace/desktop.js";
import { agentsExtension } from "./desktop.js";
import { AGENTS_HOST_EXTENSION_ID, type AgentThreadLink, type AgentThreadStatus, type AgentsState } from "./protocol.js";

/**
 * jsdom gives a scroll rail no height, so the real virtualizer would render no
 * row at all. A fixed window of eight lets these integration tests inspect the
 * sidebar and transcript rows through the same virtualizer contract.
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
    measurementsCache: [],
    scrollOffset: 0,
    scrollRect: null,
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

afterEach(cleanup);

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

function appWith(
  agents: AgentsState,
  sessions: UiSession[],
  activeThreadId: string,
  messages: UiMessage[] = [],
  onAgentsCommand?: (command: string, input?: unknown) => unknown,
  turnActivityHistory: UiTurnActivityEntry[] = [],
) {
  return createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 3 }], sessions },
      detail: { sessionId: activeThreadId, messages, isStreaming: false, activeTools: [], turnActivityHistory },
      catalog: { sessionId: activeThreadId, models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
      project: { cwd: "/project" },
    }),
    invokeHostExtension: workspaceHostStub({}, {
      [AGENTS_HOST_EXTENSION_ID]: async (command, input) => command === "state" ? agents : onAgentsCommand?.(command, input),
    }),
  });
}

describe("agents in the project card", () => {
  it("keeps running rows visible and completed rows collapsed, without an Agents stage entry", async () => {
    renderApp(appWith(state, [session("parent", "Parent thread", 3), session("alpha", "Alpha reply", 2), session("beta", "Beta reply", 1)], "parent"), { extensions: [workspaceExtension, agentsExtension] });
    const row = await screen.findByRole("button", { name: "Alpha reply, Running" });
    const section = row.closest(".agent-lineage") as HTMLElement;
    expect(within(section).queryByRole("button", { name: "Beta reply, Completed" })).toBeNull();
    fireEvent.click(within(section).getByRole("button", { name: "Completed (1)" }));
    expect(await within(section).findByRole("button", { name: "Beta reply, Completed" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "More tools" }));
    expect(screen.queryByRole("menuitem", { name: /Agents/ })).toBeNull();
  });

  it("previews an agent while keeping its parent active and out of the rail", async () => {
    const client = appWith(state, [session("parent", "Parent thread", 3), session("alpha", "Alpha reply", 2, undefined, "parent")], "parent");
    client.loadTranscript = vi.fn(async (sessionId) => ({ sessionId, hasMore: false, messages: [{ id: "reply", role: "assistant" as const, text: "Alpha finished the job.", timestamp: 1 }] }));
    renderApp(client, { extensions: [workspaceExtension, agentsExtension] });
    fireEvent.click(await screen.findByRole("button", { name: "Alpha reply, Running" }));
    await screen.findByText("Alpha finished the job.");
    expect(client.loadTranscript).toHaveBeenCalledWith("alpha");
    expect(client.calls.some((call) => call.method === "switchSession")).toBe(false);
    const rail = screen.getByRole("navigation", { name: "Threads" });
    expect(within(rail).queryByText("Alpha reply")).toBeNull();
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  });

  it("opens an agent on another machine through that machine's transcript", async () => {
    const agents: AgentsState = { maxRunning: 8, links: [link("remote", "parent", "completed", 1, {
      threadId: undefined, title: "Word on rex",
      machine: { id: "rex-id", name: "rex", link: "link-1", thread: "rex-thread" },
    })] };
    renderApp(appWith(agents, [session("parent", "Parent thread", 3)], "parent"), { extensions: [workspaceExtension, agentsExtension] });
    fireEvent.click(await screen.findByRole("button", { name: "Completed (1)" }));
    const row = await screen.findByRole("button", { name: "Word on rex, Completed" });
    expect(row.title).toContain("rex");
    fireEvent.click(row);
    expect(await screen.findByRole("region", { name: "Thread Thread on rex-id" })).toBeTruthy();
  });

  it("does not show another parent's agents", async () => {
    renderApp(appWith(state, [session("unrelated", "Unrelated thread", 4), session("parent", "Parent thread", 3), session("alpha", "Alpha reply", 2)], "unrelated"), { extensions: [workspaceExtension, agentsExtension] });
    await screen.findByText("Unrelated thread");
    await waitFor(() => expect(document.querySelector('.thread-row')?.textContent).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Alpha reply, Running" })).toBeNull();
  });
  it("brings an agent's question to its parent's composer, named after the agent, and marks the parent waiting", async () => {
    const agents: AgentsState = { maxRunning: 8, links: [link("orders", "parent", "waiting", 1, { pendingToolPrompt: "Index or id?" })] };
    const sessions = [session("parent", "Parent thread", 9), session("orders", "GET /orders", 3, undefined, "parent"), session("other", "Other thread", 1)];
    const client = appWith(agents, sessions, "parent");
    renderApp(client, { extensions: [workspaceExtension, agentsExtension] });
    await screen.findAllByText("Parent thread");

    act(() => client.emit({ type: "extension-ui-prompt", sessionId: "orders", prompt: { id: "q1", sessionId: "orders", kind: "select", title: "Index or id?", options: ["Add an index", "Paginate by id"] } }));
    const card = await screen.findByRole("region", { name: "Question from GET /orders agent" });
    await waitFor(() => expect(document.querySelector('.thread-status-age.status-waiting')?.closest('.thread-row')?.textContent).toContain("Parent thread"));
    fireEvent.click(within(card).getByRole("button", { name: "Paginate by id" }));
    fireEvent.click(within(card).getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(client.calls.find((call) => call.method === "answerExtensionUi")?.args).toEqual(["q1", { value: "Paginate by id" }]));

    // Another thread's question stays on its own thread.
    act(() => client.emit({ type: "extension-ui-prompt", sessionId: "other", prompt: { id: "q2", sessionId: "other", kind: "confirm", title: "Wants to run" } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("region", { name: "Wants to run" })).toBeNull();
  });

});

describe("agent definitions in the project card", () => {
  it("lists the project's definitions and starts one from the thread on screen", async () => {
    const commands: Array<{ command: string; input?: unknown }> = [];
    const agents: AgentsState = { maxRunning: 8, links: [link("alpha", "parent", "running", 1, { agent: "reviewer" })] };
    renderApp(
      appWith(agents, [session("parent", "Parent thread", 3), session("alpha", "Alpha reply", 2)], "parent", [], (command, input) => {
        commands.push({ command, input });
        if (command === "definitions") {
          return {
            directory: "/project/.tau/agents",
            definitions: [
              { name: "reviewer", description: "Reviews the change", file: "/project/.tau/agents/reviewer.md", access: "read-only" },
              { name: "writer", description: "Writes the docs", file: "/project/.tau/agents/writer.md" },
            ],
            problems: [{ file: "/project/.tau/agents/bad.md", message: "broken", level: "error" }],
          };
        }
        return { threadId: "beta", title: "Check it", status: "running", agent: "writer" };
      }),
      { extensions: [workspaceExtension, agentsExtension] },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Agent definitions" }));
    const section = await screen.findByRole("region", { name: "Agent definitions" });
    expect(within(section).getByText("Reviews the change")).toBeTruthy();
    expect(within(section).getByText("1 open")).toBeTruthy();
    expect(within(section).getByText(/1 file in .tau\/agents could not be used/u)).toBeTruthy();

    const writer = within(section).getByText("writer").closest("li") as HTMLElement;
    fireEvent.click(within(writer).getByRole("button", { name: "Start" }));
    fireEvent.change(within(writer).getByRole("textbox", { name: "Task for writer" }), { target: { value: "Check it" } });
    fireEvent.click(within(writer).getByRole("button", { name: "Start writer" }));
    await waitFor(() => expect(commands).toContainEqual({ command: "start", input: { parentThreadId: "parent", agent: "writer", prompt: "Check it" } }));
    expect(await screen.findByText("Started writer.")).toBeTruthy();
    expect(commands.filter((entry) => entry.command === "definitions").map((entry) => entry.input)).toContainEqual({ sessionId: "parent" });
  });
});

describe("the navigator with agent threads", () => {
  it("offers the way back from a child the index alone knows", async () => {
    const sessions = [session("parent", "Parent thread", 3), session("alpha", "Alpha reply", 2, undefined, "parent")];
    renderApp(appWith({ maxRunning: 8, links: [] }, sessions, "alpha", [
      { id: "m1", role: "user", text: "Reply with A", timestamp: 1 },
    ]), { extensions: [workspaceExtension, agentsExtension] });
    expect(await screen.findByText(/Back to Parent thread/)).toBeTruthy();
  });

  it("keeps agents out of the rail and marks the parent Working instead", async () => {
    const sessions = [session("parent", "Parent thread", 3), session("alpha", "Alpha reply", 2), session("beta", "Beta reply", 1)];
    renderApp(appWith(state, sessions, "parent"), { extensions: [workspaceExtension, agentsExtension] });
    const rail = await screen.findByRole("navigation", { name: "Threads" });

    const parent = await screen.findByText("Parent thread");
    await waitFor(() => expect(parent.closest(".thread-row")?.querySelector(".thread-status-age")?.textContent).toMatch(/^Working/));
    expect(screen.queryByLabelText("1 agent running")).toBeNull();
    expect(within(rail).queryByText("Alpha reply")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show agent threads" })).toBeNull();

  });

  it("keeps an agent thread out of the rail while it is the active thread", async () => {
    const sessions = [session("parent", "Parent thread", 3), session("alpha", "Alpha reply", 2, undefined, "parent")];
    renderApp(appWith({ maxRunning: 8, links: [] }, sessions, "alpha", [
      { id: "m1", role: "user", text: "Reply with A", timestamp: 1 },
    ]), { extensions: [workspaceExtension, agentsExtension] });
    const rail = await screen.findByRole("navigation", { name: "Threads" });

    expect(await screen.findByText(/Back to Parent thread/)).toBeTruthy();
    expect(within(rail).queryByText("Alpha reply")).toBeNull();
  });

  // Pi names the tool itself; every other runtime reaches it over MCP.
  it.each(["tau_spawn_thread", "mcp__tau__tau_spawn_thread"])("draws one card for a %s batch that expands inline", async (name) => {
    const spawn = (id: string, threadId: string) => ({
      id,
      name,
      args: { prompt: `work on ${threadId}` },
      status: "done" as const,
      output: JSON.stringify({ threadId }),
      startedAt: 1,
      endedAt: 2,
    });
    const sessions = [session("parent", "Parent thread", 3), session("alpha", "Alpha reply", 2), session("beta", "Beta reply", 1)];
    const client = appWith(state, sessions, "parent", [
      { id: "user", role: "user", text: "Split the work", timestamp: 1 },
      { id: "reply", role: "assistant", text: "Two agents are on it.", timestamp: 4 },
    ], undefined, [{
      id: "turn-activity-user",
      anchorMessageId: "user",
      status: "completed",
      tools: [
        spawn("call-1", "alpha"),
        spawn("call-2", "beta"),
        { id: "read", name: "read", args: { path: "plan.md" }, status: "done" as const, startedAt: 2, endedAt: 3 },
      ],
    }]);
    client.loadTranscript = async (sessionId: string) => ({
      sessionId, hasMore: false,
      messages: [{ id: "a1", role: "assistant" as const, text: "Alpha finished the job.", timestamp: 1 }],
    });
    renderApp(client, { extensions: [workspaceExtension, agentsExtension] });

    // The card names the batch and stays out of the turn's fold.
    const card = await screen.findByRole("button", { name: "Started 2 agents · 1 running. Show agents" });
    expect(card.textContent).toBe("Started 2 agents1 running");
    expect(screen.getByRole("button", { name: /Worked for/u })).toBeTruthy();

    fireEvent.click(card);
    const batch = card.parentElement!;
    fireEvent.click(await within(batch).findByRole("button", { name: "Alpha reply, Running" }));
    expect(client.calls.some((call) => call.method === "switchSession")).toBe(false);
    expect(await screen.findByText("Alpha finished the job.")).toBeTruthy();
  });
});
