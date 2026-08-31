// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const messageRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./components/Message", () => ({
  Message: ({ message }: { message: { text: string } }) => {
    messageRenders.count += 1;
    return <div>{message.text}</div>;
  },
}));

import App, { latestActivityAnchor, MountedPanel, optimisticThreadSnapshot, reconcileOptimisticMessages } from "./App";

afterEach(cleanup);

describe("App render isolation", () => {
  beforeEach(() => {
    messageRenders.count = 0;
    localStorage.clear();
    delete window.tau;
  });

  it("keeps optimistic user messages until a matching Pi message arrives", () => {
    const pending = [{ scope: "session", message: { id: "local", role: "user" as const, text: "hello", timestamp: 100_000 } }];
    expect(reconcileOptimisticMessages(pending, [{ id: "old", role: "user", text: "hello", timestamp: 1 }])).toEqual(pending);
    expect(reconcileOptimisticMessages(pending, [{ id: "saved", role: "user", text: "hello", timestamp: 100_001 }])).toEqual([]);
  });

  it("anchors aggregate tool activity after the latest visible message in the turn", () => {
    const previous = { id: "previous", role: "assistant" as const, text: "Previous answer", timestamp: 1 };
    const user = { id: "user", role: "user" as const, text: "New request", timestamp: 2 };
    expect(latestActivityAnchor([previous, user])).toBe("user");
    expect(latestActivityAnchor([previous, user, {
      id: "reply", role: "assistant", text: "Current answer", timestamp: 3,
    }])).toBe("reply");
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

  it("keeps a new thread local until its first prompt and restores its draft after reload", async () => {
    const newSession = vi.fn(async () => ({ version: 1, updates: [] as never[] }));
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { models: [], thinkingLevel: "off", thinkingLevels: ["off"], serviceTier: "standard" as const, serviceTierAvailable: false, allTools: [], extensionCount: 0 },
        project: { cwd: "/project" },
      }),
      onHostEvent: () => () => {},
      listEditors: async () => [],
      getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
      getFileTree: async () => [],
      setAccessLevel: async () => {},
      newSession,
    } as unknown as typeof window.tau;
    const view = render(<App />);
    await screen.findByText("Untitled thread");
    const composer = screen.getByPlaceholderText(/Direct the agent/u);
    await waitFor(() => expect(document.activeElement).toBe(composer));
    fireEvent.click(screen.getByRole("button", { name: "Untitled thread" }));
    fireEvent.click(screen.getByText(/New thread/u));
    const dialog = await screen.findByRole("dialog", { name: "Search projects" });
    const projectOption = within(dialog).getByRole("option");
    projectOption.focus();
    fireEvent.click(projectOption);
    expect(newSession).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(composer));
    fireEvent.change(composer, { target: { value: "persistent draft" } });

    view.unmount();
    render(<App />);
    const restored = await waitFor(() => {
      const textarea = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
      expect(textarea.value).toBe("persistent draft");
      return textarea;
    });
    fireEvent.keyDown(restored, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalledWith("persistent draft", [], "/project"));
    expect(screen.getByText("persistent draft")).toBeTruthy();
  });

  it("generates a title after the first prompt creates a thread", async () => {
    const shell = {
      id: "created",
      path: "/created.jsonl",
      title: "Untitled thread",
      modifiedAt: 2,
      projectPath: "/project",
      projectName: "project",
      messageCount: 2,
    };
    const newSession = vi.fn(async () => ({
      version: 1 as const,
      updates: [
        { version: 1 as const, type: "thread-shell" as const, update: { sessionId: "created", shell } },
        {
          version: 1 as const,
          type: "thread-detail" as const,
          detail: {
            sessionId: "created",
            messages: [
              { id: "user", role: "user" as const, text: "Name this thread", timestamp: 1 },
              { id: "assistant", role: "assistant" as const, text: "Done", timestamp: 2 },
            ],
            isStreaming: false,
            activeTools: [],
          },
        },
      ],
    }));
    const generateThreadTitle = vi.fn(async () => ({
      version: 1 as const,
      updates: [{
        version: 1 as const,
        type: "thread-shell" as const,
        update: { sessionId: "created", shell: { ...shell, title: "Created thread title" } },
      }],
    }));
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: {
          models: [{ provider: "provider", id: "model", name: "Model" }],
          model: { provider: "provider", id: "model", name: "Model" },
          thinkingLevel: "off",
          thinkingLevels: ["off"],
          serviceTier: "standard" as const,
          serviceTierAvailable: false,
          allTools: [],
          extensionCount: 0,
        },
        project: { cwd: "/project" },
      }),
      onHostEvent: () => () => {},
      listEditors: async () => [],
      getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
      getFileTree: async () => [],
      setAccessLevel: async () => {},
      newSession,
      generateThreadTitle,
    } as unknown as typeof window.tau;

    render(<App />);
    await screen.findByText("Untitled thread");
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    const dialog = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(dialog).getByRole("option"));
    const composer = screen.getByPlaceholderText(/Direct the agent/u);
    fireEvent.change(composer, { target: { value: "Name this thread" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(generateThreadTitle).toHaveBeenCalledWith("provider", "model", false, "created"));
    expect(await screen.findByText("Created thread title")).toBeTruthy();
  });

  it("does not rerender existing transcript messages for a composer keystroke", () => {
    render(<App />);
    const before = messageRenders.count;
    fireEvent.change(screen.getByPlaceholderText(/Direct the agent/u), { target: { value: "x" } });
    expect(messageRenders.count).toBe(before);
  });
});
