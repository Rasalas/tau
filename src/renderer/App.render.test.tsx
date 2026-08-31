// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostEvent } from "../shared/contracts";

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

  it("moves active tool activity after a later steering message", () => {
    const messages = [
      { id: "request", role: "user" as const, text: "Start", timestamp: 1 },
      { id: "partial", role: "assistant" as const, text: "First result", timestamp: 2 },
      { id: "steering", role: "user" as const, text: "fahre bitte fort", timestamp: 3 },
      { id: "reply", role: "assistant" as const, text: "Done", timestamp: 4 },
    ];

    expect(latestActivityAnchor(messages, "request")).toBe("steering");
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
      supportsImageInput: true,
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
    expect(next.supportsImageInput).toBe(false);
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
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], serviceTier: "standard" as const, serviceTierAvailable: false, allTools: [], extensionCount: 0, supportsImageInput: true },
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
    await screen.findByRole("heading", { name: "What do you want to build?" });
    expect(getFileTree).not.toHaveBeenCalled();
  });

  it("uses a focused start screen until the first message is sent", async () => {
    const sendPrompt = vi.fn(async () => undefined);
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], serviceTier: "standard" as const, serviceTierAvailable: false, allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: () => () => {},
      listEditors: async () => [],
      getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
      getFileTree: async () => [],
      setAccessLevel: async () => {},
      sendPrompt,
    } as unknown as typeof window.tau;

    render(<App />);
    const heading = await screen.findByRole("heading", { name: "What do you want to build?" });
    expect(heading.closest(".conversation-start-screen")).toBeTruthy();
    expect(screen.queryByText("NEW THREAD")).toBeNull();
    expect(screen.getByRole("button", { name: "Change project, current project project" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Untitled thread" })).toBeNull();

    const composer = screen.getByPlaceholderText(/Direct the agent/u);
    fireEvent.change(composer, { target: { value: "Build the first screen" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith("Build the first screen", [], "session"));
    expect(screen.queryByRole("heading", { name: "What do you want to build?" })).toBeNull();
    expect(screen.getByRole("button", { name: "Untitled thread" })).toBeTruthy();
    expect(screen.getAllByText("Build the first screen").find((element) => element.tagName === "DIV")).toBeTruthy();
  });

  it("keeps a new-thread draft and attachments when host preflight rejects", async () => {
    let rejectNewSession!: (error: Error) => void;
    const newSession = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectNewSession = reject; }));
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], serviceTier: "standard" as const, serviceTierAvailable: false, allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: () => () => {},
      listEditors: async () => [],
      getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
      getFileTree: async () => [],
      setAccessLevel: async () => {},
      getPreparedThreadCapability: async (cwd: string) => ({ cwd, generation: 1, supportsImageInput: true }),
      newSession,
    } as unknown as typeof window.tau;

    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    const dialog = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(dialog).getByRole("option", { name: /project/u }));
    const composer = await screen.findByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    const image = new File([new Uint8Array([137, 80, 78, 71])], "draft.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Choose attachment files"), { target: { files: [image] } });
    await screen.findByRole("button", { name: "Preview draft.png" });
    fireEvent.change(composer, { target: { value: "submitted text" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalledWith("submitted text", [expect.objectContaining({ name: "draft.png" })], "/project"));

    fireEvent.change(composer, { target: { value: "newer draft" } });
    rejectNewSession(new Error("prompt rejected"));
    await waitFor(() => expect(screen.getByText(/prompt rejected/u)).toBeTruthy());
    expect(composer.value).toBe("newer draft");
    expect(screen.getByRole("button", { name: "Preview draft.png" })).toBeTruthy();
  });

  it("shows a whole-column drop target and clears it on leave and drop", async () => {
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], serviceTier: "standard" as const, serviceTierAvailable: false, allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: () => () => {},
      listEditors: async () => [],
      getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
      getFileTree: async () => [],
      setAccessLevel: async () => {},
    } as unknown as typeof window.tau;

    render(<App />);
    const heading = await screen.findByRole("heading", { name: "What do you want to build?" });
    const column = heading.closest("main");
    expect(column).toBeTruthy();
    if (!column) throw new Error("conversation column not rendered");
    const draft = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "keep this draft" } });
    const image = new File([new Uint8Array([137, 80, 78, 71])], "dropped.png", { type: "image/png" });
    const liveFilesBacking = [image];
    const liveFiles = {
      get length() { return liveFilesBacking.length; },
      item(index: number) { return liveFilesBacking[index] ?? null; },
      get 0() { return liveFilesBacking[0]; },
    } as unknown as FileList;
    const dataTransfer = {
      types: ["Files"],
      items: [{ type: "image/png" }],
      files: liveFiles,
      dropEffect: "none",
    } as unknown as DataTransfer;

    fireEvent.dragEnter(column, { dataTransfer });
    expect(screen.getByRole("status").className).toContain("valid");
    fireEvent.dragLeave(column, { dataTransfer, relatedTarget: null });
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.dragEnter(column, { dataTransfer });
    fireEvent.dragEnter(column, { dataTransfer });
    fireEvent.dragLeave(column, { dataTransfer, relatedTarget: null });
    expect(screen.getByRole("status")).toBeTruthy();
    fireEvent(window, createEvent("dragend", window));
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.dragEnter(column, { dataTransfer });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.dragEnter(column, { dataTransfer });
    fireEvent(window, createEvent("blur", window));
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.dragEnter(column, { dataTransfer });
    fireEvent.drop(column, { dataTransfer });
    liveFilesBacking.length = 0;
    expect(screen.queryByRole("status")).toBeNull();
    expect(await screen.findByRole("button", { name: "Preview dropped.png" })).toBeTruthy();
    expect(draft.value).toBe("keep this draft");

    const linkEvent = createEvent.drop(column, {
      dataTransfer: {
        types: ["text/uri-list"],
        items: [{ kind: "string", type: "text/uri-list" }],
        files: [],
        dropEffect: "none",
      },
    });
    fireEvent(column, linkEvent);
    expect(linkEvent.defaultPrevented).toBe(false);
  });

  it("updates the drop target when the active runtime changes image capability", async () => {
    let emit: ((event: HostEvent) => void) | undefined;
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], serviceTier: "standard" as const, serviceTierAvailable: false, allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: (handler: (event: HostEvent) => void) => { emit = handler; return () => {}; },
      listEditors: async () => [],
      getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
      getFileTree: async () => [],
      setAccessLevel: async () => {},
    } as unknown as typeof window.tau;

    render(<App />);
    const heading = await screen.findByRole("heading", { name: "What do you want to build?" });
    const attach = screen.getByRole("button", { name: "Attach files" });
    expect(attach.hasAttribute("disabled")).toBe(false);
    emit?.({
      type: "host-update",
      update: {
        version: 1,
        type: "catalog",
        catalog: {
          sessionId: "stale-thread", models: [], thinkingLevel: "off", thinkingLevels: ["off"], serviceTier: "standard",
          serviceTierAvailable: false, allTools: [], extensionCount: 0, supportsImageInput: false,
        },
      },
    });
    expect(attach.hasAttribute("disabled")).toBe(false);
    emit?.({
      type: "host-update",
      update: {
        version: 1,
        type: "catalog",
        catalog: {
          sessionId: "session",
          models: [], thinkingLevel: "off", thinkingLevels: ["off"], serviceTier: "standard",
          serviceTierAvailable: false, allTools: [], extensionCount: 0, supportsImageInput: false,
        },
      },
    });
    await waitFor(() => expect(attach.hasAttribute("disabled")).toBe(true));

    const column = heading.closest("main");
    if (!column) throw new Error("conversation column not rendered");
    fireEvent.dragEnter(column, {
      dataTransfer: {
        types: ["Files"],
        items: [{ kind: "file", type: "image/png" }],
        files: [new File([new Uint8Array([1])], "blocked.png", { type: "image/png" })],
        dropEffect: "none",
      },
    });
    expect(screen.getByRole("status").textContent).toMatch(/unavailable/u);
  });

  it("keeps a new thread local until its first prompt and restores its draft after reload", async () => {
    const newSession = vi.fn(async () => ({ version: 1, updates: [] as never[] }));
    const capabilityResolvers = new Map<string, Array<(capability: { cwd: string; generation: number; supportsImageInput: boolean }) => void>>();
    const getPreparedThreadCapability = vi.fn((cwd: string) => new Promise<{ cwd: string; generation: number; supportsImageInput: boolean }>((resolve) => {
      const pending = capabilityResolvers.get(cwd) ?? [];
      pending.push(resolve);
      capabilityResolvers.set(cwd, pending);
    }));
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [
          { path: "/project", name: "project", lastOpenedAt: 2 },
          { path: "/other", name: "other", lastOpenedAt: 1 },
        ], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], serviceTier: "standard" as const, serviceTierAvailable: false, allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: () => () => {},
      listEditors: async () => [],
      getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
      getFileTree: async () => [],
      setAccessLevel: async () => {},
      newSession,
      getPreparedThreadCapability,
    } as unknown as typeof window.tau;
    const view = render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    const composer = screen.getByPlaceholderText(/Direct the agent/u);
    await waitFor(() => expect(document.activeElement).toBe(composer));
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    const dialog = await screen.findByRole("dialog", { name: "Search projects" });
    const projectOption = within(dialog).getByRole("option", { name: /other/u });
    projectOption.focus();
    fireEvent.click(projectOption);
    expect(screen.getByRole("button", { name: "Change project, current project other" })).toBeTruthy();
    expect(newSession).not.toHaveBeenCalled();
    await waitFor(() => expect(getPreparedThreadCapability).toHaveBeenCalledWith("/other"));
    const attach = screen.getByRole("button", { name: "Attach files" });
    expect(attach.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Change project, current project other" }));
    const secondDialog = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(secondDialog).getByRole("option", { name: /project/u }));
    await waitFor(() => expect(getPreparedThreadCapability).toHaveBeenCalledWith("/project"));
    capabilityResolvers.get("/other")?.[0]?.({ cwd: "/other", generation: 1, supportsImageInput: true });
    expect(attach.hasAttribute("disabled")).toBe(true);
    capabilityResolvers.get("/project")?.[0]?.({ cwd: "/project", generation: 2, supportsImageInput: false });
    await waitFor(() => expect(attach.hasAttribute("disabled")).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    const thirdDialog = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(thirdDialog).getByRole("option", { name: /other/u }));
    await waitFor(() => expect(getPreparedThreadCapability).toHaveBeenCalledTimes(3));
    capabilityResolvers.get("/other")?.[1]?.({ cwd: "/other", generation: 3, supportsImageInput: true });
    await waitFor(() => expect(attach.hasAttribute("disabled")).toBe(false));
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
    await waitFor(() => expect(newSession).toHaveBeenCalledWith("persistent draft", [], "/other"));
    expect(screen.getAllByText("persistent draft").find((element) => element.tagName === "DIV")).toBeTruthy();
  });

  it("shows the start screen for a new thread even when the previous thread has activity", async () => {
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: {
          projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }],
          sessions: [{ id: "session", path: "/session.jsonl", title: "Existing thread", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 1 }],
        },
        detail: {
          sessionId: "session",
          messages: [{ id: "message", role: "user" as const, text: "Existing work", timestamp: 1 }],
          isStreaming: false,
          activeTools: [],
          turnActivity: {
            tools: [{ id: "tool", name: "read", args: {}, status: "done" as const, startedAt: 1, endedAt: 2 }],
          },
        },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], serviceTier: "standard" as const, serviceTierAvailable: false, allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: () => () => {},
      listEditors: async () => [],
      getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
      getFileTree: async () => [],
      setAccessLevel: async () => {},
    } as unknown as typeof window.tau;

    render(<App />);
    await screen.findByText("Existing work");
    fireEvent.click(screen.getByRole("button", { name: "Existing thread" }));
    fireEvent.click(await screen.findByRole("button", { name: "New thread" }));
    const dialog = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(dialog).getByRole("option", { name: /project/u }));

    expect(await screen.findByRole("heading", { name: "What do you want to build?" })).toBeTruthy();
    expect(screen.queryByText("Used 1 tool")).toBeNull();
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
          sessionId: "session",
          models: [{ provider: "provider", id: "model", name: "Model" }],
          model: { provider: "provider", id: "model", name: "Model" },
          thinkingLevel: "off",
          thinkingLevels: ["off"],
          serviceTier: "standard" as const,
          serviceTierAvailable: false,
          allTools: [],
          extensionCount: 0,
          supportsImageInput: true,
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
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    const dialog = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(dialog).getByRole("option"));
    const composer = screen.getByPlaceholderText(/Direct the agent/u);
    fireEvent.change(composer, { target: { value: "Name this thread" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(generateThreadTitle).toHaveBeenCalledWith("provider", "model", false, "created"));
    expect(await screen.findByText("Created thread title")).toBeTruthy();
  });

  it("does not send a prompt to the previous thread while a worktree is opening", async () => {
    let resolveCreation!: (result: {
      version: 1;
      updates: Array<
        | { version: 1; type: "thread-shell"; update: { sessionId: string; shell: { id: string; path: string; title: string; modifiedAt: number; projectPath: string; projectName: string; branch: string; messageCount: number } } }
        | { version: 1; type: "thread-detail"; detail: { sessionId: string; messages: never[]; isStreaming: false; activeTools: never[] } }
        | { version: 1; type: "project"; project: { cwd: string; branch: string } }
      >;
    }) => void;
    const creation = new Promise<Parameters<typeof resolveCreation>[0]>((resolve) => { resolveCreation = resolve; });
    const sendPrompt = vi.fn(async () => undefined);
    let cwd = "/project";
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: { sessionId: "main-thread", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "main-thread", models: [], thinkingLevel: "off", thinkingLevels: ["off"], serviceTier: "standard" as const, serviceTierAvailable: false, allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd, branch: "main" },
      }),
      onHostEvent: () => () => {},
      listEditors: async () => [],
      getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async () => ({
        root: cwd,
        isRepo: true,
        isDirty: false,
        branch: cwd === "/project" ? "main" : "feat/race",
        hasRemote: true,
        worktrees: [{ path: cwd, name: cwd === "/project" ? "project" : "feat-race", branch: cwd === "/project" ? "main" : "feat/race", isMain: cwd === "/project", isCurrent: true }],
        refs: [{ name: "main", isCurrent: cwd === "/project" }],
        worktreeParent: "/project-worktrees",
      }),
      getFileTree: async () => [],
      setAccessLevel: async () => {},
      createWorktree: async () => creation,
      sendPrompt,
    } as unknown as typeof window.tau;

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Current checkout" }));
    fireEvent.click(screen.getByRole("button", { name: "New worktree…" }));
    fireEvent.change(screen.getByPlaceholderText("feat/my-branch"), { target: { value: "feat/race" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    const composer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Must run in the worktree" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(composer.value).toBe("Must run in the worktree");

    cwd = "/project-worktrees/feat-race";
    resolveCreation({
      version: 1,
      updates: [
        { version: 1, type: "thread-shell", update: { sessionId: "worktree-thread", shell: { id: "worktree-thread", path: "/worktree.jsonl", title: "Untitled thread", modifiedAt: 2, projectPath: cwd, projectName: "project", branch: "feat/race", messageCount: 0 } } },
        { version: 1, type: "thread-detail", detail: { sessionId: "worktree-thread", messages: [], isStreaming: false, activeTools: [] } },
        { version: 1, type: "project", project: { cwd, branch: "feat/race" } },
      ],
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "feat-race" })).toBeTruthy());
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith("Must run in the worktree", [], "worktree-thread"));
  });

  it("refreshes the bottom-left worktree name after changing workspaces", async () => {
    let cwd = "/project";
    const getWorkspaceInfo = vi.fn(async () => ({
      root: cwd,
      isRepo: true,
      isDirty: false,
      branch: cwd === "/project" ? "main" : "feat/worktree-label",
      worktrees: [
        {
          path: "/project",
          name: "project",
          branch: "main",
          isMain: true,
          isCurrent: cwd === "/project",
        },
        {
          path: "/project-worktrees/feat-worktree-label",
          name: "feat-worktree-label",
          branch: "feat/worktree-label",
          isMain: false,
          isCurrent: cwd !== "/project",
        },
      ],
      refs: [],
      worktreeParent: "/project-worktrees",
    }));
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], serviceTier: "standard" as const, serviceTierAvailable: false, allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd },
      }),
      onHostEvent: () => () => {},
      listEditors: async () => [],
      getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo,
      getFileTree: async () => [],
      setAccessLevel: async () => {},
      openProject: async (path: string) => {
        cwd = path;
        return {
          version: 1,
          updates: [{ version: 1, type: "project", project: { cwd, branch: "feat/worktree-label" } }],
        };
      },
    } as unknown as typeof window.tau;

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Current checkout" }));
    fireEvent.click(screen.getByRole("button", { name: "Worktree (feat/worktree-label)" }));

    expect(await screen.findByRole("button", { name: "feat-worktree-label" })).toBeTruthy();
    expect(getWorkspaceInfo).toHaveBeenLastCalledWith();
  });

  it("does not rerender existing transcript messages for a composer keystroke", () => {
    render(<App />);
    const before = messageRenders.count;
    fireEvent.change(screen.getByPlaceholderText(/Direct the agent/u), { target: { value: "x" } });
    expect(messageRenders.count).toBe(before);
  });
});
