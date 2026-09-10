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
    composerScopeStore: { getSnapshot: vi.fn().mockReturnValue({ draft: "test draft" }) } as any,
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
    closeActiveStageTab: vi.fn(),
    cycleStageTab: vi.fn(),
    openOverlay: vi.fn(),
    closeOverlay: vi.fn(),
    openWorkspace: vi.fn(),
    openFile: vi.fn(),
    openThread: vi.fn(),
    setComposerHolds: vi.fn(),
    setComposerModel: vi.fn(),
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

  it("manages composer holds count correctly", () => {
    const setComposerHolds = vi.fn();
    const options = createMockOptions({ setComposerHolds });
    const { result } = renderHook(() => useWorkbenchActions(options));

    const release = result.current.holdComposer();
    expect(setComposerHolds).toHaveBeenCalled();

    release();
    expect(setComposerHolds).toHaveBeenCalledTimes(2);
  });
});
