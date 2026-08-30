// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostEvent, TauDesktopApi, UiToolRun } from "../shared/contracts";
import App from "./App";

afterEach(cleanup);

function tool(id: string): UiToolRun {
  return { id, name: "read", args: { path: `${id}.ts` }, status: "done", startedAt: 1, endedAt: 2 };
}

describe("last-turn activity", () => {
  let publish: (event: HostEvent) => void;

  beforeEach(() => {
    localStorage.clear();
    window.tau = {
      platform: "darwin",
      bootstrap: async () => ({
        version: 1,
        threadIndex: {
          projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }],
          sessions: [{ id: "session", path: "/session.jsonl", title: "Thread", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 0 }],
        },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { models: [], thinkingLevel: "off", thinkingLevels: ["off"], serviceTier: "standard", serviceTierAvailable: false, allTools: [], extensionCount: 0 },
        project: { cwd: "/project" },
      }),
      onHostEvent: (listener: (event: HostEvent) => void) => { publish = listener; return () => {}; },
      listEditors: async () => [],
      getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
      getFileTree: async () => [],
      setAccessLevel: async () => {},
    } as unknown as TauDesktopApi;
  });

  it("aggregates steering into the current run and resets on the next run", async () => {
    render(<App />);
    await screen.findByText("Thread");

    act(() => {
      publish({ type: "agent-status", sessionId: "session", running: true });
      publish({ type: "tool-start", tool: { ...tool("one"), status: "running", endedAt: undefined } });
      publish({ type: "tool-end", tool: tool("one") });
      publish({ type: "tool-start", tool: { ...tool("two"), status: "running", endedAt: undefined } });
      publish({ type: "tool-end", tool: tool("two") });
    });
    expect(await screen.findByText("Used 2 tools")).toBeTruthy();

    act(() => {
      publish({ type: "queue", steering: ["keep going"], followUp: [] });
      publish({ type: "tool-start", tool: { ...tool("three"), status: "running", endedAt: undefined } });
      publish({ type: "tool-end", tool: tool("three") });
    });
    expect(await screen.findByText("Used 3 tools")).toBeTruthy();

    act(() => {
      publish({ type: "agent-status", sessionId: "session", running: false });
      publish({ type: "agent-status", sessionId: "session", running: true });
      publish({ type: "tool-start", tool: { ...tool("four"), status: "running", endedAt: undefined } });
      publish({ type: "tool-end", tool: tool("four") });
    });
    await waitFor(() => expect(screen.queryByText("Used 3 tools")).toBeNull());
    expect(screen.getByText("Used 1 tool")).toBeTruthy();
  });
});
