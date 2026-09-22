// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../workbench/client-storage";
import { dockStateKey } from "../workbench/storage-keys";
import { useWorkbenchLayoutState, type WorkbenchLayoutStateOptions } from "./use-workbench-layout-state";

const workspace = "/repo";

describe("useWorkbenchLayoutState dock restore", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("keeps a restored panel whose kit activates after another kit's panel", () => {
    const storage = createMemoryStorage();
    const stored = { open: true, activePanel: "terminal", openedPanels: ["agents", "terminal"] };
    storage.set(dockStateKey(workspace), JSON.stringify(stored));
    const options = (panelIds: readonly string[]): WorkbenchLayoutStateOptions => ({
      storage, workspaceKey: workspace, workspacePath: workspace, knownThreadIds: [], panelIds,
    });

    // Kits activate one at a time: the Agents panel is offered before the Terminal one.
    const { result, rerender } = renderHook((props: WorkbenchLayoutStateOptions) => useWorkbenchLayoutState(props), {
      initialProps: options([]),
    });
    rerender(options(["agents"]));
    expect(result.current.activePanel).toBe("agents");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(JSON.parse(storage.get(dockStateKey(workspace)) ?? "{}")).toMatchObject({ activePanel: "terminal" });

    rerender(options(["agents", "terminal"]));
    expect(result.current.activePanel).toBe("terminal");
    expect(result.current.dockOpen).toBe(true);
  });

  it("mounts the stand-in panel without recording it as opened", () => {
    const storage = createMemoryStorage();
    const { result } = renderHook(() => useWorkbenchLayoutState({
      storage, workspaceKey: workspace, workspacePath: workspace, knownThreadIds: [], panelIds: ["agents"],
    }));
    expect(result.current.activePanel).toBe("agents");
    expect(result.current.openedPanels).toEqual(["agents"]);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(JSON.parse(storage.get(dockStateKey(workspace)) ?? "{}")).toEqual({ open: false, openedPanels: [] });
  });

  it("writes a panel the user picks", () => {
    const storage = createMemoryStorage();
    const { result } = renderHook(() => useWorkbenchLayoutState({
      storage, workspaceKey: workspace, workspacePath: workspace, knownThreadIds: [], panelIds: ["agents", "terminal"],
    }));
    act(() => { result.current.setActivePanel("terminal"); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(JSON.parse(storage.get(dockStateKey(workspace)) ?? "{}")).toMatchObject({ activePanel: "terminal", openedPanels: ["terminal"] });
  });
});
