// @vitest-environment jsdom
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNewThreadRequestId, type ClientTurnIdentity, type HostEvent } from "../shared/contracts";
import { setHostClient } from "./host-client-context";
import { createMemoryStorage, getClientStorage, setClientStorage } from "../workbench/client-storage";
import { writeNewThreadDraft } from "../workbench/draft-store";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { renderApp } from "./test-support/render-app";
import { workspaceHostStub } from "./test-support/workspace-host-stub";
import type { DesktopExtension } from "./extension-system";

const messageRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./components/Message", () => ({
  Message: ({ message, onCopy }: { message: { text: string }; onCopy?: (message: { text: string }) => void }) => {
    messageRenders.count += 1;
    return <div>{message.text}{onCopy ? <button type="button" onClick={() => onCopy(message)}>copy message</button> : null}</div>;
  },
}));

import { isCurrentTranscriptSubmission, latestActivityAnchor, mergeNewThreadRecoveryAttachments, mergeNewThreadRecoveryDraft, optimisticThreadSnapshot, reconcileOptimisticMessages } from "../workbench/app-state";
import { ComposerHost, measureComposerGeometry } from "./components/ComposerHost";
import { MountedPanel } from "./Workbench";
import { mergeTranscriptMessages, restoreTranscriptScrollAnchor } from "../workbench/transcript-history";
import { asHostTranscriptCursor } from "../shared/transcript-cursor";
import type { NewThreadResult, TranscriptPage } from "../shared/host-protocol";
import { plainChipText } from "./components/composer-chips";

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

/** The panel under test never calls one; the prop only has to exist. */
const noActions = {} as never;

