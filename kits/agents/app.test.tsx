// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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

describe("the Agents panel", () => {
  it("lists sixty agents without mounting sixty rows", async () => {
    const many: AgentsState = {
      maxRunning: 8,
      links: Array.from({ length: 60 }, (_, index) =>
        link(`agent-${index}`, "parent", index < 8 ? "running" : "pending", index, { startedAt: Date.now() - 5_000 })),
    };
    const sessions = [session("parent", "Parent thread", 100), ...many.links.map((entry, index) => session(entry.id, `Agent ${index}`, 60 - index))];
    renderApp(appWith(many, sessions, "parent"), { extensions: [workspaceExtension, agentsExtension] });

    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    const heading = await screen.findByRole("heading", { name: "Agents" });
    const panel = heading.closest(".agents-panel") as HTMLElement;
    await waitFor(() => expect(panel.querySelectorAll(".agent-row").length).toBeGreaterThan(0));

    expect(panel.querySelectorAll(".agent-row")).toHaveLength(VIRTUAL_WINDOW);
    expect(panel.textContent).toContain("8 running");
    expect(panel.textContent).toContain("52 pending");
    expect(panel.querySelector(".agent-total-cost")!.textContent).toBe("–");
  });

  it("does not advertise agents running in other threads in the panel footer", async () => {
    const sessions = [
      session("unrelated", "Unrelated thread", 4),
      session("parent", "Parent thread", 3),
      session("alpha", "Alpha reply", 2),
      session("beta", "Beta reply", 1),
    ];
    renderApp(appWith(state, sessions, "unrelated"), { extensions: [workspaceExtension, agentsExtension] });

    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    await screen.findByRole("heading", { name: "Agents" });
    expect(screen.queryByText(/agents? in other threads/u)).toBeNull();
    expect(screen.queryByRole("button", { name: /Go to Parent thread/u })).toBeNull();
  });

  it("opens the agent's chat as a stage tab and leaves the active thread alone", async () => {
    const switchSession = vi.fn(async () => ({ version: 1 as const, updates: [] }));
    const client = appWith(state, [session("parent", "Parent thread", 3), session("alpha", "Alpha reply", 2), session("beta", "Beta reply", 1)], "parent");
    client.switchSession = switchSession;
    client.loadTranscript = async (sessionId: string) => ({
      sessionId, hasMore: false,
      messages: [{ id: "a1", role: "assistant" as const, text: "Alpha finished the job.", timestamp: 1 }],
    });
    renderApp(client, { extensions: [workspaceExtension, agentsExtension] });

    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Alpha reply, running" }));

    expect(await screen.findByRole("tab", { name: /Alpha reply/u })).toBeTruthy();
    expect(await screen.findByText("Alpha finished the job.")).toBeTruthy();
    expect(switchSession).not.toHaveBeenCalled();
    // The rail still shows the parent only: the child is not the active thread.
    const rail = screen.getByRole("navigation", { name: "Threads" });
    expect(within(rail).queryByText("Alpha reply")).toBeNull();
    expect(within(rail).getByText("Parent thread")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await waitFor(() => expect(switchSession).toHaveBeenCalledWith("/sessions/alpha.jsonl"));
  });

  it("opens a second agent in a second tab", async () => {
    const client = appWith(state, [session("parent", "Parent thread", 3), session("alpha", "Alpha reply", 2), session("beta", "Beta reply", 1)], "parent");
    renderApp(client, { extensions: [workspaceExtension, agentsExtension] });

    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Alpha reply, running" }));
    await screen.findByRole("tab", { name: /Alpha reply/u });
    // A preview tab is replaced, so the first has to be pinned to keep both.
    fireEvent.doubleClick(screen.getByRole("tab", { name: /Alpha reply/u }));
    fireEvent.click(screen.getByRole("button", { name: "Beta reply, completed" }));

    expect(await screen.findByRole("tab", { name: /Beta reply/u })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Alpha reply/u })).toBeTruthy();
  });
});

describe("agent definitions in the Agents panel", () => {
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

    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    const section = await screen.findByRole("region", { name: "Agent definitions" });
    expect(within(section).getByText("Reviews the change")).toBeTruthy();
    expect(within(section).getByText("1 open")).toBeTruthy();
    expect(within(section).getByText(/1 file in .tau\/agents could not be used/u)).toBeTruthy();
    // The running agent names the definition it came from.
    expect(screen.getByText("reviewer", { selector: ".agent-row-definition" })).toBeTruthy();

    const writer = within(section).getByText("writer").closest("li") as HTMLElement;
    fireEvent.click(within(writer).getByRole("button", { name: "Start" }));
    fireEvent.change(within(writer).getByRole("textbox", { name: "Task for writer" }), { target: { value: "Check it" } });
    fireEvent.click(within(writer).getByRole("button", { name: "Start writer" }));
    await waitFor(() => expect(commands).toContainEqual({ command: "start", input: { parentThreadId: "parent", agent: "writer", prompt: "Check it" } }));
    expect(await screen.findByText("Started writer.")).toBeTruthy();
    expect(commands.filter((entry) => entry.command === "definitions").map((entry) => entry.input)).toContainEqual({ sessionId: "parent" });
  });
});

