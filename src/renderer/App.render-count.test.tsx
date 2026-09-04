// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setHostClient } from "./host-client-context";
import { createFakeHostClient, type FakeHostClient } from "./test-support/fake-host-client";
import { renderApp } from "./test-support/render-app";
import { workspaceHostStub } from "./test-support/workspace-host-stub";

// App renders nothing but the workbench, so wrapping it counts App's own body.
const appRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./Workbench", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./Workbench")>();
  const Real = actual.Workbench;
  return {
    ...actual,
    Workbench: (props: { model: import("./Workbench").WorkbenchModel }) => {
      appRenders.count += 1;
      return <Real {...props} />;
    },
  };
});

// TitleBar renders inside the workbench and outside the transcript.
const workbenchRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./components/TitleBar", () => ({
  TitleBar: () => {
    workbenchRenders.count += 1;
    return <header data-testid="title-bar" />;
  },
}));

afterEach(() => { cleanup(); setHostClient(undefined); });

describe("app render isolation", () => {
  let client: FakeHostClient;

  beforeEach(() => {
    appRenders.count = 0;
    workbenchRenders.count = 0;
    localStorage.clear();
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

  it("streams assistant text without re-rendering App or the workbench", async () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => frames.push(callback));
    try {
      const view = renderApp(client);
      await screen.findByText("hello");
      await waitFor(() => expect(workbenchRenders.count).toBeGreaterThan(0));

      // The first delta opens a row, which is a structural change; the text
      // that follows it is not.
      act(() => client.emit({ type: "assistant-delta", sessionId: "session", id: "assistant-1", delta: "streamed" }));
      act(() => { frames.splice(0).forEach((frame) => frame(0)); });
      await waitFor(() => expect(view.container.querySelector(".transcript")?.textContent ?? "").toContain("streamed"));

      const appBefore = appRenders.count;
      const workbenchBefore = workbenchRenders.count;
      act(() => {
        client.emit({ type: "assistant-delta", sessionId: "session", id: "assistant-1", delta: " answer" });
        client.emit({ type: "assistant-thinking", sessionId: "session", id: "assistant-1", delta: "because" });
      });
      act(() => { frames.splice(0).forEach((frame) => frame(0)); });

      await waitFor(() => expect(view.container.querySelector(".transcript")?.textContent ?? "").toContain("streamed answer"));
      expect(appRenders.count).toBe(appBefore);
      expect(workbenchRenders.count).toBe(workbenchBefore);
    } finally {
      requestFrame.mockRestore();
    }
  });
});
