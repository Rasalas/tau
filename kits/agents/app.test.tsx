// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiMessage, UiSession } from "tau";
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

  it("switches to the agent's thread when its row is clicked", async () => {
    const switchSession = vi.fn(async () => ({ version: 1 as const, updates: [] }));
    const client = appWith(state, [session("parent", "Parent thread", 3), session("alpha", "Alpha reply", 2), session("beta", "Beta reply", 1)], "parent");
    client.switchSession = switchSession;
    renderApp(client, { extensions: [workspaceExtension, agentsExtension] });

    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    fireEvent.click(await screen.findByRole("button", { name: "Alpha reply, running" }));
    await waitFor(() => expect(switchSession).toHaveBeenCalledWith("/sessions/alpha.jsonl"));
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

  it("keeps agents out of the rail, badges the parent, and reveals them on request", async () => {
    const sessions = [session("parent", "Parent thread", 3), session("alpha", "Alpha reply", 2), session("beta", "Beta reply", 1)];
    renderApp(appWith(state, sessions, "parent"), { extensions: [workspaceExtension, agentsExtension] });
    await screen.findByRole("navigation", { name: "Threads" });

    await waitFor(() => expect(screen.getByLabelText("1 agent running")).toBeTruthy());
    expect(screen.queryByText("Alpha reply")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show agent threads" }));
    expect(await screen.findByText("Alpha reply")).toBeTruthy();
  });
});