describe("a spawned thread's worktree", () => {
  it("shows the branch it worked in and takes its changes back", async () => {
    const worktree = {
      mode: "worktree" as const,
      path: "/project-worktrees/tau-agent-alpha",
      branch: "tau/agent-alpha",
      changes: { files: 2, added: 7, removed: 1, commits: 0, uncommitted: 2 },
    };
    const agents: AgentsState = {
      maxRunning: 8,
      links: [link("alpha", "parent", "completed", 1, { result: "done", workspace: worktree })],
    };
    const commands: Array<{ command: string; input?: unknown }> = [];
    renderApp(
      appWith(agents, [session("parent", "Parent thread", 3), session("alpha", "Alpha reply", 2)], "parent", [], (command, input) => {
        if (command === "definitions") return undefined;
        commands.push({ command, input });
        return { detail: "Applied 2 files, +7 −1 from tau/agent-alpha." };
      }),
      { extensions: [workspaceExtension, agentsExtension] },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    expect(await screen.findByText(/tau\/agent-alpha · 2 files \+7 −1/u)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Apply changes of Alpha reply" }));
    await waitFor(() => expect(commands).toEqual([{ command: "apply-changes", input: { threadId: "alpha" } }]));
    expect(await screen.findByText("Applied 2 files, +7 −1 from tau/agent-alpha.")).toBeTruthy();
  });
});

describe("an agent on another machine", () => {
  it("carries the machine's chip, its cost there, and takes its work back by its handle", async () => {
    const agents: AgentsState = {
      maxRunning: 8,
      links: [link("h-1", "parent", "completed", 1, {
        threadId: undefined,
        title: "Word on rex",
        result: "apple",
        machine: { id: "rex-id", name: "rex", link: "link-1", thread: "rex-thread", costUsd: 0.25 },
        workspace: { mode: "worktree", path: "/rex/worktrees/work/t1", branch: "tau/remote-t1" },
      })],
    };
    const commands: Array<{ command: string; input?: unknown }> = [];
    renderApp(
      appWith(agents, [session("parent", "Parent thread", 3)], "parent", [], (command, input) => {
        if (command === "definitions") return undefined;
        commands.push({ command, input });
        return { detail: "Merged tau/rex/word. The worktree on rex is removed." };
      }),
      { extensions: [workspaceExtension, agentsExtension] },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    const row = await screen.findByRole("button", { name: "Word on rex, completed" });
    expect(within(row).getByLabelText("Runs on rex.").textContent).toBe("rex");
    expect(within(row).getByText(/\$0\.25/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply changes of Word on rex" }));
    await waitFor(() => expect(commands).toEqual([{ command: "apply-changes", input: { threadId: "h-1" } }]));
  });
});

describe("the navigator with agent threads", () => {
  it("offers the way back from a child the index alone knows", async () => {
    const sessions = [session("parent", "Parent thread", 3), session("alpha", "Alpha reply", 2, undefined, "parent")];
    renderApp(appWith({ maxRunning: 8, links: [] }, sessions, "alpha", [
      { id: "m1", role: "user", text: "Reply with A", timestamp: 1 },
    ]), { extensions: [workspaceExtension, agentsExtension] });
    expect(await screen.findByText(/spawned by Parent thread/)).toBeTruthy();
  });

  it("keeps agents out of the rail and badges the parent instead", async () => {
    const sessions = [session("parent", "Parent thread", 3), session("alpha", "Alpha reply", 2), session("beta", "Beta reply", 1)];
    renderApp(appWith(state, sessions, "parent"), { extensions: [workspaceExtension, agentsExtension] });
    const rail = await screen.findByRole("navigation", { name: "Threads" });

    await waitFor(() => expect(screen.getByLabelText("1 agent running")).toBeTruthy());
    expect(within(rail).queryByText("Alpha reply")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show agent threads" })).toBeNull();

    // Not even a search brings one back: the Agents panel is the only list.
    fireEvent.change(screen.getByRole("textbox", { name: "Search threads" }), { target: { value: "Alpha" } });
    expect(within(rail).queryByText("Alpha reply")).toBeNull();
  });

  it("keeps an agent thread out of the rail after Take over makes it the active one", async () => {
    const sessions = [session("parent", "Parent thread", 3), session("alpha", "Alpha reply", 2, undefined, "parent")];
    renderApp(appWith({ maxRunning: 8, links: [] }, sessions, "alpha", [
      { id: "m1", role: "user", text: "Reply with A", timestamp: 1 },
    ]), { extensions: [workspaceExtension, agentsExtension] });
    const rail = await screen.findByRole("navigation", { name: "Threads" });

    expect(await screen.findByText(/spawned by Parent thread/)).toBeTruthy();
    expect(within(rail).queryByText("Alpha reply")).toBeNull();
  });

  // Pi names the tool itself; every other runtime reaches it over MCP.
  it.each(["tau_spawn_thread", "mcp__tau__tau_spawn_thread"])("draws one card for a %s batch and opens each agent from it", async (name) => {
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
    expect(await screen.findByText("Started 2 agents · 1 working")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Worked for/u })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open Alpha reply, running" }));
    expect(await screen.findByRole("tab", { name: /Alpha reply/u })).toBeTruthy();
    expect(await screen.findByText("Alpha finished the job.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open Agents" }));
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
  });
});
