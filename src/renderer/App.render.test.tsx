// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const messageRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./components/Message", () => ({
  Message: ({ message }: { message: { text: string } }) => {
    messageRenders.count += 1;
    return <div>{message.text}</div>;
  },
}));

import App, { MountedPanel, optimisticThreadSnapshot } from "./App";

afterEach(cleanup);

describe("App render isolation", () => {
  beforeEach(() => {
    messageRenders.count = 0;
    localStorage.clear();
    delete window.tau;
  });

  it("switches cached content and its title in the same optimistic snapshot", () => {
    const current = {
      cwd: "/project",
      sessionId: "current",
      sessionTitle: "Current title",
      models: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      serviceTier: "standard" as const,
      serviceTierAvailable: false,
      messages: [],
      isStreaming: false,
      activeTools: [],
      allTools: [],
      extensionCount: 0,
    };
    const target = {
      id: "target",
      path: "/sessions/target.jsonl",
      title: "Target title",
      modifiedAt: 1,
      projectPath: "/project",
      projectName: "project",
      messageCount: 2,
    };
    const next = optimisticThreadSnapshot(current, target, {
      sessionId: "target",
      messages: [{ id: "message", role: "user", text: "Cached content", timestamp: 1 }],
      isStreaming: false,
      activeTools: [],
    });
    expect(next.sessionTitle).toBe("Target title");
    expect(next.messages[0]?.text).toBe("Cached content");
  });

  it("preserves opened panel state and skips unrelated parent renders while hidden", () => {
    let renders = 0;
    function Probe() {
      const [value, setValue] = React.useState(0);
      renders += 1;
      return <button onClick={() => setValue((current) => current + 1)}>panel {value}</button>;
    }
    const view = render(<MountedPanel Component={Probe} active label="Probe" extensionName="Fixture" />);
    fireEvent.click(screen.getByText("panel 0"));
    view.rerender(<MountedPanel Component={Probe} active={false} label="Probe" extensionName="Fixture" />);
    expect(screen.getByText("panel 1")).toBeTruthy();
    const before = renders;
    view.rerender(<MountedPanel Component={Probe} active={false} label="Probe" extensionName="Fixture" />);
    expect(renders).toBe(before);
  });

  it("does not load a hidden Files panel", async () => {
    const getFileTree = vi.fn(async () => []);
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { models: [], thinkingLevel: "off", thinkingLevels: ["off"], serviceTier: "standard" as const, serviceTierAvailable: false, allTools: [], extensionCount: 0 },
        project: { cwd: "/project" },
      }),
      onHostEvent: () => () => {},
      listEditors: async () => [],
      getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
      getFileTree,
      setAccessLevel: async () => {},
    } as unknown as typeof window.tau;
    render(<App />);
    await waitFor(() => expect(screen.getByText("Untitled thread")).toBeTruthy());
    expect(getFileTree).not.toHaveBeenCalled();
  });

  it("does not rerender existing transcript messages for a composer keystroke", () => {
    render(<App />);
    const before = messageRenders.count;
    fireEvent.change(screen.getByPlaceholderText(/Direct the agent/u), { target: { value: "x" } });
    expect(messageRenders.count).toBe(before);
  });
});
