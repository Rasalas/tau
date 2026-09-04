// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostEvent, TauDesktopApi } from "../shared/contracts";
import { workspaceHostStub } from "./test-support/workspace-host-stub";

// TitleBar renders inside Workbench and outside the transcript, so its render
// count is the workbench's render count.
const titleBarRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./components/TitleBar", () => ({
  TitleBar: () => {
    titleBarRenders.count += 1;
    return <header data-testid="title-bar" />;
  },
}));

import App from "./App";

afterEach(cleanup);

describe("workbench render isolation", () => {
  let publish: (event: HostEvent) => void;

  beforeEach(() => {
    titleBarRenders.count = 0;
    localStorage.clear();
    window.tau = {
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
      onHostEvent: (listener: (event: HostEvent) => void) => { publish = listener; return () => {}; },
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
    } as unknown as TauDesktopApi;
  });

  it("streams assistant text without re-rendering the workbench", async () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => frames.push(callback));
    try {
      const view = render(<App />);
      await screen.findByText("hello");
      await waitFor(() => expect(titleBarRenders.count).toBeGreaterThan(0));

      // The row itself is a structural change; the text that follows is not.
      act(() => publish({ type: "assistant-delta", sessionId: "session", id: "assistant-1", delta: "streamed" }));
      act(() => { frames.splice(0).forEach((frame) => frame(0)); });
      await waitFor(() => expect(view.container.querySelector(".transcript")?.textContent ?? "").toContain("streamed"));

      const before = titleBarRenders.count;
      act(() => {
        publish({ type: "assistant-delta", sessionId: "session", id: "assistant-1", delta: " answer" });
        publish({ type: "assistant-thinking", sessionId: "session", id: "assistant-1", delta: "because" });
      });
      act(() => { frames.splice(0).forEach((frame) => frame(0)); });

      await waitFor(() => expect(view.container.querySelector(".transcript")?.textContent ?? "").toContain("streamed answer"));
      expect(titleBarRenders.count).toBe(before);
    } finally {
      requestFrame.mockRestore();
    }
  });
});
