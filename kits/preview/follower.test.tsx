// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { EMPTY_PREVIEW_STATE } from "./protocol.js";
import { PreviewFollower, previewStore } from "./store.js";
import { previewView, screenService } from "./screen-store.js";

afterEach(() => {
  cleanup();
  previewStore.set(EMPTY_PREVIEW_STATE);
  previewView.set("browser");
  screenService.set(undefined);
});

describe("browser preview follower", () => {
  it.each([true, false])("follows navigation with workspace preview available=%s", (workspacePreviewAvailable) => {
    const openPanel = vi.fn();
    render(<PreviewFollower actions={{ openPanel } as unknown as WorkbenchActions} workspacePreviewAvailable={workspacePreviewAvailable} />);
    act(() => previewView.set("screen"));
    act(() => previewStore.set({ ...EMPTY_PREVIEW_STATE, url: "http://localhost:3000/first" }));
    expect(previewView.get()).toBe("browser");
    act(() => previewStore.set({ ...EMPTY_PREVIEW_STATE, url: "http://localhost:3000/second" }));
    expect(openPanel).toHaveBeenCalledTimes(workspacePreviewAvailable ? 0 : 2);
  });
});
