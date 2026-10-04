// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerUseScreenService, ScreenState } from "./screen-protocol.js";
import { holdScreenService, previewView, useScreenFollower } from "./screen-store.js";

const state = (threadId: string, pid: number, windowId?: number): ScreenState =>
  ({ threadId, window: windowId === undefined ? undefined : { pid, windowId }, actions: [], canBringToFront: false, updatedAt: 1 });

afterEach(() => {
  cleanup();
  previewView.set("browser");
});

describe("useScreenFollower", () => {
  it.each([true, false])("follows each driven window with workspace preview available=%s", (workspacePreviewAvailable) => {
    const listeners = new Set<(next: ScreenState) => void>();
    const release = holdScreenService({ subscribe: (listener: (next: ScreenState) => void) => { listeners.add(listener); return () => listeners.delete(listener); } } as unknown as ComputerUseScreenService);
    const actions = { openPanel: vi.fn(), activeThread: () => ({ sessionId: "active", draftPending: false }) };
    renderHook(() => useScreenFollower(actions, "preview", workspacePreviewAvailable));
    const push = (next: ScreenState) => act(() => { listeners.forEach((listener) => listener(next)); });

    push(state("other", 1, 1));
    push(state("active", 1));
    expect(actions.openPanel).not.toHaveBeenCalled();

    push(state("active", 1, 1));
    expect(actions.openPanel).toHaveBeenCalledTimes(workspacePreviewAvailable ? 0 : 1);
    expect(previewView.get()).toBe("screen");

    // The user went back to the browser; more steps in the same window leave it there.
    act(() => previewView.set("browser"));
    push(state("active", 1, 1));
    expect(previewView.get()).toBe("browser");
    push(state("active", 2, 5));
    expect(previewView.get()).toBe("screen");
    expect(actions.openPanel).toHaveBeenCalledTimes(workspacePreviewAvailable ? 0 : 2);
    release();
  });
});
