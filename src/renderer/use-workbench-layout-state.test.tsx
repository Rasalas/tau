// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiSession } from "../shared/contracts";
import { createMemoryStorage, type ClientStorage } from "../workbench/client-storage";
import { openFileTab, openThreadTab, EMPTY_STAGE } from "../workbench/stage";
import { dockStateKey, stageStateKey, threadStageKey } from "../workbench/storage-keys";
import { ThreadStages } from "../workbench/thread-stages";
import { useWorkbenchLayoutState, type WorkbenchLayoutStateOptions } from "./use-workbench-layout-state";

const workspace = "/repo";

function thread(id: string, modifiedAt: number, projectPath = workspace): UiSession {
  return { id, path: `/sessions/${id}.jsonl`, title: id, modifiedAt, projectPath, projectName: "repo", messageCount: 1 };
}

function setup(storage: ClientStorage = createMemoryStorage(), threads: UiSession[] = []) {
  const stages = new ThreadStages({ storage, threads: () => threads, drafts: () => [] });
  const options = (owner: string | undefined, extra: Partial<WorkbenchLayoutStateOptions> = {}): WorkbenchLayoutStateOptions => ({
    storage, stages, owner, workspaceKey: workspace, workspacePath: workspace, knownThreadIds: [], panelIds: ["files", "terminal"], ...extra,
  });
  const hook = renderHook((props: WorkbenchLayoutStateOptions) => useWorkbenchLayoutState(props), { initialProps: options("thread:a") });
  return { storage, stages, options, ...hook };
}

describe("useWorkbenchLayoutState dock restore", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("keeps a restored panel whose kit activates after another kit's panel", () => {
    const storage = createMemoryStorage();
    storage.set(dockStateKey(workspace), JSON.stringify({ open: true, activePanel: "terminal", openedPanels: ["agents", "terminal"] }));
    const stages = new ThreadStages({ storage, threads: () => [], drafts: () => [] });
    const options = (panelIds: readonly string[]): WorkbenchLayoutStateOptions => ({
      storage, stages, owner: "thread:a", workspaceKey: workspace, workspacePath: workspace, knownThreadIds: [], panelIds,
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
    const stages = new ThreadStages({ storage, threads: () => [], drafts: () => [] });
    const { result } = renderHook(() => useWorkbenchLayoutState({
      storage, stages, owner: "thread:a", workspaceKey: workspace, workspacePath: workspace, knownThreadIds: [], panelIds: ["agents"],
    }));
    expect(result.current.activePanel).toBe("agents");
    expect(result.current.openedPanels).toEqual(["agents"]);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(JSON.parse(storage.get(dockStateKey(workspace)) ?? "{}")).toEqual({ openedPanels: [] });
  });

  it("writes a panel the user picks", () => {
    const { result, storage } = setup();
    act(() => { result.current.setActivePanel("terminal"); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(JSON.parse(storage.get(dockStateKey(workspace)) ?? "{}")).toMatchObject({ activePanel: "terminal", openedPanels: ["terminal"] });
  });
});

describe("useWorkbenchLayoutState per thread", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("shows A's tabs again after A → B → A, and B's own in between", () => {
    const { result, rerender, options } = setup();
    act(() => { result.current.setStage((stage) => openThreadTab(openFileTab(stage, "src/a.ts", { pin: true }), "child", { pin: true })); });
    act(() => { result.current.setStage((stage) => ({ ...stage, activeId: "file:src/a.ts" })); });
    act(() => { result.current.setStageMaximized(true); });
    act(() => { result.current.setActivePanel("files"); result.current.setDockOpen(true); });

    // Switched away before the deferred write: the switch itself keeps A's layout.
    rerender(options("thread:b"));
    expect(result.current.stage).toEqual(EMPTY_STAGE);
    expect(result.current.stageMaximized).toBe(false);
    expect(result.current.dockOpen).toBe(false);
    act(() => { result.current.setStage((stage) => openFileTab(stage, "src/b.ts", { pin: true })); });

    rerender(options("thread:a"));
    expect(result.current.stage.tabs.map((tab) => tab.id)).toEqual(["file:src/a.ts", "thread:child"]);
    expect(result.current.stage.activeId).toBe("file:src/a.ts");
    expect(result.current.stageMaximized).toBe(true);
    expect(result.current.dockOpen).toBe(true);
    expect(result.current.activePanel).toBe("files");

    rerender(options("thread:b"));
    expect(result.current.stage.tabs.map((tab) => tab.id)).toEqual(["file:src/b.ts"]);
  });

  it("brings a thread's layout back after a restart", () => {
    const first = setup();
    act(() => { first.result.current.setStage((stage) => openFileTab(stage, "src/a.ts", { pin: true })); });
    act(() => { vi.advanceTimersByTime(1000); });
    first.unmount();

    const again = setup(first.storage);
    expect(again.result.current.stage.tabs.map((tab) => tab.id)).toEqual(["file:src/a.ts"]);
    expect(again.result.current.stageWorkspace).toBe(workspace);
  });

  it("gives a draft a stage of its own, and hands it to the thread it becomes", () => {
    const { result, rerender, options, stages, storage } = setup();
    act(() => { result.current.setStage((stage) => openFileTab(stage, "src/a.ts", { pin: true })); });

    rerender(options("draft:d1"));
    expect(result.current.stage).toEqual(EMPTY_STAGE);
    act(() => { result.current.setStage((stage) => openFileTab(stage, "notes.md", { pin: true })); });

    // The first message made thread `t9`: the draft's tabs stay on screen and are that thread's now.
    act(() => { stages.promote("d1", "t9"); });
    rerender(options("thread:t9"));
    expect(result.current.stage.tabs.map((tab) => tab.id)).toEqual(["file:notes.md"]);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(JSON.parse(storage.get(threadStageKey("thread:t9")) ?? "{}").tabs).toHaveLength(1);
    expect(storage.get(threadStageKey("draft:d1"))).toBeNull();

    rerender(options("thread:a"));
    expect(result.current.stage.tabs.map((tab) => tab.id)).toEqual(["file:src/a.ts"]);
  });

  it("keeps the dock's width per project, shared by its threads", () => {
    const { result, rerender, options } = setup();
    act(() => { result.current.setDockWidth(420); });
    rerender(options("thread:b"));
    expect(result.current.dockWidth).toBe(420);
  });

  it("hands the project's old stage to the thread shown first, and to no other", () => {
    const storage = createMemoryStorage();
    storage.set(stageStateKey(workspace), JSON.stringify({ tabs: [{ id: "file:src/old.ts", kind: "file", path: "src/old.ts", view: "source", preview: false }] }));
    storage.set(dockStateKey(workspace), JSON.stringify({ open: true, activePanel: "files", openedPanels: ["files"], width: 360 }));
    const { result, rerender, options } = setup(storage, [thread("a", 1), thread("b", 2)]);

    expect(result.current.stage.tabs.map((tab) => tab.id)).toEqual(["file:src/old.ts"]);
    expect(result.current.dockOpen).toBe(true);
    expect(storage.get(stageStateKey(workspace))).toBeNull();
    expect(JSON.parse(storage.get(dockStateKey(workspace)) ?? "{}")).toEqual({ activePanel: "files", openedPanels: ["files"], width: 360 });

    rerender(options("thread:b"));
    expect(result.current.stage).toEqual(EMPTY_STAGE);
    expect(result.current.dockOpen).toBe(false);
    expect(result.current.dockWidth).toBe(360);
  });
});
