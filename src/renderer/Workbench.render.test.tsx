// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setHostClient } from "./host-client-context";
import { setClientStorage } from "../workbench/client-storage";
import { createFakeHostClient, type FakeHostClient } from "./test-support/fake-host-client";
import { renderApp } from "./test-support/render-app";
import { workspaceHostStub } from "./test-support/workspace-host-stub";

// The thread header renders inside Workbench and outside the transcript, so its
// render count is the workbench's render count.
const titleBarRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./components/ThreadHeader", () => ({
  ThreadHeader: () => {
    titleBarRenders.count += 1;
    return <header data-testid="title-bar" />;
  },
  ThreadDetails: () => null,
  StartDetails: () => null,
}));

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

describe("workbench render isolation", () => {
  let client: FakeHostClient;

  beforeEach(() => {
    titleBarRenders.count = 0;
    client = createFakeHostClient({
      platform: "darwin",
      bootstrap: async () => ({
        version: 1,
        threadIndex: {
          projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }],
          sessions: [{ id: "session", path: "/session.jsonl", title: "Thread", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 1 }],
        },
        detail: {
          sessionId: "session",
          messages: [{ id: "user-1", role: "user", text: "hello", timestamp: 1 }],
          isStreaming: false,
          activeTools: [],
        },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
    });
    setHostClient(client);
  });

  it("streams assistant text without re-rendering the workbench", async () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => frames.push(callback));
    try {
      const view = renderApp(client);
      await screen.findByText("hello");
      await waitFor(() => expect(titleBarRenders.count).toBeGreaterThan(0));

      // The row itself is a structural change; the text that follows is not.
      act(() => client.emit({ type: "assistant-delta", sessionId: "session", id: "assistant-1", delta: "streamed" }));
      act(() => { frames.splice(0).forEach((frame) => frame(0)); });
      await waitFor(() => expect(view.container.querySelector(".transcript")?.textContent ?? "").toContain("streamed"));

      const before = titleBarRenders.count;
      act(() => {
        client.emit({ type: "assistant-delta", sessionId: "session", id: "assistant-1", delta: " answer" });
        client.emit({ type: "assistant-thinking", sessionId: "session", id: "assistant-1", delta: "because" });
      });
      act(() => { frames.splice(0).forEach((frame) => frame(0)); });

      await waitFor(() => expect(view.container.querySelector(".transcript")?.textContent ?? "").toContain("streamed answer"));
      expect(titleBarRenders.count).toBe(before);
    } finally {
      requestFrame.mockRestore();
    }
  });
});