describe("App render isolation", () => {
  beforeEach(() => {
    messageRenders.count = 0;
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
    const view = render(<MountedPanel Component={Probe} active label="Probe" extensionName="Fixture" actions={noActions} />);
    fireEvent.click(screen.getByText("panel 0"));
    view.rerender(<MountedPanel Component={Probe} active={false} label="Probe" extensionName="Fixture" actions={noActions} />);
    expect(screen.getByText("panel 1")).toBeTruthy();
    const before = renders;
    view.rerender(<MountedPanel Component={Probe} active={false} label="Probe" extensionName="Fixture" actions={noActions} />);
    expect(renders).toBe(before);
  });

  it("shows no stage toggle and no panel rail when no extension registered a panel", async () => {
    const view = renderApp(undefined);
    await screen.findByRole("button", { name: "Send" });
    expect(screen.queryByRole("button", { name: /^(Hide|Show) stage$/ })).toBeNull();
    expect(view.container.querySelector(".panel-rail, .instrument-dock, .title-bar")).toBeNull();
  });

  it("uses a focused start screen until the first message is sent", async () => {
    const sendPrompt = vi.fn(async () => undefined);
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: {
          sessionId: "session",
          messages: [],
          isStreaming: false,
          activeTools: [],
          usage: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_100, costUsd: 0.05, turns: 1 },
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
      sendPrompt,
    });

    renderApp(client);
    const heading = await screen.findByRole("heading", { name: "What do you want to build?" });
    expect(heading.closest(".conversation-start-screen")).toBeTruthy();
    expect(screen.queryByText("NEW THREAD")).toBeNull();
    expect(screen.getByRole("button", { name: "Change project, current project project" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Untitled thread" })).toBeNull();
    expect(screen.queryByLabelText(/^Thread cost/u)).toBeNull();

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

  // Another client (a phone) opened a project; the host pushes that thread's project to every client.
  it("keeps the start screen and its composer on the thread on screen when another client opens a project", async () => {
    const sendPrompt = vi.fn(async () => undefined);
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
        project: { cwd: "/project" },
      }),
      sendPrompt,
    });

    renderApp(client);
    await screen.findByRole("button", { name: "Change project, current project project" });
    act(() => client.emit({ type: "host-update", update: { version: 1, type: "project", project: { cwd: "/other" }, sessionId: "phone-thread" } }));
    expect(screen.getByRole("button", { name: "Change project, current project project" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change project, current project other" })).toBeNull();

    const composer = screen.getByPlaceholderText(/Direct the agent/u);
    fireEvent.change(composer, { target: { value: "Hello" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith("Hello", [], "session", expect.anything(), undefined));
  });

  it("deduplicates a persisted detail that arrives before its live user-message event", async () => {
    const sendPrompt = vi.fn(async (...args: unknown[]) => {
      const identity = args[3] as { clientMessageId: string };
      const persisted = {
        id: "persisted-prompt",
        clientMessageId: identity.clientMessageId,
        role: "user" as const,
        text: "Render this once",
        timestamp: Date.now() + 1_000,
      };
      client.emit({
        type: "host-update",
        update: {
          version: 1,
          type: "thread-detail",
          detail: {
            sessionId: "session",
            messages: [persisted],
            isStreaming: true,
            activeTools: [],
          },
        },
      });
      client.emit({
        type: "user-message",
        sessionId: "session",
        message: { ...persisted, id: `user-${identity.clientMessageId}` },
      });
    });
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
        getFileTree: async () => [],
      }),
      sendPrompt,
    });

    renderApp(client);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    const composer = screen.getByPlaceholderText(/Direct the agent/u);
    fireEvent.change(composer, { target: { value: "Render this once" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("log").querySelector('[data-message-id="persisted-prompt"]')).toBeTruthy());
    expect(screen.getByRole("log").querySelectorAll("[data-message-id]")).toHaveLength(1);
  });

  it("keeps the same focused composer mounted while the first prompt docks", async () => {
    const sendPrompt = vi.fn(async () => undefined);
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
        getFileTree: async () => [],
      }),
      sendPrompt,
    });

    renderApp(client);
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
    const client = createFakeHostClient({
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
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      sendPrompt,
      newSession,
    });

    renderApp(client);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    const oldComposer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(oldComposer, { target: { value: "old in-flight prompt" } });
    fireEvent.keyDown(oldComposer, { key: "Enter" });
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());

    // The title menu's new thread opens in the thread's own project, as ⌘N does.
    fireEvent.click(screen.getByRole("button", { name: "Existing thread" }));
    fireEvent.click(await screen.findByText("New thread"));
    expect(screen.queryByRole("dialog", { name: "Search projects" })).toBeNull();
    const draftComposer = await screen.findByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    await waitFor(() => expect(draftComposer.value).toBe(""));
    fireEvent.change(draftComposer, { target: { value: "new draft" } });
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);

    fireEvent.keyDown(draftComposer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalledWith(
      "new draft",
      [],
      "/project",
      expect.objectContaining({ clientTurnId: expect.any(String), clientMessageId: expect.any(String) }),
      undefined,
    ));
    await waitFor(() => expect(screen.getByText("new draft")).toBeTruthy());
    await waitFor(() => expect(draftComposer.value).toBe(""));
    resolveOld();
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
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      getPreparedThreadCapability,
      newSession,
    });

    renderApp(client);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    const composer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "carry this draft" } });
    const attachment = new File([new Uint8Array([137, 80, 78, 71])], "carry.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Choose attachment files"), { target: { files: [attachment] } });
    await screen.findByRole("button", { name: "Preview carry.png" });

    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    const dialog = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(dialog).getByRole("option", { name: /other/u }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Change project, current project other" })).toBeTruthy());
    // The image is a chip at the end of the text.
    expect(plainChipText(composer.value)).toBe("carry this draft carry.png ");
    expect(screen.getByRole("button", { name: "Preview carry.png" })).toBeTruthy();

    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalledWith(
      "carry this draft carry.png",
      [expect.objectContaining({ name: "carry.png" })],
      "/other",
      expect.objectContaining({ clientTurnId: expect.any(String), clientMessageId: expect.any(String) }),
      undefined,
    ));
  });

  it("keeps a model selected for an unstarted thread on that thread", async () => {
    let clientMessageId: string | undefined;
    const newSession = vi.fn(async (...args: unknown[]) => {
      clientMessageId = (args[3] as ClientTurnIdentity).clientMessageId;
      return { version: 1 as const, updates: [] as never[], sessionId: "created", submission: { accepted: true as const } };
    });
    const setModel = vi.fn(async () => ({ version: 1 as const, updates: [] as never[] }));
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "previous", messages: [], isStreaming: false, activeTools: [] },
        catalog: {
          sessionId: "previous",
          models: [
            { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
            { provider: "openai-codex", id: "gpt-6-astra", name: "GPT-6 Astra" },
          ],
          model: { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
          thinkingLevel: "medium",
          thinkingLevels: ["medium"],
          allTools: [],
          extensionCount: 0,
        },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      setModel,
      newSession,
    });

    const storage = createMemoryStorage();
    writeNewThreadDraft(storage, { kind: "draft", draftId: "model-draft", projectPath: "/project", projectName: "project" });
    renderApp(client, { storage });
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: /Select model: GPT-5.6 Sol/u }));
    const modelPicker = await screen.findByRole("dialog", { name: "Select model" });
    fireEvent.click((await within(modelPicker).findByText("GPT-6 Astra")).closest("[role=option]")!);

    expect(await screen.findByRole("button", { name: /Select model: GPT-6 Astra/u })).toBeTruthy();
    expect(setModel).not.toHaveBeenCalled();

    const composer = screen.getByPlaceholderText(/Direct the agent/u);
    fireEvent.change(composer, { target: { value: "keep this model" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalledWith(
      "keep this model",
      [],
      "/project",
      expect.objectContaining({ clientTurnId: expect.any(String), clientMessageId: expect.any(String) }),
      undefined,
      { model: { provider: "openai-codex", id: "gpt-6-astra" } },
    ));
    client.emit({
      type: "new-thread-delivery-settled",
      sessionId: "created",
      clientMessageId: clientMessageId!,
      accepted: true,
    });
    expect(await screen.findByRole("button", { name: /Select model: GPT-6 Astra/u })).toBeTruthy();
  });

  it("keeps an in-flight history load when a same-thread action returns detail", async () => {
    let resolvePage!: (page: TranscriptPage) => void;
    const loadTranscript = vi.fn(() => new Promise<TranscriptPage>((resolve) => { resolvePage = resolve; }));
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
    const client = createFakeHostClient({
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
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      loadTranscript,
      setModel,
    });

    renderApp(client);
    await screen.findByText("current reply");
    // At the top already: a wheel further up asks for the older page.
    fireEvent.wheel(screen.getByRole("log"), { deltaY: -100 });
    await waitFor(() => expect(loadTranscript).toHaveBeenCalledWith("session", asHostTranscriptCursor("opaque:2")));

    fireEvent.click(screen.getByRole("button", { name: /Current model/u }));
    const modelPicker = await screen.findByRole("dialog", { name: "Select model" });
    fireEvent.click(within(modelPicker).getByText("Next model").closest("[role=option]")!);
    await waitFor(() => expect(setModel).toHaveBeenCalledWith("provider", "next"));

    resolvePage({
      sessionId: "session",
      messages: [{ id: "old", role: "user", text: "older request", timestamp: 0 }],
      hasMore: false,
    });
    expect(await screen.findByText("older request")).toBeTruthy();
    await waitFor(() => expect(document.querySelector("[data-older-turns]")).toBeNull());
  });

  it("promotes a bridge new thread from a later detail when the acknowledgement has no updates", async () => {
    const newSession = vi.fn(async () => ({ version: 1 as const, updates: [], requestId: createNewThreadRequestId("1"), submission: { accepted: true as const } }));
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

    renderApp(client);
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

    client.emit({
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
        getFileTree: async () => [],
      }),
    });

    renderApp(client);
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
    expect(plainChipText(draft.value)).toBe("keep this draft dropped.png ");

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
        getFileTree: async () => [],
      }),
    });

    renderApp(client);
    const heading = await screen.findByRole("heading", { name: "What do you want to build?" });
    const attach = screen.getByRole("button", { name: "Attach files" });
    expect(attach.hasAttribute("disabled")).toBe(false);
    client.emit({
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
    client.emit({
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
    client.emit({
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

  it("keeps the chosen model on the composer chip after a turn settles", async () => {
    const sol = { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" };
    const luna = { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: {
          sessionId: "session",
          messages: [{ id: "ask", role: "user" as const, text: "say ok", timestamp: 1 }],
          isStreaming: false,
          activeTools: [],
        },
        catalog: {
          sessionId: "session",
          models: [sol, luna],
          model: sol,
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
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
    });

    renderApp(client);
    await screen.findByRole("button", { name: "Select model: GPT-5.6 Sol" });

    client.emit({
      type: "host-update",
      update: {
        version: 1,
        type: "catalog",
        catalog: {
          sessionId: "session",
          models: [sol, luna],
          model: luna,
          thinkingLevel: "off",
          thinkingLevels: ["off"],
          allTools: [],
          extensionCount: 0,
          supportsImageInput: true,
        },
      },
    });
    await screen.findByRole("button", { name: "Select model: GPT-5.6 Luna" });

    // A settled turn pushes a detail and no catalog; the chip must still name
    // the model the next prompt will run on.
    client.emit({
      type: "host-update",
      update: {
        version: 1,
        type: "thread-detail",
        detail: {
          sessionId: "session",
          messages: [
            { id: "ask", role: "user" as const, text: "say ok", timestamp: 1 },
            { id: "reply", role: "assistant" as const, text: "ok", timestamp: 2 },
          ],
          isStreaming: false,
          activeTools: [],
        },
      },
    });

    await screen.findByText("ok");
    expect(screen.getByRole("button", { name: "Select model: GPT-5.6 Luna" })).toBeTruthy();
  });

  it("keeps a new thread draft in memory without persisting image-capable composer data", async () => {
    const newSession = vi.fn(async () => ({ version: 1 as const, updates: [] as never[], submission: { accepted: true as const } }));
    const capabilityResolvers = new Map<string, Array<(capability: { cwd: string; generation: number; supportsImageInput: boolean }) => void>>();
    const getPreparedThreadCapability = vi.fn((cwd: string) => new Promise<{ cwd: string; generation: number; supportsImageInput: boolean }>((resolve) => {
      const pending = capabilityResolvers.get(cwd) ?? [];
      pending.push(resolve);
      capabilityResolvers.set(cwd, pending);
    }));
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
        getWorkspaceInfo: async (cwd?: string) => ({ root: cwd ?? "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      newSession,
      getPreparedThreadCapability,
    });
    const view = renderApp(client);
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

    expect(getClientStorage()?.get("tau.composer-drafts.v1")).toBeNull();
    const { storage } = view;
    view.unmount();
    renderApp(client, { storage });
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

  it("binds a generated session id on detached failure so retry uses sendPrompt", async () => {
    let clientMessageId: string | undefined;
    const newSession = vi.fn(async (...args: unknown[]) => {
      clientMessageId = (args[3] as { clientMessageId?: string }).clientMessageId;
      return { version: 1 as const, updates: [] as never[], submission: { accepted: true as const } };
    });
    const sendPrompt = vi.fn(async () => undefined);
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "old", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "old", models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      newSession,
      sendPrompt,
    });

    renderApp(client);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Search projects" })).getByRole("option"));
    const composer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "retry this runtime" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalledOnce());
    if (!clientMessageId) throw new Error("newSession did not receive a client message id");

    client.emit({ type: "user-message-failed", sessionId: "generated-session", clientMessageId, message: "runtime failed" });
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
    await waitFor(() => expect(getClientStorage()?.get("tau.active-new-thread.v1")).toBeNull());
  });

  it("restores the draft and runs no prompt hooks when detached delivery is rejected", async () => {
    let clientMessageId: string | undefined;
    const afterPrompt = vi.fn();
    const promptHook: DesktopExtension = {
      id: "test.prompt-hook",
      name: "Prompt hook",
      activate(context) { context.registerPromptHook({ id: "test.after-prompt", afterPrompt }); },
    };
    const newSession = vi.fn(async (...args: unknown[]): Promise<NewThreadResult> => {
      clientMessageId = (args[3] as { clientMessageId?: string }).clientMessageId;
      return { version: 1 as const, updates: [] as never[], sessionId: "allocated", submission: { accepted: true as const } };
    });
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "old", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "old", models: [{ provider: "provider", id: "model", name: "Model" }], model: { provider: "provider", id: "model", name: "Model" }, thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      newSession,
    });

    renderApp(client, { extensions: [promptHook] });
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
    client.emit({
      type: "new-thread-delivery-settled",
      sessionId: "allocated",
      clientMessageId,
      accepted: false,
      message: "the runtime refused the prompt",
    });
    client.emit({ type: "user-message-failed", sessionId: "allocated", clientMessageId, message: "the runtime refused the prompt" });

    await waitFor(() => expect(composer.value).toBe("delivery is refused"));
    expect(screen.getByRole("heading", { name: "What do you want to build?" })).toBeTruthy();
    // The prompt never reached the runtime, so no afterPrompt hook may run.
    expect(afterPrompt).not.toHaveBeenCalled();
    // A retry reuses the allocated runtime rather than leaking another one.
    expect(JSON.parse(getClientStorage()?.get("tau.active-new-thread.v1") ?? "{}").sessionId).toBe("allocated");
  });

  it("keeps every authoritative update from an acknowledgement that lands after promotion", async () => {
    let resolveNewSession!: (result: NewThreadResult) => void;
    let clientMessageId: string | undefined;
    const newSession = vi.fn((...args: unknown[]): Promise<NewThreadResult> => {
      clientMessageId = (args[3] as { clientMessageId?: string }).clientMessageId;
      return new Promise<NewThreadResult>((resolve) => { resolveNewSession = resolve; });
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
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      newSession,
    });

    renderApp(client);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    fireEvent.click(screen.getByRole("button", { name: "Change project, current project project" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Search projects" })).getByRole("option"));
    const composer = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "start the bridge thread" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalledOnce());
    if (!clientMessageId) throw new Error("newSession did not receive a client message id");

    client.emit({
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

  it("prepends a failed prompt to newer text and keeps both attachments persisted", async () => {
    let clientMessageId: string | undefined;
    const newSession = vi.fn(async (...args: unknown[]) => {
      clientMessageId = (args[3] as { clientMessageId?: string }).clientMessageId;
      return { version: 1 as const, updates: [] as never[], submission: { accepted: true as const } };
    });
    const getPreparedThreadCapability = vi.fn(async (cwd: string) => ({ cwd, generation: 1, supportsImageInput: true }));
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "old", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "old", models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      newSession,
      getPreparedThreadCapability,
    });

    renderApp(client);
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

    client.emit({ type: "user-message-failed", sessionId: "generated-session", clientMessageId, message: "runtime failed" });
    // The host hands back the text it was sent, where a chip is its label; the image comes back as a chip.
    await waitFor(() => expect(plainChipText(composer.value)).toBe("failed first prompt old.png\n\nnewer queued text new.png old.png "));
    expect(screen.getByRole("button", { name: "Preview old.png" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview new.png" })).toBeTruthy();
    expect(plainChipText(JSON.parse(getClientStorage()?.get("tau.active-new-thread.v1") ?? "{}").draft)).toBe("failed first prompt old.png\n\nnewer queued text new.png old.png ");
  });

  it("does not rerender existing transcript messages for a composer keystroke", () => {
    renderApp(undefined);
    const before = messageRenders.count;
    fireEvent.change(screen.getByPlaceholderText(/Direct the agent/u), { target: { value: "x" } });
    expect(messageRenders.count).toBe(before);
  });

  it("removes a pending bridge prompt by id when its runtime later fails", async () => {
    let sentClientMessageId: string | undefined;
    const sendPrompt = vi.fn(async (
      _text: string,
      _attachments?: unknown[],
      _sessionId?: string,
      identity?: string | ClientTurnIdentity,
      _prepared?: unknown,
    ) => {
      sentClientMessageId = typeof identity === "string" ? identity : identity?.clientMessageId;
    });
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0 },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      sendPrompt,
    });

    renderApp(client);
    await screen.findByRole("heading", { name: "What do you want to build?" });
    const composer = screen.getByPlaceholderText(/Direct the agent/u);
    fireEvent.change(composer, { target: { value: "bridge prompt" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
    const clientMessageId = sentClientMessageId;
    expect(clientMessageId).toEqual(expect.any(String));
    if (!clientMessageId) throw new Error("The renderer did not create a request id.");
    expect(screen.getByText("bridge prompt")).toBeTruthy();

    client.emit({ type: "user-message-failed", sessionId: "session", clientMessageId, message: "runtime failed" });
    await waitFor(() => expect(screen.queryByText("bridge prompt")).toBeNull());
  });

  it.each(["before", "after"] as const)("restores a detached new-thread draft when failure arrives %s the IPC response", async (order) => {
    let resolveNewSession!: (result: { version: 1; updates: never[]; submission: { accepted: true } }) => void;
    let newSessionArgs: unknown[] | undefined;
    const newSession = vi.fn((...args: unknown[]) => {
      newSessionArgs = args;
      return new Promise<{ version: 1; updates: never[]; submission: { accepted: true } }>((resolve) => {
        resolveNewSession = resolve;
      });
    });
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 2 }, { path: "/other", name: "other", lastOpenedAt: 1 }], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0, supportsImageInput: true },
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

    renderApp(client);
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
    if (order === "before") client.emit(failure);
    resolveNewSession({ version: 1, updates: [], submission: { accepted: true } });
    if (order === "after") {
      await waitFor(() => expect(composer.value).toBe("") );
      client.emit(failure);
    }
    await waitFor(() => expect(composer.value).toBe("restore this prompt"));
    expect(screen.getAllByText("prompt failed").length).toBeGreaterThan(0);
  });

  it("copies the host-resolved skill instruction instead of injected content", async () => {
    const copyText = vi.fn(async () => undefined);
    const client = createFakeHostClient({
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
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      copyText,
    });

    renderApp(client);
    await screen.findByText("Review **the parser**");
    const copyButtons = screen.getAllByRole("button", { name: "copy message" });
    fireEvent.click(copyButtons[0]);
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("/skill:tdd Review **the parser**"));
    fireEvent.click(copyButtons[1]);
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith("Assistant **answer**"));
  });

  it("keeps a new thread local until its first prompt and restores its draft after reload", async () => {
    const newSession = vi.fn(async () => ({ version: 1 as const, updates: [] as never[], submission: { accepted: true as const } }));
    const client = createFakeHostClient({
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
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
      newSession,
    });
    const view = renderApp(client);
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

    const { storage } = view;
    view.unmount();
    renderApp(client, { storage });
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

describe("App workbench events", () => {
  it("tells extensions which project is open and how many clients are attached", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const probe: DesktopExtension = {
      id: "test.events",
      name: "Event probe",
      activate: (plugin) => {
        plugin.events.on("workspace-changed", (event) => seen.push({ ...event }));
        plugin.events.on("client-count", (event) => seen.push({ ...event }));
      },
    };
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1,
        threadIndex: { projects: [], sessions: [] },
        detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
        project: { cwd: "/project" },
      }),
    });

    renderApp(client, { extensions: [probe] });
    await waitFor(() => expect(seen).toContainEqual({ type: "workspace-changed", to: "/project" }));

    client.emit({ type: "host-update", update: { version: 1, type: "project", project: { cwd: "/other" } } });
    await waitFor(() => expect(seen).toContainEqual({ type: "workspace-changed", from: "/project", to: "/other" }));

    client.emit({ type: "client-count", count: 2 });
    await waitFor(() => expect(seen).toContainEqual({ type: "client-count", count: 2 }));
  });
});
