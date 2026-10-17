// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../workbench/client-storage";
import { EMPTY_STAGE, openFileTab } from "../workbench/stage";
import { STORAGE_KEYS, threadStageKey } from "../workbench/storage-keys";
import { ThreadStages } from "../workbench/thread-stages";
import { useWorkbenchLayoutState } from "./use-workbench-layout-state";
import { useRendererLayout } from "./use-renderer-layout";
import { workbenchDisplay, type LayoutSpace } from "./workbench-layout";

const space: LayoutSpace = {
  windowWidth: 1440, sidebarWidth: 248, profile: "desktop", compactForm: "single",
  tabCount: 1, showStartScreen: false, workspaceSummaryAvailable: false,
};

function setup(storage = createMemoryStorage(), initial: { owner: string | undefined } = { owner: "thread:a" }) {
  const stages = new ThreadStages({ storage, threads: () => [], drafts: () => [] });
  const hook = renderHook(({ owner }: { owner: string | undefined }) => {
    const saved = useWorkbenchLayoutState({ storage, stages, owner, workspaceKey: "/project", workspacePath: "/project", knownThreadIds: [], panelIds: [] });
    const layout = useRendererLayout({ storage, owner, restoredOwner: saved.restoredOwner,
      tabCount: saved.stage.tabs.length, stageFolded: saved.stageFolded, stageMaximized: saved.stageMaximized,
      setStageFolded: saved.setStageFolded, setStageMaximized: saved.setStageMaximized });
    return { ...saved, ...layout };
  }, { initialProps: initial });
  return { ...hook, storage };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("renderer layout persistence and navigation", () => {
  it("keeps a restored maximize and spine through an empty first paint and persists explicit changes", () => {
    const storage = createMemoryStorage();
    const stage = openFileTab(EMPTY_STAGE, "notes.txt", { pin: true });
    storage.set(threadStageKey("thread:a"), JSON.stringify({ ...stage, maximized: true }));
    storage.set(STORAGE_KEYS.spine, "true");
    const { result, rerender } = setup(storage, { owner: undefined });
    expect(result.current.preferences.spineWanted).toBe(true);
    rerender({ owner: "thread:a" });
    expect(result.current.preferences).toMatchObject({ spineWanted: true, stageMaximized: true });
    expect(workbenchDisplay(result.current.preferences, space)).toMatchObject({ spine: true, conversationFolded: true });

    act(() => result.current.send({ type: "reveal-conversation", stacked: true }));
    act(() => vi.advanceTimersByTime(500));
    expect(storage.get(STORAGE_KEYS.spine)).toBe("false");
    expect(JSON.parse(storage.get(threadStageKey("thread:a"))!).maximized).toBeUndefined();
    expect(workbenchDisplay(result.current.preferences, space)).toMatchObject({ conversationFolded: false, stageExpanded: true });
  });

  it("retains each owner's folded stage, restores chat on navigation and preserves tab contents", () => {
    const { result, rerender, storage } = setup();
    act(() => result.current.setStage(openFileTab(EMPTY_STAGE, "a.txt", { pin: true })));
    act(() => result.current.send({ type: "maximize-stage" }));
    rerender({ owner: "thread:b" });
    expect(result.current.stage.tabs).toHaveLength(0);
    expect(result.current.preferences).toMatchObject({ chatFocused: true, stageMaximized: false });
    act(() => result.current.setStage(openFileTab(EMPTY_STAGE, "b.txt", { pin: true })));
    act(() => result.current.send({ type: "show-stage" }));
    act(() => result.current.send({ type: "toggle-stage", space }));
    rerender({ owner: "thread:a" });
    expect(result.current.stage.tabs.map((tab) => tab.id)).toEqual(["file:a.txt"]);
    expect(result.current.preferences).toMatchObject({ stageFolded: false, stageMaximized: false, chatFocused: true });
    rerender({ owner: "thread:b" });
    expect(result.current.stage.tabs.map((tab) => tab.id)).toEqual(["file:b.txt"]);
    expect(result.current.preferences.stageFolded).toBe(true);
    act(() => vi.advanceTimersByTime(500));
    expect(JSON.parse(storage.get(threadStageKey("thread:b"))!)).toMatchObject({ folded: true });
  });

  it("ends maximize and spine when the last tab closes but keeps the initial spine until tabs arrive", () => {
    const storage = createMemoryStorage();
    storage.set(STORAGE_KEYS.spine, "true");
    const { result } = setup(storage);
    expect(result.current.preferences.spineWanted).toBe(true);
    act(() => result.current.setStage(openFileTab(EMPTY_STAGE, "a.txt")));
    act(() => result.current.send({ type: "maximize-stage" }));
    act(() => result.current.setStage(EMPTY_STAGE));
    expect(result.current.preferences).toMatchObject({ spineWanted: false, stageMaximized: false });
    expect(storage.get(STORAGE_KEYS.spine)).toBe("false");
  });

  it("applies consecutive actions to the latest choice without changing stable action identities", () => {
    const { result, rerender } = setup();
    const send = result.current.send;
    act(() => { send({ type: "toggle-spine" }); send({ type: "toggle-spine" }); });
    expect(result.current.preferences.spineWanted).toBe(false);
    act(() => { send({ type: "set-stage-shown", shown: (shown) => !shown }); send({ type: "set-stage-shown", shown: (shown) => !shown }); });
    expect(result.current.preferences.stageFolded).toBe(false);
    const layout = result.current.preferences;
    rerender({ owner: "thread:a" });
    expect(result.current.send).toBe(send);
    expect(result.current.preferences).toBe(layout);
  });
});
