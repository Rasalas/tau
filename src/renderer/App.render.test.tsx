// @vitest-environment jsdom
import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNewThreadRequestId, type HostEvent } from "../shared/contracts";
import { workspaceHostStub } from "./test-support/workspace-host-stub";

const messageRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./components/Message", () => ({
  Message: ({ message, onCopy }: { message: { text: string }; onCopy?: (message: { text: string }) => void }) => {
    messageRenders.count += 1;
    return <div>{message.text}{onCopy ? <button type="button" onClick={() => onCopy(message)}>copy message</button> : null}</div>;
  },
}));

import App, { ComposerHost, isCurrentTranscriptSubmission, latestActivityAnchor, measureComposerGeometry, mergeNewThreadRecoveryAttachments, mergeNewThreadRecoveryDraft, MountedPanel, optimisticThreadSnapshot, reconcileOptimisticMessages } from "./App";
import { createNewThreadDraft, writeNewThreadDraft } from "./draft-store";
import { mergeTranscriptMessages, restoreTranscriptScrollAnchor } from "./transcript-history";
import { asHostTranscriptCursor } from "../shared/transcript-cursor";

afterEach(cleanup);

describe("App render isolation", () => {
  beforeEach(() => {
    messageRenders.count = 0;
    localStorage.clear();
    delete window.tau;
  });

  it("merges detached draft recovery ahead of newer composer input", () => {
    expect(mergeNewThreadRecoveryDraft("failed prompt", "next prompt")).toBe("failed prompt\n\nnext prompt");
    expect(mergeNewThreadRecoveryDraft("failed prompt", "")).toBe("failed prompt");
    expect(mergeNewThreadRecoveryDraft("failed prompt", "failed prompt")).toBe("failed prompt");
    const recovered = { id: 1, kind: "image" as const, name: "old.png", mimeType: "image/png", data: "old", size: 3, previewUrl: "data:image/png;base64,old" };
    const newer = { id: 2, kind: "image" as const, name: "new.png", mimeType: "image/png", data: "new", size: 3, previewUrl: "data:image/png;base64,new" };
    expect(mergeNewThreadRecoveryAttachments([recovered], [newer])).toEqual([recovered, newer]);
    expect(mergeNewThreadRecoveryAttachments([recovered], [{ ...recovered, id: 7 }])).toEqual([recovered]);
  });

  it("rejects a late old-draft failure before it can restore current composer UI", () => {
    const oldSubmission = {
      turnId: "old-turn",
      scopeKey: "project:/project\u0000thread:draft-old",
      scope: { kind: "draft" as const, projectPath: "/project", draftId: "draft-old" },
      draftId: "draft-old",
    };
    const currentSubmission = {
      turnId: "current-turn",
      scopeKey: "project:/project\u0000thread:draft-current",
      scope: { kind: "draft" as const, projectPath: "/project", draftId: "draft-current" },
      draftId: "draft-current",
    };

    expect(isCurrentTranscriptSubmission(
      { ...currentSubmission, text: "current" },
      currentSubmission.scopeKey,
      currentSubmission.draftId,
      oldSubmission,
    )).toBe(false);
    expect(isCurrentTranscriptSubmission(
      { ...oldSubmission, text: "old" },
      oldSubmission.scopeKey,
      oldSubmission.draftId,
      oldSubmission,
    )).toBe(true);
  });

  it("keeps optimistic user messages until a matching Pi message arrives", () => {
    const pending = [{ scope: "session", message: { id: "local", role: "user" as const, text: "hello", timestamp: 100_000 } }];
    expect(reconcileOptimisticMessages(pending, [{ id: "old", role: "user", text: "hello", timestamp: 1 }])).toEqual(pending);
    expect(reconcileOptimisticMessages(pending, [{ id: "wrong", clientMessageId: "request-2", role: "user", text: "hello", timestamp: 100_001 }])).toEqual(pending);
    expect(reconcileOptimisticMessages(pending, [{ id: "saved", role: "user", text: "hello", timestamp: 100_001 }])).toEqual([]);

    const pendingSkill = [{ scope: "session", message: { id: "local-skill", clientTurnId: "turn-skill", clientMessageId: "skill-request", role: "user" as const, text: "$tdd hello", timestamp: 100_000 } }];
    expect(reconcileOptimisticMessages(pendingSkill, [{
      id: "saved-skill",
      clientTurnId: "turn-skill",
      clientMessageId: "skill-request",
      role: "user",
      text: "hello",
      skill: { name: "tdd", command: "/skill:tdd", copyText: "/skill:tdd hello" },
      timestamp: 100_001,
    }])).toEqual([]);

    const twoPending = [
      { scope: "session", message: { id: "local-a", clientTurnId: "turn-a", clientMessageId: "request-a", role: "user" as const, text: "same", timestamp: 1 } },
      { scope: "session", message: { id: "local-b", clientTurnId: "turn-b", clientMessageId: "request-b", role: "user" as const, text: "same", timestamp: 2 } },
    ];
    expect(reconcileOptimisticMessages(twoPending, [
      { id: "saved-b", clientTurnId: "turn-b", clientMessageId: "request-b", role: "user", text: "same", timestamp: 2 },
    ])).toEqual([twoPending[0]]);
    expect(reconcileOptimisticMessages(twoPending, [
      { id: "saved-b", clientTurnId: "turn-b", clientMessageId: "request-b", role: "user", text: "same", timestamp: 2 },
      { id: "saved-a", clientTurnId: "turn-a", clientMessageId: "request-a", role: "user", text: "same", timestamp: 1 },
    ])).toEqual([]);
  });

  it("does not reconcile through text when Pi supplies a mismatched explicit identity", () => {
    const pending = [{ scope: "session", message: {
      id: "local",
      clientTurnId: "turn-local",
      clientMessageId: "message-local",
      role: "user" as const,
      text: "hello",
      timestamp: 100_000,
    } }];
    expect(reconcileOptimisticMessages(pending, [{
      id: "saved",
      clientTurnId: "turn-other",
      clientMessageId: "message-other",
      role: "user",
      text: "hello",
      timestamp: 100_001,
    }])).toEqual(pending);
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

  it("deduplicates a repeated history page while retaining newer message updates", () => {
    const current = [
      { id: "user-2", role: "user" as const, text: "second", timestamp: 2 },
      { id: "answer-2", role: "assistant" as const, text: "old answer", timestamp: 3 },
    ];
    const page = [
      { id: "user-1", role: "user" as const, text: "first", timestamp: 1 },
      { id: "user-2", role: "user" as const, text: "second", timestamp: 2 },
      { id: "answer-2", role: "assistant" as const, text: "updated answer", timestamp: 3 },
    ];
    expect(mergeTranscriptMessages(current, page, "prepend")).toEqual([
      page[0], page[1], page[2],
    ]);
    expect(mergeTranscriptMessages([], [page[0], { ...page[0], text: "latest" }], "prepend")).toEqual([
      { ...page[0], text: "latest" },
    ]);
  });

  it("restores the viewport offset from a stable row after long variable rows are prepended", () => {
    let anchorTop = 280;
    const row = {
      dataset: { messageId: "stable" },
      getBoundingClientRect: () => ({ top: anchorTop, bottom: anchorTop + 420 }),
    };
    const node = {
      scrollTop: 340,
      getBoundingClientRect: () => ({ top: 100, bottom: 700 }),
      querySelectorAll: () => [row],
    } as unknown as HTMLDivElement;
    const anchor = { messageId: "stable", viewportOffset: 180 };
    anchorTop += 2_680;
    const result = restoreTranscriptScrollAnchor(node, anchor);
    expect(result.delta).toBe(2_680);
    expect(node.scrollTop).toBe(3_020);
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
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: () => () => {},
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree,
      }),
    } as unknown as typeof window.tau;
    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    expect(getFileTree).not.toHaveBeenCalled();
  });

  it("keeps the virtual thread canvas from shrinking inside the scroll rail", async () => {
    render(<App />);
    const navigation = await screen.findByRole("navigation", { name: "Threads" });
    const canvas = navigation.firstElementChild as HTMLElement;
    expect(canvas.style.flexShrink).toBe("0");
  });

  it("uses a focused start screen until the first message is sent", async () => {
    const sendPrompt = vi.fn(async () => undefined);
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: () => () => {},
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
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

    await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith(
      "Build the first screen",
      [],
      "session",
      expect.objectContaining({ clientTurnId: expect.any(String), clientMessageId: expect.any(String) }),
      undefined,
    ));
    expect(screen.queryByRole("heading", { name: "What do you want to build?" })).toBeNull();
    expect(screen.getByRole("button", { name: "Untitled thread" })).toBeTruthy();
    expect(screen.getAllByText("Build the first screen").find((element) => element.tagName === "DIV")).toBeTruthy();
    const prompt = screen.getByText("Build the first screen");
    expect(prompt.closest(".transcript-current-row")).toBeTruthy();
    expect(screen.getByRole("log").querySelector('.virtual-transcript [data-message-id^="local-"]')).toBeTruthy();
  });

  it("keeps the same focused composer mounted while the first prompt docks", async () => {
    const sendPrompt = vi.fn(async () => undefined);
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: () => () => {},
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      sendPrompt,
    } as unknown as typeof window.tau;

    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    const composer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    composer.focus();
    fireEvent.change(composer, { target: { value: "dock this prompt\nwith a second line" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("heading", { name: "What do you want to build?" })).toBeNull());
    expect(screen.getByPlaceholderText(/Direct the agent/u)).toBe(composer);
    expect(document.activeElement).toBe(composer);
    expect(composer.closest(".conversation-composer-host")?.classList.contains("docked")).toBe(true);
  });

  it("starts a fresh draft while an earlier real-thread submission is pending", async () => {
    let resolveOld!: () => void;
    const sendPrompt = vi.fn(() => new Promise<void>((resolve) => { resolveOld = resolve; }));
    const newSession = vi.fn(async () => ({
      version: 1 as const,
      updates: [{
        version: 1 as const,
        type: "thread-detail" as const,
        detail: {
          sessionId: "new-session",
          messages: [{ id: "new-prompt", role: "user" as const, text: "new draft", timestamp: Date.now() }],
          isStreaming: false,
          activeTools: [],
        },
      }],
      submission: { accepted: true as const },
    }));
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [
          { path: "/project", name: "project", lastOpenedAt: 2 },
          { path: "/other", name: "other", lastOpenedAt: 1 },
        ], sessions: [{ id: "session", path: "/session.jsonl", title: "Existing thread", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 0 }] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: () => () => {},
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      sendPrompt,
      newSession,
    } as unknown as typeof window.tau;

    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    const oldComposer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(oldComposer, { target: { value: "old in-flight prompt" } });
    fireEvent.keyDown(oldComposer, { key: "Enter" });
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Existing thread" }));
    fireEvent.click(await screen.findByText("New thread"));
    const picker = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(picker).getByRole("option", { name: /other/u }));
    const draftComposer = await screen.findByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    expect(draftComposer.value).toBe("");
    fireEvent.change(draftComposer, { target: { value: "new draft" } });
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);

    fireEvent.keyDown(draftComposer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalledWith(
      "new draft",
      [],
      "/other",
      expect.objectContaining({ clientTurnId: expect.any(String), clientMessageId: expect.any(String) }),
      undefined,
    ));
    await waitFor(() => expect(screen.getByText("new draft")).toBeTruthy());
    await waitFor(() => expect(draftComposer.value).toBe(""));
    resolveOld();
  });

  it("keeps restored draft chrome scoped to its pending project", async () => {
    writeNewThreadDraft(localStorage, createNewThreadDraft({ projectPath: "/other", projectName: "other" }));
    const getWorkspaceInfo = vi.fn(async (cwd?: string) => cwd === "/other"
      ? { root: "/other", isRepo: true, isDirty: false, branch: "main", worktrees: [], refs: [], worktreeParent: "/" }
      : { root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] });
    window.tau = {
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
      onHostEvent: () => () => {},
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo,
        getFileTree: async () => [],
      }),
    } as unknown as typeof window.tau;

    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    expect(screen.getByRole("button", { name: "Change project, current project other" })).toBeTruthy();
    expect(document.querySelector(".title-identity strong")?.textContent).toBe("other");
    await waitFor(() => expect(getWorkspaceInfo).toHaveBeenCalledWith("/other"));
    expect(screen.getByRole("button", { name: "main" })).toBeTruthy();
  });

  it("uses the visible composer surface for a dynamic dock geometry", () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const originalRaf = window.requestAnimationFrame;
    const originalCancelRaf = window.cancelAnimationFrame;
    const callbacks: FrameRequestCallback[] = [];
    let startSurfaceHeight = 180;
    const dockedSurfaceHeight = 240;
    let showHint = false;
    const rect = (left: number, top: number, width: number, height: number) => ({
      x: left,
      y: top,
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      toJSON: () => ({}),
    }) as DOMRect;

    HTMLElement.prototype.getBoundingClientRect = function () {
      const isStart = this.closest(".conversation-composer-host")?.classList.contains("start") ?? true;
      if (this.matches("[data-composer-surface]")) {
        return isStart
          ? rect(110, showHint ? 160 : 240, 780, startSurfaceHeight)
          : rect(110, 500, 780, dockedSurfaceHeight);
      }
      if (this.classList.contains("conversation-composer-host")) {
        return isStart ? rect(70, 100, 900, 300) : rect(0, 480, 1000, 260);
      }
      return originalRect.call(this);
    };
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = (() => undefined) as typeof window.cancelAnimationFrame;

    const surface = () => (
      <div data-composer-surface="true">
        <textarea autoFocus defaultValue="draft" />
        {showHint ? <small>Current project hint</small> : null}
      </div>
    );
    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(<ComposerHost start>{surface()}</ComposerHost>);
      const composer = screen.getByRole("textbox");
      composer.focus();
      expect(measureComposerGeometry(composer.closest(".conversation-composer-host")!)).toMatchObject({ left: 110, width: 780, height: 180 });

      showHint = true;
      startSurfaceHeight = 280;
      view.rerender(<ComposerHost start>{surface()}</ComposerHost>);
      expect(measureComposerGeometry(composer.closest(".conversation-composer-host")!)).toMatchObject({ left: 110, top: 160, height: 280 });

      view.rerender(<ComposerHost start={false}>{surface()}</ComposerHost>);
      const host = composer.closest(".conversation-composer-host") as HTMLDivElement;
      expect(host.style.transform).toBe("translate3d(0px, -340px, 0)");
      expect(host.style.transform).not.toContain("-70px");
      expect(screen.getByRole("textbox")).toBe(composer);
      expect(document.activeElement).toBe(composer);
      callbacks[0]?.(performance.now());
      expect(host.style.transform).toBe("translate3d(0, 0, 0)");
    } finally {
      view?.unmount();
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      window.requestAnimationFrame = originalRaf;
      window.cancelAnimationFrame = originalCancelRaf;
    }
  });

  it("carries a draft and supported attachments across a pre-send project switch", async () => {
    const newSession = vi.fn(async () => ({ version: 1 as const, updates: [] as never[], submission: { accepted: true as const } }));
    const getPreparedThreadCapability = vi.fn(async (cwd: string) => ({ cwd, generation: 1, supportsImageInput: true }));
    window.tau = {
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
      onHostEvent: () => () => {},
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      getPreparedThreadCapability,
      newSession,
    } as unknown as typeof window.tau;

    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    const firstDialog = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(firstDialog).getByRole("option", { name: /project/u }));
    await waitFor(() => expect(getPreparedThreadCapability).toHaveBeenCalledWith("/project"));

    const composer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "carry this draft" } });
    const attachment = new File([new Uint8Array([137, 80, 78, 71])], "carry.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Choose attachment files"), { target: { files: [attachment] } });
    await screen.findByRole("button", { name: "Preview carry.png" });

    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    const secondDialog = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(secondDialog).getByRole("option", { name: /other/u }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Change project, current project other" })).toBeTruthy());
    expect(composer.value).toBe("carry this draft");
    expect(screen.getByRole("button", { name: "Preview carry.png" })).toBeTruthy();

    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalledWith(
      "carry this draft",
      [expect.objectContaining({ name: "carry.png" })],
      "/other",
      expect.objectContaining({ clientTurnId: expect.any(String), clientMessageId: expect.any(String) }),
      undefined,
    ));
  });

  it("keeps an in-flight history load when a same-thread action returns detail", async () => {
    let resolvePage!: (page: {
      sessionId: string;
      messages: Array<{ id: string; role: "user" | "assistant"; text: string; timestamp: number }>;
      hasMore: boolean;
    }) => void;
    const loadTranscript = vi.fn(() => new Promise((resolve) => { resolvePage = resolve; }));
    const setModel = vi.fn(async () => ({
      version: 1 as const,
      updates: [{
        version: 1 as const,
        type: "thread-detail" as const,
        detail: {
          sessionId: "session",
          messages: [
            { id: "new", role: "user" as const, text: "new request", timestamp: 1 },
            { id: "reply", role: "assistant" as const, text: "current reply", timestamp: 2 },
          ],
          olderCursor: asHostTranscriptCursor("opaque:2"),
          hasMore: true,
          isStreaming: false,
          activeTools: [],
        },
      }],
    }));
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: {
          sessionId: "session",
          messages: [
            { id: "new", role: "user" as const, text: "new request", timestamp: 1 },
            { id: "reply", role: "assistant" as const, text: "current reply", timestamp: 2 },
          ],
          olderCursor: asHostTranscriptCursor("opaque:2"),
          hasMore: true,
          isStreaming: false,
          activeTools: [],
        },
        catalog: {
          models: [
            { provider: "provider", id: "current", name: "Current model" },
            { provider: "provider", id: "next", name: "Next model" },
          ],
          model: { provider: "provider", id: "current", name: "Current model" },
          thinkingLevel: "off",
          thinkingLevels: ["off"],
          allTools: [],
          extensionCount: 0,
        },
        project: { cwd: "/project" },
      }),
      onHostEvent: () => () => {},
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      loadTranscript,
      setModel,
    } as unknown as typeof window.tau;

    render(<App />);
    await screen.findByText("current reply");
    fireEvent.click(screen.getByRole("button", { name: "Load older turns" }));
    await waitFor(() => expect(loadTranscript).toHaveBeenCalledWith("session", asHostTranscriptCursor("opaque:2")));

    fireEvent.click(screen.getByRole("button", { name: /Current model/u }));
    const modelPicker = await screen.findByRole("dialog", { name: "Select model" });
    fireEvent.click(within(modelPicker).getByText("Next model").closest("button")!);
    await waitFor(() => expect(setModel).toHaveBeenCalledWith("provider", "next"));

    resolvePage({
      sessionId: "session",
      messages: [{ id: "old", role: "user", text: "older request", timestamp: 0 }],
      hasMore: false,
    });
    expect(await screen.findByText("older request")).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText("Transcript history")).toBeNull());
  });

  it("keeps a new-thread draft and attachments when host preflight rejects", async () => {
    let rejectNewSession!: (error: Error) => void;
    const newSession = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectNewSession = reject; }));
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: () => () => {},
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
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
    expect(screen.getByText("Error: prompt rejected")).toBeTruthy();
    expect(composer.value).toBe("newer draft");
    expect(screen.getByRole("button", { name: "Preview draft.png" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    const nextDialog = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(nextDialog).getByRole("option", { name: /project/u }));
    expect(screen.queryByText(/Wait for the current message delivery/u)).toBeNull();
  });

  it("promotes a bridge new thread from a later detail when the acknowledgement has no updates", async () => {
    const newSession = vi.fn(async () => ({ version: 1 as const, updates: [], requestId: "1", submission: { accepted: true as const } }));
    let emitHostEvent: ((event: HostEvent) => void) | undefined;
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: (listener: (event: HostEvent) => void) => { emitHostEvent = listener; return () => {}; },
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      getPreparedThreadCapability: async (cwd: string) => ({ cwd, generation: 1, supportsImageInput: true }),
      newSession,
    } as unknown as typeof window.tau;

    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    const dialog = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(dialog).getByRole("option", { name: /project/u }));
    const composer = await screen.findByPlaceholderText(/Direct the agent/u);
    fireEvent.change(composer, { target: { value: "bridge prompt" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalledWith(
      "bridge prompt",
      [],
      "/project",
      expect.objectContaining({ clientTurnId: expect.any(String), clientMessageId: expect.any(String) }),
      undefined,
    ));

    emitHostEvent?.({
      type: "host-update",
      update: {
        version: 1,
        type: "thread-detail",
        detail: {
          sessionId: "bridge-created",
          requestId: createNewThreadRequestId("1"),
          messages: [{ id: "bridge-user", role: "user", text: "bridge prompt", timestamp: 2 }],
          isStreaming: false,
          activeTools: [],
        },
      },
    });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "What do you want to build?" })).toBeNull());
  });

  it("shows a whole-column drop target and clears it on leave and drop", async () => {
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: () => () => {},
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
    } as unknown as typeof window.tau;

    render(<App />);
    const heading = await screen.findByRole("heading", { name: "What do you want to build?" });
    const column = heading.closest("main");
    expect(column).toBeTruthy();
    if (!column) throw new Error("conversation column not rendered");
    const draft = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "keep this draft" } });
    const image = new File([new Uint8Array([137, 80, 78, 71])], "dropped.png", { type: "image/png" });
    const liveFilesBacking: File[] = [];
    const liveItems: Array<{ kind: string; type: string }> = [];
    const liveFiles = {
      get length() { return liveFilesBacking.length; },
      item(index: number) { return liveFilesBacking[index] ?? null; },
      get 0() { return liveFilesBacking[0]; },
    } as unknown as FileList;
    const dataTransfer = {
      types: ["Files"],
      items: liveItems,
      files: liveFiles,
      dropEffect: "none",
    } as unknown as DataTransfer;

    fireEvent.dragEnter(column, { dataTransfer });
    expect(screen.getByRole("status").className).toContain("unknown");
    fireEvent.dragOver(column, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("copy");
    liveFilesBacking.push(image);
    liveItems.push({ kind: "file", type: "image/png" });
    fireEvent.dragOver(column, { dataTransfer });
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
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: (handler: (event: HostEvent) => void) => { emit = handler; return () => {}; },
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
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
          models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0, supportsImageInput: false,
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
          sessionId: "stale-thread", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: false,
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
          models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: false,
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
    expect(screen.getByText("The active runtime does not accept image input.")).toBeTruthy();
  });

  it("keeps a new thread draft in memory without persisting image-capable composer data", async () => {
    const newSession = vi.fn(async () => ({ version: 1, updates: [] as never[], submission: { accepted: true as const } }));
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
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: () => () => {},
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async (cwd?: string) => ({ root: cwd ?? "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
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

    expect(localStorage.getItem("tau.composer-drafts.v1")).toBeNull();
    view.unmount();
    render(<App />);
    const restored = await waitFor(() => {
      const textarea = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
      expect(textarea.value).toBe("persistent draft");
      return textarea;
    });
    fireEvent.keyDown(restored, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalledWith(
      "persistent draft",
      [],
      "/other",
      expect.objectContaining({ clientTurnId: expect.any(String), clientMessageId: expect.any(String) }),
      undefined,
    ));
    expect(screen.getByText("persistent draft")).toBeTruthy();
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
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: () => () => {},
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
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

  it("renders durable turn checkpoints inline and loads their historical diff", async () => {
    const getTurnFileDiff = vi.fn(async () => ({
      path: "src/old.ts",
      added: 1,
      removed: 0,
      hunks: [{ header: "@@ -1 +1 @@", lines: [{ kind: "added" as const, newLine: 1, text: "historical" }] }],
    }));
    window.tau = {
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
      onHostEvent: () => () => {},
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
    } as unknown as typeof window.tau;

    render(<App />);
    expect(await screen.findByText("Turn changes · 1 changed file")).toBeTruthy();
    expect(document.querySelector(".conversation-files-dock")).toBeNull();
    fireEvent.click(screen.getByText("Open diff"));
    await waitFor(() => expect(getTurnFileDiff).toHaveBeenCalledWith("session", "turn-1", "src/old.ts", { hunkLimit: 40, contextLines: 3 }));
    expect(screen.getByText("Historical turn")).toBeTruthy();
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
                // The persisted prompt carries the submission's identity, which
                // is what commits the detached delivery.
                { id: "user", clientTurnId: identity.clientTurnId, clientMessageId: identity.clientMessageId, role: "user" as const, text: "Name this thread", timestamp: 1 },
                { id: "assistant", role: "assistant" as const, text: "Done", timestamp: 2 },
              ],
              isStreaming: false,
              activeTools: [],
            },
          },
        ],
        submission: { accepted: true as const },
      };
    });
    let publish: ((event: HostEvent) => void) | undefined;
    const generateTitle = vi.fn(async () => {
      // The host renames after its own round trip; the renamed shell arrives as
      // an ordinary host update, never as the command's return value.
      await new Promise((resolve) => setTimeout(resolve, 0));
      publish?.({
        type: "host-update",
        update: { version: 1, type: "thread-shell", update: { sessionId: "created", shell: { ...shell, title: "Created thread title" } } },
      });
      return { title: "Created thread title" };
    });
    const getWorkspaceInfo = vi.fn(async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }));
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
          allTools: [],
          extensionCount: 0,
          supportsImageInput: true,
        },
        project: { cwd: "/project" },
      }),
      onHostEvent: (listener: (event: HostEvent) => void) => { publish = listener; return () => {}; },
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo,
        getFileTree: async () => [],
      }, { "tau.thread-titles": generateTitle }),
      newSession,
    } as unknown as typeof window.tau;

    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    await waitFor(() => expect(getWorkspaceInfo).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    const dialog = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(dialog).getByRole("option"));
    const composer = screen.getByPlaceholderText(/Direct the agent/u);
    fireEvent.change(composer, { target: { value: "Name this thread" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(generateTitle).toHaveBeenCalledWith("generate", { provider: "provider", modelId: "model", force: false, sessionId: "created" }));
    expect(await screen.findByText("Created thread title")).toBeTruthy();
    expect(screen.getAllByText("Name this thread").some((element) => element.closest(".transcript-current-row"))).toBe(true);
  });

  it("promotes and settles an extension command that creates no user turn", async () => {
    let publish: ((event: HostEvent) => void) | undefined;
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
    window.tau = {
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
      onHostEvent: (listener: (event: HostEvent) => void) => { publish = listener; return () => {}; },
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [{ id: "code", name: "VS Code" }],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      newSession,
    } as unknown as typeof window.tau;

    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Search projects" })).getByRole("option"));
    const composer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "/extension-command" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(newSession).toHaveBeenCalled());
    if (!clientMessageId) throw new Error("newSession did not receive a client message id");
    // Session allocation alone leaves the draft in flight.
    expect(screen.getByRole("button", { name: "Open" }).hasAttribute("disabled")).toBe(true);

    // The host reports the missing user turn from prompt(), then commits the
    // detached delivery. Both arrive in that order over one channel.
    publish?.({ type: "prompt-without-user-turn", sessionId: "extension-session", clientMessageId });
    publish?.({
      type: "new-thread-delivery-settled",
      sessionId: "extension-session",
      clientMessageId,
      accepted: true,
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Open" }).hasAttribute("disabled")).toBe(false));
    expect(localStorage.getItem("tau.active-new-thread.v1")).toBeNull();
    // No user turn was persisted, so the optimistic prompt must not linger.
    expect(screen.queryByText("/extension-command")).toBeNull();
  });

  it("promotes a draft from its correlated user message before the IPC result", async () => {
    let resolveNewSession!: (result: { version: 1; updates: never[]; submission: { accepted: true } }) => void;
    let publish: ((event: HostEvent) => void) | undefined;
    let identity: { clientMessageId: string; newThreadRequestId?: string } | undefined;
    const generateTitle = vi.fn(async () => undefined);
    const newSession = vi.fn((...args: unknown[]) => {
      identity = args[3] as typeof identity;
      return new Promise<{ version: 1; updates: never[]; submission: { accepted: true } }>((resolve) => { resolveNewSession = resolve; });
    });
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }, { path: "/other", name: "other", lastOpenedAt: 0 }], sessions: [] },
        detail: { sessionId: "old", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "old", models: [{ provider: "provider", id: "model", name: "Model" }], model: { provider: "provider", id: "model", name: "Model" }, thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: (listener: (event: HostEvent) => void) => { publish = listener; return () => {}; },
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [{ id: "code", name: "VS Code" }],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }, { "tau.thread-titles": generateTitle }),
      newSession,
    } as unknown as typeof window.tau;

    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Search projects" })).getByRole("option", { name: /project/u }));
    const composer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "start in the detached runtime" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalled());
    if (!identity?.clientMessageId) throw new Error("newSession did not receive a client identity");

    publish?.({
      type: "host-update",
      update: {
        version: 1,
        type: "thread-detail",
        detail: { sessionId: "created", messages: [], isStreaming: true, activeTools: [], requestId: identity.newThreadRequestId as never },
      },
    });
    publish?.({
      type: "user-message",
      sessionId: "created",
      message: { id: "persisted", clientMessageId: identity.clientMessageId, role: "user", text: "start in the detached runtime", timestamp: Date.now() },
    });
    await waitFor(() => expect(generateTitle).toHaveBeenCalledWith("generate", { provider: "provider", modelId: "model", force: false, sessionId: "created" }));
    expect(generateTitle).toHaveBeenCalledOnce();

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
    publish?.({ type: "user-message-failed", sessionId: "created", clientMessageId: identity.clientMessageId, message: "late failure" });
    expect(screen.queryByText("late failure")).toBeNull();
    expect(generateTitle).toHaveBeenCalledOnce();
  });

  it("binds a generated session id on detached failure so retry uses sendPrompt", async () => {
    let publish: ((event: HostEvent) => void) | undefined;
    let clientMessageId: string | undefined;
    const newSession = vi.fn(async (...args: unknown[]) => {
      clientMessageId = (args[3] as { clientMessageId?: string }).clientMessageId;
      return { version: 1 as const, updates: [] as never[], submission: { accepted: true as const } };
    });
    const sendPrompt = vi.fn(async () => undefined);
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "old", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "old", models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: (listener: (event: HostEvent) => void) => { publish = listener; return () => {}; },
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      newSession,
      sendPrompt,
    } as unknown as typeof window.tau;

    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Search projects" })).getByRole("option"));
    const composer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "retry this runtime" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalledOnce());
    if (!clientMessageId) throw new Error("newSession did not receive a client message id");

    publish?.({ type: "user-message-failed", sessionId: "generated-session", clientMessageId, message: "runtime failed" });
    await waitFor(() => expect(composer.value).toBe("retry this runtime"));
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith(
      "retry this runtime",
      [],
      "generated-session",
      expect.objectContaining({ clientMessageId: expect.any(String) }),
      undefined,
    ));
    expect(newSession).toHaveBeenCalledOnce();
    // sendPrompt resolves at the runtime's delivery acceptance, so the retry
    // commits with it and stops holding the workspace.
    await waitFor(() => expect(localStorage.getItem("tau.active-new-thread.v1")).toBeNull());
  });

  it("restores the draft and runs no prompt hooks when detached delivery is rejected", async () => {
    let publish: ((event: HostEvent) => void) | undefined;
    let clientMessageId: string | undefined;
    const generateTitle = vi.fn(async () => undefined);
    const newSession = vi.fn(async (...args: unknown[]) => {
      clientMessageId = (args[3] as { clientMessageId?: string }).clientMessageId;
      return { version: 1 as const, updates: [] as never[], sessionId: "allocated", submission: { accepted: true as const } };
    });
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "old", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "old", models: [{ provider: "provider", id: "model", name: "Model" }], model: { provider: "provider", id: "model", name: "Model" }, thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: (listener: (event: HostEvent) => void) => { publish = listener; return () => {}; },
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }, { "tau.thread-titles": generateTitle }),
      newSession,
    } as unknown as typeof window.tau;

    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Search projects" })).getByRole("option"));
    const composer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "delivery is refused" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalledOnce());
    if (!clientMessageId) throw new Error("newSession did not receive a client message id");

    // A rejected delivery reports both: the message that will never exist, and
    // the new-thread settlement that reopens its draft.
    publish?.({
      type: "new-thread-delivery-settled",
      sessionId: "allocated",
      clientMessageId,
      accepted: false,
      message: "the runtime refused the prompt",
    });
    publish?.({ type: "user-message-failed", sessionId: "allocated", clientMessageId, message: "the runtime refused the prompt" });

    await waitFor(() => expect(composer.value).toBe("delivery is refused"));
    expect(screen.getByRole("heading", { name: "What do you want to build?" })).toBeTruthy();
    // The prompt never reached the runtime, so no afterPrompt hook may run.
    expect(generateTitle).not.toHaveBeenCalled();
    // A retry reuses the allocated runtime rather than leaking another one.
    expect(JSON.parse(localStorage.getItem("tau.active-new-thread.v1") ?? "{}").sessionId).toBe("allocated");
  });

  it("keeps every authoritative update from an acknowledgement that lands after promotion", async () => {
    let resolveNewSession!: (result: unknown) => void;
    let publish: ((event: HostEvent) => void) | undefined;
    let clientMessageId: string | undefined;
    const newSession = vi.fn((...args: unknown[]) => {
      clientMessageId = (args[3] as { clientMessageId?: string }).clientMessageId;
      return new Promise((resolve) => { resolveNewSession = resolve as (result: unknown) => void; });
    });
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "old", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "old", models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: (listener: (event: HostEvent) => void) => { publish = listener; return () => {}; },
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      newSession,
    } as unknown as typeof window.tau;

    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Search projects" })).getByRole("option"));
    const composer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "start the bridge thread" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalledOnce());
    if (!clientMessageId) throw new Error("newSession did not receive a client message id");

    publish?.({
      type: "user-message",
      sessionId: "bridge-created",
      message: { id: "persisted", clientMessageId, role: "user", text: "start the bridge thread", timestamp: Date.now() },
    });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "What do you want to build?" })).toBeNull());

    resolveNewSession({
      version: 1,
      updates: [{
        version: 1,
        type: "thread-shell",
        update: {
          sessionId: "bridge-created",
          shell: { id: "bridge-created", path: "/bridge.jsonl", title: "Named by the bridge", modifiedAt: 3, projectPath: "/project", projectName: "project", messageCount: 1 },
        },
      }],
      sessionId: "bridge-created",
      submission: { accepted: true },
    });

    expect(await screen.findByText("Named by the bridge")).toBeTruthy();
  });

  it("promotes a bridge draft whose persisted prompt text was expanded", async () => {
    let publish: ((event: HostEvent) => void) | undefined;
    let requestId: string | undefined;
    const newSession = vi.fn(async (...args: unknown[]) => {
      requestId = (args[3] as { newThreadRequestId?: string }).newThreadRequestId;
      return { version: 1 as const, updates: [] as never[], requestId, submission: { accepted: true as const } };
    });
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "old", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "old", models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: (listener: (event: HostEvent) => void) => { publish = listener; return () => {}; },
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [{ id: "code", name: "VS Code" }],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      newSession,
    } as unknown as typeof window.tau;

    render(<App />);
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
    publish?.({
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
    expect(localStorage.getItem("tau.active-new-thread.v1")).toBeNull();
  });

  it("prepends a failed prompt to newer text and keeps both attachments persisted", async () => {
    let publish: ((event: HostEvent) => void) | undefined;
    let clientMessageId: string | undefined;
    const newSession = vi.fn(async (...args: unknown[]) => {
      clientMessageId = (args[3] as { clientMessageId?: string }).clientMessageId;
      return { version: 1 as const, updates: [] as never[], submission: { accepted: true as const } };
    });
    const getPreparedThreadCapability = vi.fn(async (cwd: string) => ({ cwd, generation: 1, supportsImageInput: true }));
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "old", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "old", models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: (listener: (event: HostEvent) => void) => { publish = listener; return () => {}; },
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      newSession,
      getPreparedThreadCapability,
    } as unknown as typeof window.tau;

    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Search projects" })).getByRole("option"));
    const composer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    const chooseAttachment = screen.getByLabelText("Choose attachment files");
    await waitFor(() => expect(getPreparedThreadCapability).toHaveBeenCalledWith("/project"));
    await waitFor(() => expect((screen.getByRole("button", { name: "Attach files" }) as HTMLButtonElement).disabled).toBe(false));
    const oldImage = new File([new Uint8Array([1, 2, 3])], "old.png", { type: "image/png" });
    fireEvent.change(composer, { target: { value: "failed first prompt" } });
    fireEvent.change(chooseAttachment, { target: { files: [oldImage] } });
    await screen.findByRole("button", { name: "Preview old.png" });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalledOnce());
    if (!clientMessageId) throw new Error("newSession did not receive a client message id");

    await waitFor(() => expect(composer.value).toBe("") );
    fireEvent.change(composer, { target: { value: "newer queued text" } });
    const newerImage = new File([new Uint8Array([4, 5, 6])], "new.png", { type: "image/png" });
    fireEvent.change(chooseAttachment, { target: { files: [newerImage] } });
    await screen.findByRole("button", { name: "Preview new.png" });

    publish?.({ type: "user-message-failed", sessionId: "generated-session", clientMessageId, message: "runtime failed" });
    await waitFor(() => expect(composer.value).toBe("failed first prompt\n\nnewer queued text"));
    expect(screen.getByRole("button", { name: "Preview old.png" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview new.png" })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("tau.active-new-thread.v1") ?? "{}").draft).toBe("failed first prompt\n\nnewer queued text");
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
        catalog: { sessionId: "main-thread", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd, branch: "main" },
      }),
      onHostEvent: () => () => {},
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
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd },
      }),
      onHostEvent: () => () => {},
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

  it("removes a pending bridge prompt by id when its runtime later fails", async () => {
    let sentClientMessageId: string | undefined;
    const sendPrompt = vi.fn(async (
      _text: string,
      _attachments: unknown[] | undefined,
      _sessionId: string | undefined,
      identity?: { clientMessageId?: string },
      _prepared?: unknown,
    ) => {
      sentClientMessageId = identity?.clientMessageId;
    });
    let publish: ((event: HostEvent) => void) | undefined;
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0 },
        project: { cwd: "/project" },
      }),
      onHostEvent: (listener: (event: HostEvent) => void) => { publish = listener; return () => {}; },
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      sendPrompt,
    } as unknown as typeof window.tau;

    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    const composer = screen.getByPlaceholderText(/Direct the agent/u);
    fireEvent.change(composer, { target: { value: "bridge prompt" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
    const clientMessageId = sentClientMessageId;
    expect(clientMessageId).toEqual(expect.any(String));
    if (!clientMessageId) throw new Error("The renderer did not create a request id.");
    expect(screen.getByText("bridge prompt")).toBeTruthy();

    publish?.({ type: "user-message-failed", sessionId: "session", clientMessageId, message: "runtime failed" });
    await waitFor(() => expect(screen.queryByText("bridge prompt")).toBeNull());
  });

  it.each(["before", "after"] as const)("restores a detached new-thread draft when failure arrives %s the IPC response", async (order) => {
    localStorage.clear();
    let resolveNewSession!: (result: { version: 1; updates: never[]; submission: { accepted: true } }) => void;
    let newSessionArgs: unknown[] | undefined;
    const newSession = vi.fn((...args: unknown[]) => {
      newSessionArgs = args;
      return new Promise<{ version: 1; updates: never[]; submission: { accepted: true } }>((resolve) => {
        resolveNewSession = resolve;
      });
    });
    let publish: ((event: HostEvent) => void) | undefined;
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 2 }, { path: "/other", name: "other", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      onHostEvent: (listener: (event: HostEvent) => void) => { publish = listener; return () => {}; },
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async (cwd?: string) => ({ root: cwd ?? "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      getPreparedThreadCapability: async (cwd: string) => ({ cwd, generation: 1, supportsImageInput: true }),
      newSession,
    } as unknown as typeof window.tau;

    render(<App />);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    const dialog = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(dialog).getByRole("option", { name: /other/u }));
    const composer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "restore this prompt" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalled());
    const identity = newSessionArgs?.[3] as { clientMessageId: string } | undefined;
    if (!identity) throw new Error("newSession did not receive client identity");
    const failure: HostEvent = { type: "user-message-failed", sessionId: "new-session", clientMessageId: identity.clientMessageId, message: "prompt failed" };
    if (order === "before") publish?.(failure);
    resolveNewSession({ version: 1, updates: [], submission: { accepted: true } });
    if (order === "after") {
      await waitFor(() => expect(composer.value).toBe("") );
      publish?.(failure);
    }
    await waitFor(() => expect(composer.value).toBe("restore this prompt"));
    expect(screen.getAllByText("prompt failed").length).toBeGreaterThan(0);
  });

  it("copies the host-resolved skill instruction instead of injected content", async () => {
    const copyText = vi.fn(async () => undefined);
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: {
          sessionId: "session",
          messages: [{
            id: "skill",
            role: "user" as const,
            text: "Review **the parser**",
            skill: { name: "tdd", command: "/skill:tdd", copyText: "/skill:tdd Review **the parser**" },
            timestamp: 1,
          }, {
            id: "assistant",
            role: "assistant" as const,
            text: "Assistant **answer**",
            timestamp: 2,
          }],
          isStreaming: false,
          activeTools: [],
        },
        catalog: { models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0 },
        project: { cwd: "/project" },
      }),
      onHostEvent: () => () => {},
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      copyText,
    } as unknown as typeof window.tau;

    render(<App />);
    await screen.findByText("Review **the parser**");
    const copyButtons = screen.getAllByRole("button", { name: "copy message" });
    fireEvent.click(copyButtons[0]);
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("/skill:tdd Review **the parser**"));
    fireEvent.click(copyButtons[1]);
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith("Assistant **answer**"));
  });

  it("keeps a new thread local until its first prompt and restores its draft after reload", async () => {
    const newSession = vi.fn(async () => ({ version: 1, updates: [] as never[] }));
    window.tau = {
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [
          { path: "/project", name: "project", lastOpenedAt: 2 },
          { path: "/other", name: "other", lastOpenedAt: 1 },
        ], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0 },
        project: { cwd: "/project" },
      }),
      onHostEvent: () => () => {},
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      newSession,
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
    await waitFor(() => expect(newSession).toHaveBeenCalledWith(
      "persistent draft",
      [],
      "/other",
      expect.objectContaining({ clientTurnId: expect.any(String), clientMessageId: expect.any(String) }),
      undefined,
    ));
    expect(screen.getByText("persistent draft")).toBeTruthy();
  });
});
