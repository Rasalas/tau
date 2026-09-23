// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopExtension, HostActionResult, NewThreadResult } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import {
  createMemoryStorage,
  createNewThreadDraft,
  createNewThreadRequestId,
  getClientStorage,
  setClientStorage,
  setHostClient,
  writeNewThreadDraft,
} from "../../src/renderer/test-support/kit-harness.js";
import { workspaceExtension } from "./desktop.js";
import { WORKSPACE_STORE_SERVICE, type ThreadRailOrganizer, type WorkspaceStoreApi } from "./protocol.js";

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

/**
 * Workspace Kit in front of the real workbench. These moved out of
 * `App.render.test.tsx` when the kit moved out of core: every one of them
 * needs the rail, a panel, the worktree bar or a checkpoint card, which core
 * alone does not draw.
 */
describe("Workspace Kit in the workbench", () => {
  it("starts with the right sidebar closed and opens it from the rail", async () => {
    const view = renderApp(undefined, { extensions: [workspaceExtension] });
    const shell = view.container.querySelector(".app-shell") as HTMLElement;
    const filesButton = await screen.findByRole("button", { name: "Files" });
    await waitFor(() => expect(filesButton.getAttribute("aria-pressed")).toBe("false"));
    expect(shell.classList.contains("dock-closed")).toBe(true);
    expect(screen.getAllByRole("button", { name: "Show panel" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Expand panel" })).toBeNull();

    fireEvent.click(filesButton);
    expect(shell.classList.contains("dock-closed")).toBe(false);
    expect(filesButton.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(filesButton);
    expect(shell.classList.contains("dock-closed")).toBe(true);
    expect(filesButton.getAttribute("aria-pressed")).toBe("false");
  });

  it("does not load a hidden Files panel", async () => {
    const getFileTree = vi.fn(async () => []);
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree,
      }),
    });
    renderApp(client, { extensions: [workspaceExtension] });
    await screen.findByRole("heading", { name: "What do you want to build?" });
    const filesButton = await screen.findByRole("button", { name: "Files" });
    await waitFor(() => expect(filesButton.getAttribute("aria-pressed")).toBe("false"));
    expect(screen.queryByRole("heading", { name: "Files" })).toBeNull();
    expect(getFileTree).not.toHaveBeenCalled();

    fireEvent.click(filesButton);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Files" })).toBeTruthy());
    expect(getFileTree).toHaveBeenCalled();
  });

  it("keeps the virtual thread canvas from shrinking inside the scroll rail", async () => {
    renderApp(undefined, { extensions: [workspaceExtension] });
    const navigation = await screen.findByRole("navigation", { name: "Threads" });
    const canvas = navigation.firstElementChild as HTMLElement;
    expect(canvas.style.flexShrink).toBe("0");
  });

  it("reveals recent thread history in batches of twenty-five", async () => {
    const sessions = Array.from({ length: 71 }, (_, index) => ({
      id: `thread-${index}`,
      path: `/sessions/thread-${index}.jsonl`,
      title: `Thread ${index}`,
      modifiedAt: 100 - index,
      projectPath: "/project",
      projectName: "project",
      messageCount: 1,
    }));
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions },
        detail: { sessionId: "thread-0", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "thread-0", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub(),
    });
    renderApp(client, { extensions: [workspaceExtension] });

    const more = await screen.findByRole("button", { name: "+ show 25 more" });
    fireEvent.click(more);
    expect(screen.getByRole("button", { name: "+ show 21 more" })).toBeTruthy();
  });

  it("marks a thread whose last turn failed as Failed, with the reason on the badge", async () => {
    const shell = (id: string) => ({ id, path: `/sessions/${id}.jsonl`, title: `Thread ${id}`, modifiedAt: 2, projectPath: "/project", projectName: "project", messageCount: 2 });
    // A labelled section is drawn without the virtual list, which jsdom cannot measure.
    const organizing: DesktopExtension = {
      id: "test.organizer",
      name: "Organizer",
      activate: (context) => context.useService<WorkspaceStoreApi>(WORKSPACE_STORE_SERVICE, (store) => store.registerThreadRailOrganizer({
        subscribe: () => () => undefined,
        getVersion: () => 1,
        sections: (threads) => [{ id: "pinned", label: "Pinned", threads: [...threads] }, { id: "active", threads: [] }],
        menu: () => [],
        runMenu: () => undefined,
        toggleSettled: () => undefined,
        dropLabel: () => "Move",
        drop: () => undefined,
      })),
    };
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: {
          projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }],
          sessions: [{ ...shell("broken"), turnError: "stream disconnected" }, shell("fine")],
        },
        detail: { sessionId: "fine", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "fine", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub(),
    });
    renderApp(client, { extensions: [workspaceExtension, organizing] });

    const row = (await screen.findByText("Thread broken")).closest(".thread-row") as HTMLElement;
    const badge = row.querySelector(".thread-status-age.status-failed");
    expect(badge?.textContent).toBe("Failed");
    expect(badge?.getAttribute("data-tooltip")).toBe("stream disconnected");
    expect(screen.getByText("Thread fine").closest(".thread-row")?.querySelector(".status-failed")).toBeNull();
  });

  it("opens settled history by default and reveals it in batches of twenty-five", async () => {
    const sessions = Array.from({ length: 71 }, (_, index) => ({
      id: `settled-${index}`,
      path: `/sessions/settled-${index}.jsonl`,
      title: `Settled thread ${index}`,
      modifiedAt: 100 - index,
      projectPath: "/project",
      projectName: "project",
      messageCount: 1,
    }));
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions },
        detail: { sessionId: "settled-0", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "settled-0", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub(),
    });
    renderApp(client, {
      extensions: [workspaceExtension],
      seed: ({ preferences }) => sessions.forEach((session) => preferences.toggleSettled(session.id)),
    });

    const toggle = await screen.findByRole("button", { name: /Settled · 71/u });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Settled thread 24")).toBeTruthy();
    expect(screen.queryByText("Settled thread 25")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "+ show 25 more" }));
    expect(screen.getByText("Settled thread 25")).toBeTruthy();
  });

  it("draws the sections, the row menu and the settle button another kit's organizer decides", async () => {
    const sessions = ["alpha", "beta", "gamma"].map((id, index) => ({
      id, path: `/sessions/${id}.jsonl`, title: `Thread ${id}`, modifiedAt: 10 - index, projectPath: "/project", projectName: "project", messageCount: 1,
    }));
    const runMenu = vi.fn();
    const toggleSettled = vi.fn();
    const organizer: ThreadRailOrganizer = {
      subscribe: () => () => undefined,
      getVersion: () => 1,
      sections: (threads) => [
        { id: "pinned", label: "Pinned", threads: threads.filter((thread) => thread.id === "gamma") },
        { id: "active", threads: threads.filter((thread) => thread.id === "alpha") },
        { id: "snoozed", label: "Snoozed", shelf: true, collapsed: true, threads: threads.filter((thread) => thread.id === "beta") },
      ],
      menu: (session) => [{ items: [{ id: "pin", label: `Pin ${session.title}` }] }],
      runMenu,
      toggleSettled,
      dropLabel: () => "Move",
      drop: () => undefined,
      Layer: () => <p>organizer layer</p>,
    };
    const organizing: DesktopExtension = {
      id: "test.organizer",
      name: "Organizer",
      activate: (context) => context.useService<WorkspaceStoreApi>(WORKSPACE_STORE_SERVICE, (store) => store.registerThreadRailOrganizer(organizer)),
    };
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions },
        detail: { sessionId: "alpha", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "alpha", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub(),
    });
    renderApp(client, { extensions: [workspaceExtension, organizing] });

    expect(await screen.findByText("Pinned · 1")).toBeTruthy();
    expect(screen.getByText("organizer layer")).toBeTruthy();
    const snoozed = screen.getByRole("button", { name: /Snoozed · 1/u });
    expect(snoozed.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Thread beta")).toBeNull();
    fireEvent.click(snoozed);
    expect(screen.getByText("Thread beta")).toBeTruthy();

    fireEvent.contextMenu(screen.getByText("Thread gamma"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin Thread gamma" }));
    // The page's own menu stands in for the OS's, which the fake host refuses; the choice arrives with the promise.
    await waitFor(() => expect(runMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "gamma" }), "pin", expect.anything()));

    fireEvent.click(screen.getByRole("button", { name: "Settle Thread gamma" }));
    expect(toggleSettled).toHaveBeenCalledWith(expect.objectContaining({ id: "gamma" }));
  });

  it("switches to an existing thread while a new-thread message is still being delivered", async () => {
    let createdClientMessageId = "";
    const newSession = vi.fn(async (...args: unknown[]) => {
      createdClientMessageId = (args[3] as { clientMessageId: string }).clientMessageId;
      return {
        version: 1 as const,
        updates: [] as never[],
        sessionId: "created",
        submission: { accepted: true as const },
      };
    });
    const switchSession = vi.fn(async () => ({
      version: 1 as const,
      updates: [{
        version: 1 as const,
        type: "thread-detail" as const,
        detail: {
          sessionId: "target",
          messages: [{ id: "target-message", role: "assistant" as const, text: "Target content", timestamp: 1 }],
          isStreaming: false,
          activeTools: [],
        },
      }],
    }));
    const sendPrompt = vi.fn(async () => undefined);
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: {
          projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }],
          sessions: [
            { id: "current", path: "/current.jsonl", title: "Current thread", modifiedAt: 2, projectPath: "/project", projectName: "project", messageCount: 1 },
            { id: "target", path: "/target.jsonl", title: "Target thread", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 1 },
          ],
        },
        detail: { sessionId: "current", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "current", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      newSession,
      switchSession,
      sendPrompt,
    });

    renderApp(client, { extensions: [workspaceExtension] });
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    const picker = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(picker).getByRole("option", { name: /project/u }));

    const composer = await screen.findByPlaceholderText(/Direct the agent/u);
    fireEvent.change(composer, { target: { value: "background request" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-busy")).toBe("false"));

    const navigation = await screen.findByRole("navigation", { name: "Threads" });
    fireEvent.keyDown(navigation, { key: "ArrowDown" });
    fireEvent.keyDown(navigation, { key: "Enter" });

    await waitFor(() => expect(switchSession).toHaveBeenCalledWith("/target.jsonl"));
    expect(screen.queryByText(/Wait for the current message delivery/u)).toBeNull();
    expect(await screen.findByText("Target content")).toBeTruthy();

    client.emit({
      type: "user-message",
      sessionId: "created",
      message: {
        id: "created-message",
        clientMessageId: createdClientMessageId,
        role: "user",
        text: "background request",
        timestamp: Date.now(),
      },
    });
    expect(screen.getByText("Target content")).toBeTruthy();
    expect(screen.queryByText("background request")).toBeNull();

    fireEvent.change(composer, { target: { value: "continue target" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith(
      "continue target",
      [],
      "target",
      expect.objectContaining({ clientMessageId: expect.any(String) }),
      undefined,
    ));
  });

  it("switches projects while a new-thread message is still being delivered", async () => {
    let createdClientMessageId = "";
    let resolveNewSession!: (result: { version: 1; updates: never[]; sessionId: string; submission: { accepted: true } }) => void;
    const newSession = vi.fn((...args: unknown[]) => {
      createdClientMessageId = (args[3] as { clientMessageId: string }).clientMessageId;
      return new Promise<{ version: 1; updates: never[]; sessionId: string; submission: { accepted: true } }>((resolve) => { resolveNewSession = resolve; });
    });
    const openProject = vi.fn(async () => ({
      version: 1 as const,
      updates: [
        { version: 1 as const, type: "project" as const, project: { cwd: "/second" } },
        {
          version: 1 as const,
          type: "thread-detail" as const,
          detail: { sessionId: "other-session", messages: [{ id: "other-message", role: "assistant" as const, text: "Other content", timestamp: 1 }], isStreaming: false, activeTools: [] },
        },
      ],
    }));
    const sendPrompt = vi.fn(async () => undefined);
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: {
          projects: [
            { path: "/project", name: "project", lastOpenedAt: 2 },
            { path: "/second", name: "second", lastOpenedAt: 1 },
          ],
          sessions: [
            { id: "current", path: "/current.jsonl", title: "Current thread", modifiedAt: 2, projectPath: "/project", projectName: "project", messageCount: 0 },
          ],
        },
        detail: { sessionId: "current", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "current", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async (cwd?: string) => ({ root: cwd ?? "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      newSession,
      openProject,
      sendPrompt,
    });

    renderApp(client, { extensions: [workspaceExtension] });
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    const picker = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(picker).getByRole("option", { name: /project/u }));
    const composer = await screen.findByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "background request" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalled());

    // The host has not even named the session yet; leaving must still work.
    fireEvent.click(await screen.findByRole("button", { name: /All projects/u }));
    const switcher = await screen.findByRole("dialog", { name: "Switch project" });
    fireEvent.click(within(switcher).getByRole("option", { name: /second/u }));
    await waitFor(() => expect(openProject).toHaveBeenCalledWith("/second"));
    expect(screen.queryByText(/Wait for the current message/u)).toBeNull();
    expect(screen.queryByText(/Wait for the new thread to start/u)).toBeNull();
    expect(await screen.findByText("Other content")).toBeTruthy();
    expect(getClientStorage()?.get("tau.active-new-thread.v1")).toBeNull();

    resolveNewSession({ version: 1, updates: [], sessionId: "created", submission: { accepted: true } });
    await waitFor(() => expect(newSession).toHaveBeenCalledOnce());
    client.emit({
      type: "user-message",
      sessionId: "created",
      message: { id: "created-message", clientMessageId: createdClientMessageId, role: "user", text: "background request", timestamp: Date.now() },
    });
    // The delivery lands in its own thread without pulling the view back.
    expect(screen.getByText("Other content")).toBeTruthy();
    expect(screen.queryByText("background request")).toBeNull();

    const otherComposer = await screen.findByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(otherComposer, { target: { value: "continue other" } });
    fireEvent.keyDown(otherComposer, { key: "Enter" });
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith(
      "continue other",
      [],
      "other-session",
      expect.objectContaining({ clientMessageId: expect.any(String) }),
      undefined,
    ));
  });

  it("starts a fresh draft in another project while the first message is still being delivered", async () => {
    let createdClientMessageId = "";
    let resolveNewSession!: (result: { version: 1; updates: never[]; sessionId: string; submission: { accepted: true } }) => void;
    const newSession = vi.fn((...args: unknown[]) => {
      if (newSession.mock.calls.length > 1) {
        return Promise.resolve({ version: 1 as const, updates: [] as never[], sessionId: "second", submission: { accepted: true as const } });
      }
      createdClientMessageId = (args[3] as { clientMessageId: string }).clientMessageId;
      return new Promise<{ version: 1; updates: never[]; sessionId: string; submission: { accepted: true } }>((resolve) => { resolveNewSession = resolve; });
    });
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: {
          projects: [
            { path: "/project", name: "project", lastOpenedAt: 2 },
            { path: "/second", name: "second", lastOpenedAt: 1 },
          ],
          sessions: [],
        },
        detail: { sessionId: "current", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "current", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async (cwd?: string) => ({ root: cwd ?? "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      getPreparedThreadCapability: async (cwd: string) => ({ cwd, generation: 1, supportsImageInput: true }),
      newSession,
    });

    renderApp(client, { extensions: [workspaceExtension] });
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    const firstPicker = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(firstPicker).getByRole("option", { name: /project/u }));
    const composer = await screen.findByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "first request" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    const secondPicker = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(secondPicker).getByRole("option", { name: /second/u }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search projects" })).toBeNull());
    expect(screen.queryByText(/Wait for the current message/u)).toBeNull();

    // The submitted text belongs to the first thread; the new draft starts empty and usable.
    const freshComposer = await screen.findByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    await waitFor(() => expect(freshComposer.value).toBe(""));
    resolveNewSession({ version: 1, updates: [], sessionId: "created", submission: { accepted: true } });
    client.emit({
      type: "user-message",
      sessionId: "created",
      message: { id: "created-message", clientMessageId: createdClientMessageId, role: "user", text: "first request", timestamp: Date.now() },
    });
    expect(screen.getByRole("heading", { name: "What do you want to build?" })).toBeTruthy();
    expect(screen.queryByText("first request")).toBeNull();

    fireEvent.change(freshComposer, { target: { value: "second request" } });
    fireEvent.keyDown(freshComposer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenLastCalledWith(
      "second request",
      [],
      "/second",
      expect.objectContaining({ clientMessageId: expect.any(String) }),
      undefined,
    ));
  });

  it("keeps restored draft chrome scoped to its pending project", async () => {
    const storage = createMemoryStorage();
    writeNewThreadDraft(storage, createNewThreadDraft({ projectPath: "/other", projectName: "other" }));
    const getWorkspaceInfo = vi.fn(async (cwd?: string) => cwd === "/other"
      ? { root: "/other", isRepo: true, isDirty: false, branch: "main", worktrees: [], refs: [], worktreeParent: "/" }
      : { root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] });
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [
          { path: "/project", name: "project", lastOpenedAt: 2 },
          { path: "/other", name: "other", lastOpenedAt: 1 },
        ], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo,
        getFileTree: async () => [],
      }),
    });

    renderApp(client, { storage, extensions: [workspaceExtension] });
    await screen.findByRole("heading", { name: "What do you want to build?" });
    expect(screen.getByRole("button", { name: "Change project, current project other" })).toBeTruthy();
    expect(document.querySelector(".title-project")?.textContent).toBe("other");
    await waitFor(() => expect(getWorkspaceInfo).toHaveBeenCalledWith("/other"));
    expect(screen.getByRole("button", { name: "main" })).toBeTruthy();
  });

  it("keeps an unsubmitted draft when changing its project from the sidebar", async () => {
    const openProject = vi.fn(async () => ({
      version: 1 as const,
      updates: [
        { version: 1 as const, type: "project" as const, project: { cwd: "/other" } },
        {
          version: 1 as const,
          type: "thread-detail" as const,
          detail: { sessionId: "other-session", messages: [], isStreaming: false, activeTools: [] },
        },
      ],
    }));
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [
          { path: "/project", name: "project", lastOpenedAt: 2 },
          { path: "/other", name: "other", lastOpenedAt: 1 },
        ], sessions: [
          { id: "session", path: "/session.jsonl", title: "Current thread", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 0 },
        ] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async (cwd?: string) => ({ root: cwd ?? "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      openProject,
    });

    renderApp(client, { extensions: [workspaceExtension] });
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    const draftDialog = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(draftDialog).getByRole("option", { name: /project/u }));
    const composer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "discard this draft" } });

    fireEvent.click(await screen.findByRole("button", { name: /All projects/u }));
    const switcher = await screen.findByRole("dialog", { name: "Switch project" });
    fireEvent.click(within(switcher).getByRole("option", { name: /other/u }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Change project, current project other" })).toBeTruthy());
    expect(openProject).not.toHaveBeenCalled();
    expect(composer.value).toBe("discard this draft");
    expect(screen.queryByText(/Project switching is unavailable/u)).toBeNull();
    expect(JSON.parse(getClientStorage()?.get("tau.active-new-thread.v1") ?? "{}")).toMatchObject({ projectPath: "/other", draft: "discard this draft" });
  });

  it("keeps a new-thread draft and attachments when host preflight rejects", async () => {
    let rejectNewSession!: (error: Error) => void;
    const newSession = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectNewSession = reject; }));
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      getPreparedThreadCapability: async (cwd: string) => ({ cwd, generation: 1, supportsImageInput: true }),
      newSession,
    });

    renderApp(client, { extensions: [workspaceExtension] });
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
    await waitFor(() => expect(newSession).toHaveBeenCalledWith(
      "submitted text",
      [expect.objectContaining({ name: "draft.png" })],
      "/project",
      expect.objectContaining({ clientTurnId: expect.any(String), clientMessageId: expect.any(String) }),
      undefined,
    ));

    fireEvent.change(composer, { target: { value: "newer draft" } });
    rejectNewSession(new Error("prompt rejected"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("prompt rejected"));
    // The notice is a toast now, drawn once the stack's chunk has loaded.
    expect(await screen.findByText("Error: prompt rejected")).toBeTruthy();
    expect(composer.value).toBe("submitted text\n\nnewer draft");
    expect(screen.getByRole("button", { name: "Preview draft.png" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    const nextDialog = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(nextDialog).getByRole("option", { name: /project/u }));
    expect(screen.queryByText(/Wait for the current message delivery/u)).toBeNull();
  });

  it("shows the start screen for a new thread even when the previous thread has activity", async () => {
    const client = createFakeHostClient({
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

    renderApp(client, { extensions: [workspaceExtension] });
    await screen.findByText("Existing work");
    fireEvent.click(screen.getByRole("button", { name: "Existing thread" }));
    fireEvent.click(await screen.findByRole("button", { name: "New thread" }));
    const dialog = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(dialog).getByRole("option", { name: /project/u }));

    expect(await screen.findByRole("heading", { name: "What do you want to build?" })).toBeTruthy();
    expect(screen.queryByText("Used 1 tool")).toBeNull();
  });

  it("renders durable turn checkpoints inline and loads their historical diff", async () => {
    const getTurnFileDiff = vi.fn(async () => ({
      path: "src/old.ts",
      added: 1,
      removed: 0,
      hunks: [{ header: "@@ -1 +1 @@", lines: [{ kind: "added" as const, newLine: 1, text: "historical" }] }],
    }));
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: {
          sessionId: "session",
          messages: [
            { id: "prompt", role: "user" as const, text: "Change the historical files", timestamp: 1 },
            { id: "answer", sourceEntryId: "answer-entry", role: "assistant" as const, text: "Finished", timestamp: 2 },
          ],
          isStreaming: false,
          activeTools: [],
        },
        catalog: { models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
        project: { cwd: "/project", branch: "main" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: true, isDirty: false, worktrees: [], refs: [], worktreeParent: "/" }),
        getFileTree: async () => [],
        getTurnFileDiff,
        // The kit lists a thread's checkpoints itself; the transcript only carries the anchor.
        checkpoints: async () => ({
          restoreSupported: false,
          checkpoints: [{
            id: "turn-1",
            turnId: "turn-1",
            sessionId: "session",
            anchorMessageId: "answer-entry",
            beforeSnapshotId: "refs/tau/checkpoints/session/turn-1/before",
            afterSnapshotId: "refs/tau/checkpoints/session/turn-1/after",
            startedAt: 1,
            endedAt: 3,
            files: [{ path: "src/old.ts", name: "old.ts", directory: "src", status: "modified" as const, added: 1, removed: 0 }],
            added: 1,
            removed: 0,
            branch: "main",
          }],
        }),
      }),
    });

    renderApp(client, { extensions: [workspaceExtension] });
    expect(await screen.findByText("Turn changes · 1 changed file")).toBeTruthy();
    expect(document.querySelector(".conversation-files-dock")).toBeNull();
    fireEvent.click(screen.getByText("Open diff"));
    await waitFor(() => expect(getTurnFileDiff).toHaveBeenCalledWith("session", "turn-1", "src/old.ts", { hunkLimit: 40, contextLines: 3 }));
    expect(screen.getByText("Historical turn")).toBeTruthy();
  });

  it("offers restore once the thread that cold-started has run a turn", async () => {
    const checkpoint = {
      id: "turn-1",
      turnId: "turn-1",
      sessionId: "session",
      anchorMessageId: "answer-entry",
      beforeSnapshotId: "refs/tau/checkpoints/session/turn-1/before",
      afterSnapshotId: "refs/tau/checkpoints/session/turn-1/after",
      startedAt: 1,
      endedAt: 3,
      files: [{ path: "note.txt", name: "note.txt", directory: "", status: "added" as const, added: 1, removed: 0 }],
      fileCount: 1,
      added: 1,
      removed: 0,
      branch: "main",
    };
    // A cold start lists the thread before its runtime binds, so the host has
    // nothing to restore from yet and says so.
    const checkpoints = vi.fn(async () => ({
      restoreSupported: checkpoints.mock.calls.length > 1,
      checkpoints: [checkpoint],
    }));
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: {
          sessionId: "session",
          messages: [
            { id: "prompt", role: "user" as const, text: "Write note.txt", timestamp: 1 },
            { id: "answer", sourceEntryId: "answer-entry", role: "assistant" as const, text: "Done", timestamp: 2 },
          ],
          isStreaming: false,
          activeTools: [],
        },
        catalog: { models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
        project: { cwd: "/project", branch: "main" },
      }),
      invokeHostExtension: workspaceHostStub({
        checkpoints,
        canRestoreCheckpoint: async () => true,
      }),
    });

    renderApp(client, { extensions: [workspaceExtension] });
    expect(await screen.findByText("Turn changes · 1 changed file")).toBeTruthy();
    expect(screen.queryByText("Rewind")).toBeNull();

    act(() => {
      client.emit({
        type: "extension-event",
        extensionId: "tau.workspace",
        name: "checkpoint",
        payload: { type: "turn-checkpoint", sessionId: "session", checkpoint },
      });
      client.emit({
        type: "extension-event",
        extensionId: "tau.workspace",
        name: "checkpoint",
        payload: { type: "turn-checkpoint-status", sessionId: "session", turnId: "turn-1", status: "released" },
      });
    });

    expect(await screen.findByText("Rewind")).toBeTruthy();
    expect(checkpoints).toHaveBeenCalledTimes(2);
  });

  it("rewinds the conversation only or the files too, as the dialog is answered", async () => {
    const checkpoint = {
      id: "turn-1",
      turnId: "turn-1",
      sessionId: "session",
      anchorMessageId: "answer-entry",
      beforeSnapshotId: "refs/tau/checkpoints/session/turn-1/before",
      afterSnapshotId: "refs/tau/checkpoints/session/turn-1/after",
      startedAt: 1,
      endedAt: 3,
      files: [{ path: "note.txt", name: "note.txt", directory: "", status: "added" as const, added: 1, removed: 0 }],
      fileCount: 1,
      added: 1,
      removed: 0,
      branch: "main",
    };
    const done = { version: 1 as const, updates: [] };
    const rewindCheckpoint = vi.fn(async () => done);
    const restoreCheckpoint = vi.fn(async () => done);
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: {
          sessionId: "session",
          messages: [
            { id: "prompt", role: "user" as const, text: "Write note.txt", timestamp: 1 },
            { id: "answer", sourceEntryId: "answer-entry", role: "assistant" as const, text: "Done", timestamp: 2 },
          ],
          isStreaming: false,
          activeTools: [],
        },
        catalog: { models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
        project: { cwd: "/project", branch: "main" },
      }),
      invokeHostExtension: workspaceHostStub({
        checkpoints: async () => ({ restoreSupported: true, checkpoints: [checkpoint] }),
        canRestoreCheckpoint: async () => true,
        getRestorePreview: async () => ({ files: checkpoint.files, fileCount: 1, added: 1, removed: 0 }),
        rewindCheckpoint,
        restoreCheckpoint,
      }),
    });

    renderApp(client, { extensions: [workspaceExtension] });
    fireEvent.click(await screen.findByText("Rewind"));
    fireEvent.click(await screen.findByRole("button", { name: "Keep changes" }));
    await waitFor(() => expect(rewindCheckpoint).toHaveBeenCalledWith("session", "turn-1"));
    expect(restoreCheckpoint).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rewind to this checkpoint?" })).toBeNull());

    fireEvent.click(await screen.findByText("Rewind"));
    expect(await screen.findByText("note.txt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revert files too" }));
    await waitFor(() => expect(restoreCheckpoint).toHaveBeenCalledWith("session", "turn-1"));
    expect(rewindCheckpoint).toHaveBeenCalledOnce();
  });

  it("re-asks for restore support when a turn without a checkpoint settles", async () => {
    const checkpoint = {
      id: "turn-1",
      turnId: "turn-1",
      sessionId: "session",
      anchorMessageId: "answer-entry",
      beforeSnapshotId: "refs/tau/checkpoints/session/turn-1/before",
      afterSnapshotId: "refs/tau/checkpoints/session/turn-1/after",
      startedAt: 1,
      endedAt: 3,
      files: [{ path: "note.txt", name: "note.txt", directory: "", status: "added" as const, added: 1, removed: 0 }],
      fileCount: 1,
      added: 1,
      removed: 0,
      branch: "main",
    };
    const checkpoints = vi.fn(async () => ({
      restoreSupported: checkpoints.mock.calls.length > 1,
      checkpoints: [checkpoint],
    }));
    const messages = [
      { id: "prompt", role: "user" as const, text: "Write note.txt", timestamp: 1 },
      { id: "answer", sourceEntryId: "answer-entry", role: "assistant" as const, text: "Done", timestamp: 2 },
    ];
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "session", messages, isStreaming: true, activeTools: [] },
        catalog: { models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
        project: { cwd: "/project", branch: "main" },
      }),
      invokeHostExtension: workspaceHostStub({
        checkpoints,
        canRestoreCheckpoint: async () => true,
      }),
    });

    renderApp(client, { extensions: [workspaceExtension] });
    expect(await screen.findByText("Turn changes · 1 changed file")).toBeTruthy();
    expect(screen.queryByText("Rewind")).toBeNull();

    act(() => client.emit({
      type: "host-update",
      update: {
        version: 1,
        type: "thread-detail",
        detail: { sessionId: "session", messages, isStreaming: false, activeTools: [] },
      },
    }));

    expect(await screen.findByText("Rewind")).toBeTruthy();
  });

  it("verifies the checkpoint of the running turn again once that turn settles", async () => {
    const checkpoint = {
      id: "turn-1",
      turnId: "turn-1",
      sessionId: "session",
      anchorMessageId: "answer-entry",
      beforeSnapshotId: "refs/tau/checkpoints/session/turn-1/before",
      afterSnapshotId: "refs/tau/checkpoints/session/turn-1/after",
      startedAt: 1,
      endedAt: 3,
      files: [{ path: "note.txt", name: "note.txt", directory: "", status: "added" as const, added: 1, removed: 0 }],
      fileCount: 1,
      added: 1,
      removed: 0,
      branch: "main",
    };
    const messages = [
      { id: "prompt", role: "user" as const, text: "Write note.txt", timestamp: 1 },
      { id: "answer", sourceEntryId: "answer-entry", role: "assistant" as const, text: "Done", timestamp: 2 },
    ];
    // The host refuses to verify a checkpoint while its own thread still runs.
    let running = true;
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "session", messages, isStreaming: true, activeTools: [] },
        catalog: { models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
        project: { cwd: "/project", branch: "main" },
      }),
      invokeHostExtension: workspaceHostStub({
        checkpoints: async () => ({ restoreSupported: true, checkpoints: [] }),
        canRestoreCheckpoint: async () => !running,
      }),
    });

    renderApp(client, { extensions: [workspaceExtension] });
    // The kit subscribes to the event when it activates; wait for its own surface first.
    await screen.findByRole("button", { name: "Files" });
    act(() => client.emit({
      type: "extension-event",
      extensionId: "tau.workspace",
      name: "checkpoint",
      payload: { type: "turn-checkpoint", sessionId: "session", checkpoint },
    }));
    expect(await screen.findByText("Turn changes · 1 changed file")).toBeTruthy();
    expect(screen.queryByText("Rewind")).toBeNull();

    act(() => client.emit({
      type: "host-update",
      update: {
        version: 1,
        type: "thread-detail",
        detail: { sessionId: "session", messages, isStreaming: false, activeTools: [] },
      },
    }));
    expect(screen.queryByText("Rewind")).toBeNull();

    // Its capture lets go only after that: the host says so on the same channel.
    running = false;
    act(() => client.emit({
      type: "extension-event",
      extensionId: "tau.workspace",
      name: "checkpoint",
      payload: { type: "turn-checkpoint-status", sessionId: "session", turnId: "turn-1", status: "released" },
    }));

    expect(await screen.findByText("Rewind")).toBeTruthy();
  });

  it("keeps a new thread anchored on its prompt while the first answer streams", async () => {
    const shell = {
      id: "created",
      path: "/created.jsonl",
      title: "Untitled thread",
      modifiedAt: 2,
      projectPath: "/project",
      projectName: "project",
      messageCount: 1,
    };
    const newSession = vi.fn(async (...args: unknown[]) => {
      const identity = args[3] as { clientTurnId: string; clientMessageId: string };
      return {
        version: 1 as const,
        updates: [
          { version: 1 as const, type: "thread-shell" as const, update: { sessionId: "created", shell } },
          {
            version: 1 as const,
            type: "thread-detail" as const,
            detail: {
              sessionId: "created",
              messages: [
                { id: "user", clientTurnId: identity.clientTurnId, clientMessageId: identity.clientMessageId, role: "user" as const, text: "Count slowly", timestamp: 1 },
              ],
              isStreaming: true,
              activeTools: [],
            },
          },
        ],
        submission: { accepted: true as const },
      };
    });
    const getWorkspaceInfo = vi.fn(async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }));
    const client = createFakeHostClient({
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
          allTools: [],
          extensionCount: 0,
          supportsImageInput: true,
        },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo,
        getFileTree: async () => [],
      }, { "tau.thread-titles": async () => undefined }),
      newSession,
    });

    renderApp(client, { extensions: [workspaceExtension] });
    await screen.findByRole("heading", { name: "What do you want to build?" });
    await waitFor(() => expect(getWorkspaceInfo).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    const dialog = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(dialog).getByRole("option"));
    const composer = screen.getByPlaceholderText(/Direct the agent/u);
    fireEvent.change(composer, { target: { value: "Count slowly" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalled());
    const transcript = await screen.findByRole("log");
    await waitFor(() => expect(transcript.querySelector('[data-message-id="user"]')).toBeTruthy());
    // The answer is far taller than the viewport: a tail pin would land at 4500.
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, get: () => 5_000 },
      clientHeight: { configurable: true, get: () => 500 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    act(() => client.emit({ type: "assistant-start", sessionId: "created", id: "assistant-live", timestamp: 2 }));
    for (let index = 0; index < 5; index += 1) {
      act(() => client.emit({ type: "assistant-delta", sessionId: "created", id: "assistant-live", delta: `line ${index}\n` }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await waitFor(() => expect(transcript.querySelector('[data-message-id="assistant-live"]')).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Anchored on the prompt row near the top, never pulled down to the tail.
    expect(transcript.scrollTop).toBeLessThan(1_000);
  });

  it("promotes and settles an extension command that creates no user turn", async () => {
    let clientMessageId: string | undefined;
    const newSession = vi.fn(async (...args: unknown[]) => {
      clientMessageId = (args[3] as { clientMessageId?: string }).clientMessageId;
      return {
        version: 1 as const,
        updates: [] as never[],
        sessionId: "extension-session",
        submission: { accepted: true as const },
      };
    });
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "old", messages: [], isStreaming: false, activeTools: [] },
        catalog: {
          sessionId: "old",
          models: [{ provider: "provider", id: "model", name: "Model" }],
          model: { provider: "provider", id: "model", name: "Model" },
          thinkingLevel: "off",
          thinkingLevels: ["off"],
          allTools: [],
          extensionCount: 1,
          supportsImageInput: true,
        },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [{ id: "code", name: "VS Code" }],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      newSession,
    });

    renderApp(client, { extensions: [workspaceExtension] });
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Search projects" })).getByRole("option"));
    const composer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "/extension-command" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(newSession).toHaveBeenCalled());
    if (!clientMessageId) throw new Error("newSession did not receive a client message id");
    // The draft already names its project, so opening that folder stays available while allocation settles.
    expect(screen.getByRole("button", { name: "Open" }).hasAttribute("disabled")).toBe(false);

    // The host reports the missing user turn from prompt(), then commits the
    // detached delivery. Both arrive in that order over one channel.
    client.emit({ type: "prompt-without-user-turn", sessionId: "extension-session", clientMessageId });
    client.emit({
      type: "new-thread-delivery-settled",
      sessionId: "extension-session",
      clientMessageId,
      accepted: true,
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Open" }).hasAttribute("disabled")).toBe(false));
    expect(getClientStorage()?.get("tau.active-new-thread.v1")).toBeNull();
    // No user turn was persisted, so the optimistic prompt must not linger.
    expect(screen.queryByText("/extension-command")).toBeNull();
  });

  it("promotes a draft from its correlated user message before the IPC result", async () => {
    let resolveNewSession!: (result: { version: 1; updates: never[]; submission: { accepted: true } }) => void;
    let identity: { clientMessageId: string; newThreadRequestId?: string } | undefined;
    // Core's own contract, not a kit's: the prompt hook fires once, for the
    // thread the submission created.
    const afterPrompt = vi.fn();
    const promptHook: DesktopExtension = {
      id: "test.prompt-hook",
      name: "Prompt hook",
      activate(context) { context.registerPromptHook({ id: "test.after-prompt", afterPrompt }); },
    };
    const newSession = vi.fn((...args: unknown[]) => {
      identity = args[3] as typeof identity;
      return new Promise<{ version: 1; updates: never[]; submission: { accepted: true } }>((resolve) => { resolveNewSession = resolve; });
    });
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }, { path: "/other", name: "other", lastOpenedAt: 0 }], sessions: [] },
        detail: { sessionId: "old", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "old", models: [{ provider: "provider", id: "model", name: "Model" }], model: { provider: "provider", id: "model", name: "Model" }, thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [{ id: "code", name: "VS Code" }],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      newSession,
    });

    renderApp(client, { extensions: [workspaceExtension, promptHook] });
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Search projects" })).getByRole("option", { name: /project/u }));
    const composer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "start in the detached runtime" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalled());
    if (!identity?.clientMessageId) throw new Error("newSession did not receive a client identity");

    client.emit({
      type: "host-update",
      update: {
        version: 1,
        type: "thread-detail",
        detail: { sessionId: "created", messages: [], isStreaming: true, activeTools: [], requestId: identity.newThreadRequestId as never },
      },
    });
    client.emit({
      type: "user-message",
      sessionId: "created",
      message: { id: "persisted", clientMessageId: identity.clientMessageId, role: "user", text: "start in the detached runtime", timestamp: Date.now() },
    });
    await waitFor(() => expect(afterPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "start in the detached runtime", snapshot: expect.objectContaining({ sessionId: "created" }) }),
      expect.anything(),
    ));
    expect(afterPrompt).toHaveBeenCalledOnce();

    await waitFor(() => expect(screen.queryByRole("heading", { name: "What do you want to build?" })).toBeNull());
    expect(screen.getAllByText("start in the detached runtime").length).toBeGreaterThan(0);
    // The persisted prompt is the delivery commit. The agent run continues, but
    // the draft no longer holds the workspace or thread navigation.
    await waitFor(() => expect(screen.getByRole("button", { name: "Open" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /Untitled thread/u }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New thread" }));
    const picker = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(picker).getByRole("option", { name: /other/u }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search projects" })).toBeNull());
    resolveNewSession({ version: 1, updates: [], submission: { accepted: true } });
    await waitFor(() => expect(newSession).toHaveBeenCalledOnce());
    // A settled record cannot be reopened by the runtime's late reports.
    client.emit({ type: "user-message-failed", sessionId: "created", clientMessageId: identity.clientMessageId, message: "late failure" });
    expect(screen.queryByText("late failure")).toBeNull();
    expect(afterPrompt).toHaveBeenCalledOnce();
  });

  it("promotes a bridge draft whose persisted prompt text was expanded", async () => {
    let requestId: string | undefined;
    const newSession = vi.fn(async (...args: unknown[]): Promise<NewThreadResult> => {
      requestId = (args[3] as { newThreadRequestId?: string }).newThreadRequestId;
      return {
        version: 1 as const,
        updates: [] as never[],
        requestId: requestId ? createNewThreadRequestId(requestId) : undefined,
        submission: { accepted: true as const },
      };
    });
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "old", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "old", models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [{ id: "code", name: "VS Code" }],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      newSession,
    });

    renderApp(client, { extensions: [workspaceExtension] });
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Search projects" })).getByRole("option"));
    const composer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "/skill review" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalledOnce());
    if (!requestId) throw new Error("newSession did not receive a new-thread request id");

    // Skill expansion changes what the runtime persists; only the request id
    // and the client identity may decide this promotion.
    client.emit({
      type: "host-update",
      update: {
        version: 1,
        type: "thread-detail",
        detail: {
          sessionId: "bridge-created",
          requestId: createNewThreadRequestId(requestId),
          messages: [{ id: "bridge-user", role: "user", text: "Run the review skill against the working tree.", timestamp: Date.now() }],
          isStreaming: true,
          activeTools: [],
        },
      },
    });

    await waitFor(() => expect(screen.queryByRole("heading", { name: "What do you want to build?" })).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Open" }).hasAttribute("disabled")).toBe(false));
    expect(getClientStorage()?.get("tau.active-new-thread.v1")).toBeNull();
  });

  it("does not send a prompt to the previous thread while a worktree is opening", async () => {
    // The kit creates the worktree, then opens it like any project; the composer stays held across both.
    let resolveCreation!: (result: { workspaceId: string; displayPath: string }) => void;
    const creation = new Promise<{ workspaceId: string; displayPath: string }>((resolve) => { resolveCreation = resolve; });
    const sendPrompt = vi.fn(async () => undefined);
    let cwd = "/project";
    const openProject = vi.fn(async (path: string): Promise<HostActionResult> => {
      cwd = path;
      return {
        version: 1,
        updates: [
          { version: 1, type: "thread-shell", update: { sessionId: "worktree-thread", shell: { id: "worktree-thread", path: "/worktree.jsonl", title: "Untitled thread", modifiedAt: 2, projectPath: cwd, projectName: "project", messageCount: 0 } } },
          { version: 1, type: "thread-detail", detail: { sessionId: "worktree-thread", messages: [], isStreaming: false, activeTools: [] } },
          { version: 1, type: "project", project: { cwd } },
        ],
      };
    });
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: { sessionId: "main-thread", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "main-thread", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd, branch: "main" },
      }),
      invokeHostExtension: workspaceHostStub({
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
        createWorktree: async () => creation,
      }),
      openProject,
      sendPrompt,
    });

    renderApp(client, { extensions: [workspaceExtension] });
    fireEvent.click(await screen.findByRole("button", { name: "Current checkout" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search worktrees" }), { target: { value: "feat/race" } });
    fireEvent.click(screen.getByRole("option", { name: /Create worktree “feat\/race”/u }));

    const composer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Must run in the worktree" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(composer.value).toBe("Must run in the worktree");

    resolveCreation({ workspaceId: "ws1_feat-race", displayPath: "/project-worktrees/feat-race" });

    await waitFor(() => expect(openProject).toHaveBeenCalledWith("ws1_feat-race"));
    await waitFor(() => expect(screen.getByRole("button", { name: "feat-race" })).toBeTruthy());
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith(
      "Must run in the worktree",
      [],
      "worktree-thread",
      expect.objectContaining({ clientTurnId: expect.any(String), clientMessageId: expect.any(String) }),
      undefined,
    ));
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
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo,
        getFileTree: async () => [],
      }),
      openProject: async (path: string) => {
        cwd = path;
        return {
          version: 1,
          updates: [{ version: 1, type: "project", project: { cwd, branch: "feat/worktree-label" } }],
        };
      },
    });

    renderApp(client, { extensions: [workspaceExtension] });
    fireEvent.click(await screen.findByRole("button", { name: "Current checkout" }));
    fireEvent.click(screen.getByRole("option", { name: /feat\/worktree-label/u }));

    expect(await screen.findByRole("button", { name: "feat-worktree-label" })).toBeTruthy();
    expect(getWorkspaceInfo).toHaveBeenLastCalledWith();
  });

  it("leaves out the branch each project names as its default, and shows main where it is not", async () => {
    const thread = (id: string, projectPath: string, projectLabel: string) => ({
      id, path: `/sessions/${id}.jsonl`, title: id, modifiedAt: 1, projectPath, projectName: projectPath.slice(1), projectLabel, messageCount: 1,
    });
    const sessions = [thread("on-trunk", "/trunk", "trunk"), thread("main-on-trunk", "/trunk", "main"), thread("on-main", "/classic", "main")];
    const getDefaultBranch = vi.fn(async (workspace?: string) => workspace === "/trunk" ? "trunk" : "main");
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: {
          projects: [{ path: "/trunk", name: "trunk", lastOpenedAt: 2 }, { path: "/classic", name: "classic", lastOpenedAt: 1 }],
          sessions,
        },
        detail: { sessionId: "on-trunk", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "on-trunk", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/trunk" },
      }),
      invokeHostExtension: workspaceHostStub({ getDefaultBranch }),
    });
    // A labelled section draws full rows without the virtual list jsdom cannot measure.
    const organizing: DesktopExtension = {
      id: "test.organizer",
      name: "Organizer",
      activate: (context) => context.useService<WorkspaceStoreApi>(WORKSPACE_STORE_SERVICE, (store) => store.registerThreadRailOrganizer({
        subscribe: () => () => undefined,
        getVersion: () => 1,
        sections: (threads) => [{ id: "active", threads: [] }, { id: "all", label: "All", threads: [...threads] }],
        menu: () => [],
        runMenu: () => undefined,
        toggleSettled: () => undefined,
        dropLabel: () => undefined,
        drop: () => undefined,
      })),
    };
    renderApp(client, { extensions: [workspaceExtension, organizing] });

    const branchOf = (title: string) => screen.getByText(title).closest(".thread-row")?.querySelector(".thread-branch")?.textContent ?? null;
    await screen.findByText("on-main");
    await waitFor(() => expect(branchOf("main-on-trunk")).toBe("main"));
    expect(branchOf("on-trunk")).toBeNull();
    expect(branchOf("on-main")).toBeNull();
    // Once per project, however many rows it has.
    expect(getDefaultBranch.mock.calls.map(([workspace]) => workspace).sort()).toEqual(["/classic", "/trunk"]);
  });
});

