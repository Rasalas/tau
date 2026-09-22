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
});
