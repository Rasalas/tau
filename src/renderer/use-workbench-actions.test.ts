// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useWorkbenchActions, type UseWorkbenchActionsOptions } from "./use-workbench-actions";
import type { HostSnapshot, UiModel } from "../shared/contracts";

function createMockOptions(overrides: Partial<UseWorkbenchActionsOptions> = {}): UseWorkbenchActionsOptions {
  const models: UiModel[] = [
    { provider: "anthropic", id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet" },
    { provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  ];
  return {
    client: { abort: vi.fn() } as any,
    platform: { clipboard: { writeText: vi.fn() }, openExternal: vi.fn() } as any,
    threadStore: { getSnapshot: () => ({ activeThreadId: "thread-1" }) } as any,
    viewStore: { getSnapshot: () => ({ models }) } as any,
    composerScopeStore: { getSnapshot: vi.fn().mockReturnValue({ draft: "test draft" }), setDraft: vi.fn() } as any,
    threadCommands: {
      compactContext: vi.fn(),
      setThinking: vi.fn(),
      runShellAction: vi.fn(),
    } as any,
    snapshot: { sessionId: "sess-1", workspaceId: "ws-1", model: { provider: "anthropic", id: "claude-3-7-sonnet" } } as HostSnapshot,
    pendingNewThread: undefined,
    workspaceCwd: "/path/to/project",
    newThreadDeliveryPending: false,
    activeDraftKey: "draft-1" as any,
    composerRef: { current: null },
    transcriptRef: { current: null },
    openPanel: vi.fn(),
    openPalette: vi.fn(),
    setSettingsPage: vi.fn(),
    openNewThreadPicker: vi.fn(),
    focusStage: vi.fn(),
    switchSession: vi.fn(),
    settleActiveThread: vi.fn(),
    isVisibleThreadRunning: vi.fn().mockReturnValue(true),
    reloadWorkbench: vi.fn(),
    openThreadTree: vi.fn(),
    duplicateThread: vi.fn(),
    setComposerSeed: vi.fn(),
    setDockOpen: vi.fn(),
    setNotice: vi.fn(),
    openProjectSources: vi.fn(),
    applyHostResult: vi.fn(),
    stageTabs: { closeActive: vi.fn(), open: vi.fn(), close: vi.fn(), tabs: () => [] } as any,
    cycleStageTab: vi.fn(),
    openOverlay: vi.fn(),
    closeOverlay: vi.fn(),
    openWorkspace: vi.fn(),
    openFile: vi.fn(),
    openThread: vi.fn(),
    setComposerHolds: vi.fn(),
    setComposerModel: vi.fn(),
    openModelPicker: vi.fn(),
    openInstructions: vi.fn(),
    ...overrides,
  };
}

describe("useWorkbenchActions", () => {
  it("assembles actions and preserves reference stability when unstable setComposerModel is passed", () => {
    let setModelCount = 0;
    const baseOptions = createMockOptions();
    const { result, rerender } = renderHook(
      (props) => useWorkbenchActions(props),
      {
        initialProps: {
          ...baseOptions,
          setComposerModel: () => { setModelCount++; },
        },
      },
    );

    const firstActions = result.current;
    expect(firstActions).toBeDefined();
    expect(firstActions.activeThread()?.sessionId).toBe("sess-1");
    expect(firstActions.activeThread()?.cwd).toBe("/path/to/project");

    // Rerender with a NEW setComposerModel function instance
    rerender({
      ...baseOptions,
      setComposerModel: () => { setModelCount += 2; },
    });

    // Actions identity must be strictly preserved across renders
    expect(result.current).toBe(firstActions);
  });

  it("describes a pending draft by the runtime and model it will start with", () => {
    const draft = { kind: "draft" as const, draftId: "d1", projectPath: "/p", workspaceId: "ws-2", projectName: "p" };
    const codexThread = { sessionId: "sess-1", workspaceId: "ws-1", backendKind: "codex", model: { provider: "openai", id: "gpt-5.6-sol" } } as HostSnapshot;
    const preferences = (newThreadRuntime?: string) => ({ getSnapshot: () => ({ newThreadRuntime }) }) as any;

    // The last thread ran on Codex; a Pi draft does not inherit its model.
    const pi = renderHook(() => useWorkbenchActions(createMockOptions({ snapshot: codexThread, pendingNewThread: draft, newThreadDeliveryPending: true }))).result.current;
    expect(pi.activeThread()).toEqual({ cwd: "/path/to/project", workspaceId: "ws-2", backendKind: "pi", draftPending: true, mode: "default", modes: [] });

    const chosen = { ...draft, model: { provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku" } };
    const picked = renderHook(() => useWorkbenchActions(createMockOptions({ snapshot: codexThread, pendingNewThread: chosen, newThreadDeliveryPending: true }))).result.current;
    expect(picked.activeThread()?.model).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });

    // A Pi thread's model is what an untouched Pi draft shows and starts with.
    const fromPi = renderHook(() => useWorkbenchActions(createMockOptions({ pendingNewThread: draft, newThreadDeliveryPending: true }))).result.current;
    expect(fromPi.activeThread()?.model).toEqual({ provider: "anthropic", id: "claude-3-7-sonnet" });

    const onCodex = renderHook(() => useWorkbenchActions(createMockOptions({
      snapshot: { ...codexThread, runtimeBackends: [{ kind: "codex", label: "Codex" }] } as HostSnapshot,
      pendingNewThread: draft,
      newThreadDeliveryPending: true,
      preferences: preferences("codex"),
    }))).result.current;
    expect(onCodex.activeThread()).toMatchObject({ backendKind: "codex" });
    expect(onCodex.activeThread()?.model).toBeUndefined();
  });

  it("delegates setModel query search and resolves target model", async () => {
    const setComposerModel = vi.fn();
    const options = createMockOptions({ setComposerModel });
    const { result } = renderHook(() => useWorkbenchActions(options));

    const matched = await result.current.setModel?.("gemini");
    expect(matched).toBe(true);
    expect(setComposerModel).toHaveBeenCalledWith("google", "gemini-2.5-flash");

    const unmatched = await result.current.setModel?.("nonexistent-model");
    expect(unmatched).toBe(false);

    // Direct provider and id
    await result.current.setModel?.("custom", "local-id");
    expect(setComposerModel).toHaveBeenCalledWith("custom", "local-id");
  });

  it("reads what covers the thread and the list's order when asked, not when built", () => {
    let view: { covered: boolean; listOrder?: readonly string[] } | undefined;
    const { result } = renderHook(() => useWorkbenchActions(createMockOptions({ threadView: () => view })));
    expect(result.current.activeThread()?.covered).toBeUndefined();
    expect(result.current.threadListOrder?.()).toBeUndefined();
    view = { covered: true, listOrder: ["a", "b"] };
    expect(result.current.activeThread()?.covered).toBe(true);
    expect(result.current.threadListOrder?.()).toEqual(["a", "b"]);
  });

  it("dispatches abort to client when thread is running", () => {
    const client = { abort: vi.fn() };
    const options = createMockOptions({ client: client as any, isVisibleThreadRunning: () => true });
    const { result } = renderHook(() => useWorkbenchActions(options));

    result.current.abort();
    expect(client.abort).toHaveBeenCalledWith("thread-1");
  });

  it("delivers model-picker requests through the explicit action port", () => {
    const openModelPicker = vi.fn();
    const dispatchEvent = vi.spyOn(window, "dispatchEvent");
    const { result } = renderHook(() => useWorkbenchActions(createMockOptions({ openModelPicker })));

    result.current.openModelPicker?.();

    expect(openModelPicker).toHaveBeenCalledOnce();
    expect(dispatchEvent).not.toHaveBeenCalled();
    dispatchEvent.mockRestore();
  });

  it("focuses the composer, and shows the chat first when a folded one could not take the keyboard", () => {
    const composer = document.createElement("textarea");
    document.body.append(composer);
    const showThread = vi.fn();
    const options = createMockOptions({ composerRef: { current: composer }, showThread });
    const { result } = renderHook(() => useWorkbenchActions(options));

    result.current.focusComposer();
    expect(document.activeElement).toBe(composer);
    expect(showThread).not.toHaveBeenCalled();

    // Folded out of sight, it cannot take focus.
    composer.remove();
    result.current.focusComposer();
    expect(showThread).toHaveBeenCalledWith({ focusComposer: true });
  });

  it("focuses the supplied active transcript ref without consulting DOM class names", () => {
    const transcript = document.createElement("div");
    transcript.tabIndex = 0;
    document.body.append(transcript);
    const querySelector = vi.spyOn(document, "querySelector");
    const options = createMockOptions({ transcriptRef: { current: transcript } });
    const { result } = renderHook(() => useWorkbenchActions(options));

    result.current.focusTranscript();

    expect(document.activeElement).toBe(transcript);
    expect(querySelector).not.toHaveBeenCalled();
    querySelector.mockRestore();
    transcript.remove();
  });

  it("delegates stage focus and instructions through explicit callbacks", () => {
    const focusStage = vi.fn();
    const openInstructions = vi.fn();
    const querySelector = vi.spyOn(document, "querySelector");
    const dispatchEvent = vi.spyOn(window, "dispatchEvent");
    const { result } = renderHook(() => useWorkbenchActions(createMockOptions({ focusStage, openInstructions })));

    result.current.focusStage();
    result.current.openInstructions?.();

    expect(focusStage).toHaveBeenCalledOnce();
    expect(openInstructions).toHaveBeenCalledOnce();
    expect(querySelector).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
    querySelector.mockRestore();
    dispatchEvent.mockRestore();
  });

  it("manages composer holds count correctly", () => {
    const setComposerHolds = vi.fn();
    const options = createMockOptions({ setComposerHolds });
    const { result } = renderHook(() => useWorkbenchActions(options));

    const release = result.current.holdComposer();
    expect(setComposerHolds).toHaveBeenCalled();

    release();
    expect(setComposerHolds).toHaveBeenCalledTimes(2);
  });

  it("delegates executeCommand to options.executeCommand", async () => {
    const executeCommand = vi.fn().mockResolvedValue(undefined);
    const options = createMockOptions({ executeCommand });
    const { result } = renderHook(() => useWorkbenchActions(options));

    await result.current.executeCommand?.("runtime.open-prompt-editor");
    expect(executeCommand).toHaveBeenCalledWith("runtime.open-prompt-editor");
  });

  it("opens prompt editor and updates draft when modified", async () => {
    const openExternalEditor = vi.fn().mockResolvedValue({ text: "edited prompt", modified: true });
    const client = { openExternalEditor } as any;
    const setComposerSeed = vi.fn();
    const setNotice = vi.fn();
    const options = createMockOptions({ client, setComposerSeed, setNotice });
    const { result } = renderHook(() => useWorkbenchActions(options));

    await result.current.openPromptEditor?.();

    expect(openExternalEditor).toHaveBeenCalled();
    expect(setComposerSeed).toHaveBeenCalledWith("edited prompt");
    expect(setNotice).toHaveBeenCalledWith("Draft updated from external editor.");
  });

  it("cycles strictly through scoped favourite models when configured", async () => {
    const setComposerModel = vi.fn();
    const preferences = {
      getSnapshot: () => ({
        favouriteModels: ["google/gemini-2.5-flash"],
      }),
    } as any;
    const options = createMockOptions({ setComposerModel, preferences });
    const { result } = renderHook(() => useWorkbenchActions(options));

    const cycled = await result.current.cycleModel?.(1);
    expect(cycled).toBe(true);
    expect(setComposerModel).toHaveBeenCalledWith("google", "gemini-2.5-flash");
  });

  it("reads and replaces the draft's images, and writes a draft it sets through to storage", () => {
    const attachments = [{ id: 7, kind: "image", name: "a.png", mimeType: "image/png", data: "AAA", size: 3, previewUrl: "data:image/png;base64,AAA" }];
    const setAttachments = vi.fn();
    const storage = { get: vi.fn(() => undefined), set: vi.fn(), remove: vi.fn() };
    const { result } = renderHook(() => useWorkbenchActions(createMockOptions({
      platform: { storage } as any,
      composerScopeStore: { getSnapshot: () => ({ draft: "", attachments }), setDraft: vi.fn(), setAttachments } as any,
    })));
    expect(result.current.composerImages?.()).toEqual([{ kind: "image", name: "a.png", mimeType: "image/png", data: "AAA", size: 3 }]);
    result.current.setComposerImages?.([{ kind: "image", name: "b.gif", mimeType: "image/gif", data: "BBB", size: 3 }]);
    expect(setAttachments).toHaveBeenCalledWith("draft-1", [expect.objectContaining({ name: "b.gif", previewUrl: "data:image/gif;base64,BBB" })]);
    result.current.setComposerDraft?.("stashed away");
    expect(storage.set).toHaveBeenCalledWith("tau.composer-drafts.v1", JSON.stringify({ "draft-1": "stashed away" }));
  });

  it("starts a new thread in a named project without the picker, and leaves an unknown one alone", () => {
    const project = { path: "/work/app", workspaceId: "ws1_app", name: "app", lastOpenedAt: 1 };
    const createThreadInProject = vi.fn();
    const options = createMockOptions({
      threadStore: { getSnapshot: () => ({ activeThreadId: "thread-1", threads: [] }), getProjects: () => [project] } as any,
      createThreadInProject,
    });
    const { result } = renderHook(() => useWorkbenchActions(options));
    result.current.newSession({ workspace: "ws1_app" });
    expect(createThreadInProject).toHaveBeenCalledWith(project);
    result.current.newSession({ workspace: "ws1_unknown" });
    expect(createThreadInProject).toHaveBeenCalledTimes(1);
    expect(options.openNewThreadPicker).not.toHaveBeenCalled();
    result.current.newSession({ pick: true });
    expect(options.openNewThreadPicker).toHaveBeenCalledTimes(1);
  });

  describe("a new thread nobody named a project for", () => {
    const app = { path: "/work/app", workspaceId: "ws1_app", name: "app", lastOpenedAt: 1 };
    const site = { path: "/work/site", workspaceId: "ws1_site", name: "site", lastOpenedAt: 5 };
    const setup = (screen: { thread?: Partial<HostSnapshot>; draft?: object; covered?: boolean; projects?: object[] }) => {
      const createThreadInProject = vi.fn();
      const options = createMockOptions({
        threadStore: { getSnapshot: () => ({ activeThreadId: "", threads: [] }), getProjects: () => screen.projects ?? [app, site] } as any,
        viewStore: { getSnapshot: () => screen.thread } as any,
        pendingNewThread: screen.draft as any,
        threadView: () => ({ covered: Boolean(screen.covered) }),
        createThreadInProject,
      });
      renderHook(() => useWorkbenchActions(options)).result.current.newSession();
      return { createThreadInProject, picker: options.openNewThreadPicker };
    };

    it("opens in the project of the thread on screen", () => {
      expect(setup({ thread: { sessionId: "t", workspaceId: "ws1_app", cwd: "/work/app" } }).createThreadInProject).toHaveBeenCalledWith(app);
    });

    it("opens in the project of the draft on screen", () => {
      expect(setup({ thread: { sessionId: "t", workspaceId: "ws1_site" }, draft: { kind: "draft", draftId: "d", projectPath: "/work/app", workspaceId: "ws1_app", projectName: "app" } }).createThreadInProject).toHaveBeenCalledWith(app);
    });

    it("opens where the host last worked while a page covers the thread, and asks without a project", () => {
      expect(setup({ thread: { sessionId: "t", workspaceId: "ws1_app" }, covered: true }).createThreadInProject).toHaveBeenCalledWith(site);
      const none = setup({ thread: { sessionId: "t", workspaceId: "ws1_app" }, covered: true, projects: [] });
      expect(none.createThreadInProject).not.toHaveBeenCalled();
      expect(none.picker).toHaveBeenCalledTimes(1);
    });
  });

  it("starts a thread on another runtime: the draft moves, a thread opens a draft in its project", () => {
    const project = { path: "/path/to/project", workspaceId: "ws-1", name: "project" };
    const controller = { carryToNextDraft: vi.fn(), setModel: vi.fn(async () => undefined) };
    const luna = { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };
    const onThread = createMockOptions({
      threadStore: { getSnapshot: () => ({ activeThreadId: "thread-1" }), getProjects: () => [project] } as any,
      createThreadInProject: vi.fn(),
      preferences: { setNewThreadRuntime: vi.fn(), getSnapshot: () => ({}) } as any,
      newThreadController: controller,
      selectDraftRuntime: vi.fn(),
    });
    renderHook(() => useWorkbenchActions(onThread)).result.current.startThreadOn!("codex", luna);
    expect(controller.carryToNextDraft).toHaveBeenCalledWith("codex", luna);
    expect(onThread.preferences!.setNewThreadRuntime).toHaveBeenCalledWith("codex");
    expect(onThread.createThreadInProject).toHaveBeenCalledWith(project);
    expect(onThread.selectDraftRuntime).not.toHaveBeenCalled();

    const draft = { kind: "draft" as const, draftId: "d1", projectPath: "/p", workspaceId: "ws-2", projectName: "p" };
    const onDraft = createMockOptions({ pendingNewThread: draft, newThreadController: controller, selectDraftRuntime: vi.fn(), createThreadInProject: vi.fn() });
    renderHook(() => useWorkbenchActions(onDraft)).result.current.startThreadOn!("codex", luna);
    expect(onDraft.selectDraftRuntime).toHaveBeenCalledWith("codex");
    expect(controller.setModel).toHaveBeenCalledWith("openai", "gpt-5.6-luna", undefined, expect.any(Function), "codex");
    expect(onDraft.createThreadInProject).not.toHaveBeenCalled();

    // A project the window does not list yet (opened, no thread) is chosen in the picker.
    const unlisted = createMockOptions({ threadStore: { getSnapshot: () => ({}), getProjects: () => [] } as any, newThreadController: controller, createThreadInProject: vi.fn() });
    renderHook(() => useWorkbenchActions(unlisted)).result.current.startThreadOn!("codex");
    expect(unlisted.openNewThreadPicker).toHaveBeenCalledTimes(1);
    renderHook(() => useWorkbenchActions(unlisted)).result.current.newSession({ workspace: "ws-1" });
    expect(unlisted.openNewThreadPicker).toHaveBeenCalledTimes(1);
  });

  it("lists every runtime with the host's catalog, and the models the thread on screen offers for its own", async () => {
    const catalogs = [
      { kind: "pi", models: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }], thinkingLevels: {}, checkedAt: 1 },
      { kind: "codex", models: [], thinkingLevels: {}, status: "not-installed", checkedAt: 1 },
    ];
    const client = { abort: vi.fn(), onHostEvent: vi.fn(), runtimeCatalogs: vi.fn(async () => catalogs), runtimeCatalog: vi.fn() };
    const options = createMockOptions({
      client: client as any,
      snapshot: { sessionId: "sess-1", runtimeBackends: [{ kind: "pi", label: "Pi" }, { kind: "codex", label: "Codex" }] } as HostSnapshot,
    });
    const listed = await renderHook(() => useWorkbenchActions(options)).result.current.runtimeModels!();
    expect(client.runtimeCatalogs).toHaveBeenCalledWith(true, {});
    expect(listed.map((entry) => [entry.backend.kind, entry.catalog?.models.map((model) => model.id), entry.catalog?.status])).toEqual([
      ["pi", ["claude-3-7-sonnet", "gemini-2.5-flash"], undefined],
      ["codex", [], "not-installed"],
    ]);
  });
});