describe("the turn changes dock", () => {
  it("keeps changed files in the fixed dock outside the scrolling transcript", async () => {
    const storage = createMemoryStorage();
    // The kit's own baseline key: an empty baseline means every change belongs to this turn.
    storage.set("tau.workspace.turn-baseline.v1", JSON.stringify({ session: { files: [], added: 0, removed: 0 } }));
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: {
          projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }],
          sessions: [{ id: "session", path: "/session.jsonl", title: "Thread", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 0 }],
        },
        detail: { sessionId: "session", messages: [{ id: "user", role: "user" as const, text: "Change the files", timestamp: 1 }], isStreaming: true, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({ getChanges: async () => ({
        files: [{ path: "src/App.tsx", name: "App.tsx", directory: "src", status: "modified", added: 4, removed: 1 }],
        added: 4,
        removed: 1,
      }) }),
    });
    setHostClient(client);

    const view = renderApp(client, { storage, extensions: [workspaceExtension] });
    await screen.findByText("1 changed file");

    const dock = view.container.querySelector(".conversation-files-dock");
    expect(dock?.textContent).toContain("App.tsx");
    expect(view.container.querySelector(".transcript")?.contains(dock)).toBe(false);
  });

  it("hands the dock over to the checkpoint card instead of drawing both", async () => {
    const storage = createMemoryStorage();
    storage.set("tau.workspace.turn-baseline.v1", JSON.stringify({ session: { files: [], added: 0, removed: 0 } }));
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: {
          projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }],
          sessions: [{ id: "session", path: "/session.jsonl", title: "Thread", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 0 }],
        },
        detail: { sessionId: "session", messages: [{ id: "user", role: "user" as const, text: "Change the files", timestamp: 1 }], isStreaming: true, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({ getChanges: async () => ({
        files: [{ path: "src/App.tsx", name: "App.tsx", directory: "src", status: "modified", added: 4, removed: 1 }],
        added: 4,
        removed: 1,
      }) }),
    });
    setHostClient(client);

    const view = renderApp(client, { storage, extensions: [workspaceExtension] });
    await screen.findByText("1 changed file");
    expect(view.container.querySelector(".conversation-files-dock")).not.toBeNull();

    // The turn ends and its immutable checkpoint lands as a transcript card: the
    // dock was the live preview for exactly that turn, so it must not reappear.
    act(() => client.emit({ type: "agent-status", sessionId: "session", running: false }));
    expect(view.container.querySelector(".conversation-files-dock")).toBeNull();
    act(() => client.emit({
      type: "extension-event",
      extensionId: "tau.workspace",
      name: "checkpoint",
      payload: { type: "turn-checkpoint", sessionId: "session", checkpoint: {
        id: "turn-1", turnId: "turn-1", sessionId: "session", anchorMessageId: "user",
        beforeSnapshotId: "before", afterSnapshotId: "after", startedAt: 1, endedAt: 3,
        files: [{ path: "src/App.tsx", name: "App.tsx", directory: "src", status: "modified" as const, added: 4, removed: 1 }],
        fileCount: 1, added: 4, removed: 1, branch: "main",
      } },
    }));

    expect(await screen.findByText(/Turn changes/u)).toBeTruthy();
    expect(view.container.querySelector(".conversation-files-dock")).toBeNull();
  });
});
