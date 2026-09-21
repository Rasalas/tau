import { describe, expect, it } from "vitest";
import {
  activeTab, closeTab, cycleTab, EMPTY_STAGE, extensionTabId, fileTabId, openExtensionTab, openFileTab,
  openThreadTab, otherTabIds, pinTab, setExtensionTabDirty, setExtensionTabTitle, setFileView, stageParamsKey,
  tabIdsToTheRight, threadTabId, unpinTab,
} from "./stage";

const A = "/repo/src/a.ts";
const B = "/repo/src/b.ts";
const C = "/repo/src/c.ts";

describe("stage tabs", () => {
  it("replaces a preview tab with the next preview instead of piling tabs up", () => {
    const state = openFileTab(openFileTab(EMPTY_STAGE, A), B);
    expect(state.tabs.map((tab) => tab.id)).toEqual([fileTabId(B)]);
    expect(state.activeId).toBe(fileTabId(B));
  });

  it("keeps pinned tabs and inserts the new one after the active tab", () => {
    let state = openFileTab(EMPTY_STAGE, A, { pin: true });
    state = openFileTab(state, C, { pin: true });
    state = openFileTab(state, A);
    state = openFileTab(state, B);
    expect(state.tabs.map((tab) => tab.id)).toEqual([fileTabId(A), fileTabId(B), fileTabId(C)]);
    expect(activeTab(state)).toMatchObject({ path: B, preview: true });
  });

  it("pins a preview when it is opened again with pin or via pinTab", () => {
    const preview = openFileTab(EMPTY_STAGE, A);
    expect(activeTab(preview)).toMatchObject({ preview: true });
    expect(activeTab(openFileTab(preview, A, { pin: true }))).toMatchObject({ preview: false });
    expect(activeTab(pinTab(preview, fileTabId(A)))).toMatchObject({ preview: false });
  });

  it("switches an existing tab to the requested view without duplicating it", () => {
    let state = openFileTab(EMPTY_STAGE, A, { pin: true });
    state = openFileTab(state, A, { view: "diff" });
    expect(state.tabs).toHaveLength(1);
    expect(activeTab(state)).toMatchObject({ view: "diff", preview: false });
    expect(activeTab(setFileView(state, fileTabId(A), "source"))).toMatchObject({ view: "source" });
  });

  it("opens a diff tab as a preview like any other file", () => {
    const state = openFileTab(openFileTab(EMPTY_STAGE, A), B, { view: "diff" });
    expect(state.tabs).toHaveLength(1);
    expect(activeTab(state)).toMatchObject({ path: B, view: "diff", preview: true });
  });

  it("activates the right-hand neighbour when the active tab closes, then the left one", () => {
    let state = openFileTab(EMPTY_STAGE, A, { pin: true });
    state = openFileTab(state, B, { pin: true });
    state = openFileTab(state, C, { pin: true });
    state = closeTab({ ...state, activeId: fileTabId(B) }, fileTabId(B));
    expect(state.activeId).toBe(fileTabId(C));
    state = closeTab(state, fileTabId(C));
    expect(state.activeId).toBe(fileTabId(A));
    state = closeTab(state, fileTabId(A));
    expect(state).toEqual({ tabs: [], activeId: undefined });
  });

  it("closing an inactive tab leaves the selection alone", () => {
    let state = openFileTab(EMPTY_STAGE, A, { pin: true });
    state = openFileTab(state, B, { pin: true });
    expect(closeTab(state, fileTabId(A)).activeId).toBe(fileTabId(B));
  });
});

describe("thread tabs", () => {
  const CHILD = "child-thread";

  it("opens a thread as a preview that the next preview replaces", () => {
    let state = openThreadTab(EMPTY_STAGE, CHILD);
    expect(activeTab(state)).toMatchObject({ id: threadTabId(CHILD), kind: "thread", sessionId: CHILD, preview: true });
    state = openFileTab(state, A);
    expect(state.tabs.map((tab) => tab.id)).toEqual([fileTabId(A)]);
  });

  it("keeps a pinned thread beside the files and activates it again instead of duplicating it", () => {
    let state = openFileTab(EMPTY_STAGE, A, { pin: true });
    state = openThreadTab(state, CHILD, { pin: true });
    state = openFileTab(state, B, { pin: true });
    state = openThreadTab(state, CHILD);
    expect(state.tabs.map((tab) => tab.id)).toEqual([fileTabId(A), threadTabId(CHILD), fileTabId(B)]);
    expect(state.activeId).toBe(threadTabId(CHILD));
    expect(activeTab(state)).toMatchObject({ preview: false });
  });

  it("pins a previewed thread through pinTab and through opening it with pin", () => {
    const preview = openThreadTab(EMPTY_STAGE, CHILD);
    expect(activeTab(pinTab(preview, threadTabId(CHILD)))).toMatchObject({ preview: false });
    expect(activeTab(openThreadTab(preview, CHILD, { pin: true }))).toMatchObject({ preview: false });
  });

  it("closes a thread tab the way it closes a file tab", () => {
    let state = openFileTab(EMPTY_STAGE, A, { pin: true });
    state = openThreadTab(state, CHILD, { pin: true });
    state = closeTab(state, threadTabId(CHILD));
    expect(state.tabs.map((tab) => tab.id)).toEqual([fileTabId(A)]);
    expect(state.activeId).toBe(fileTabId(A));
  });

  it("leaves a thread tab alone when a file view is requested for it", () => {
    const state = openThreadTab(EMPTY_STAGE, CHILD, { pin: true });
    expect(setFileView(state, threadTabId(CHILD), "diff")).toEqual(state);
  });

  it("cycles through tabs forward and backward wrapping around", () => {
    let state = openFileTab(EMPTY_STAGE, A, { pin: true });
    state = openFileTab(state, B, { pin: true });
    state = openFileTab(state, C, { pin: true });
    expect(state.activeId).toBe(fileTabId(C));

    // Next from C wraps to A
    state = cycleTab(state, 1);
    expect(state.activeId).toBe(fileTabId(A));

    // Next from A goes to B
    state = cycleTab(state, 1);
    expect(state.activeId).toBe(fileTabId(B));

    // Prev from B goes to A
    state = cycleTab(state, -1);
    expect(state.activeId).toBe(fileTabId(A));

    // Prev from A wraps to C
    state = cycleTab(state, -1);
    expect(state.activeId).toBe(fileTabId(C));
  });
});


describe("extension tabs", () => {
  const TERMINAL = { tabKind: "terminal", key: "t1", params: { id: "t1" }, title: "zsh" };
  const ID = extensionTabId("terminal", "t1");

  it("opens pinned, because an extension tab is opened by a deliberate action", () => {
    const state = openExtensionTab(EMPTY_STAGE, TERMINAL);
    expect(activeTab(state)).toMatchObject({ id: ID, kind: "extension", tabKind: "terminal", title: "zsh", preview: false });
    expect(openFileTab(state, A).tabs.map((tab) => tab.id)).toEqual([ID, fileTabId(A)]);
  });

  it("takes the one preview slot when its opener asks for it", () => {
    let state = openExtensionTab(EMPTY_STAGE, TERMINAL, { preview: true });
    expect(activeTab(state)).toMatchObject({ preview: true });
    state = openFileTab(state, A);
    expect(state.tabs.map((tab) => tab.id)).toEqual([fileTabId(A)]);
  });

  it("reopens the same tab with fresh params instead of a second one", () => {
    let state = openExtensionTab(EMPTY_STAGE, TERMINAL, { preview: true });
    state = openFileTab(state, A, { pin: true });
    state = openExtensionTab(state, { ...TERMINAL, params: { id: "t1", cwd: "/repo" }, title: "zsh · repo" });
    expect(state.tabs).toHaveLength(2);
    expect(state.activeId).toBe(ID);
    expect(activeTab(state)).toMatchObject({ params: { id: "t1", cwd: "/repo" }, title: "zsh · repo", preview: false });
  });

  it("keeps different keys of one kind apart and follows the pin and close rules", () => {
    let state = openExtensionTab(EMPTY_STAGE, TERMINAL);
    state = openExtensionTab(state, { ...TERMINAL, key: "t2", params: { id: "t2" }, title: "bash" });
    expect(state.tabs.map((tab) => tab.id)).toEqual([ID, extensionTabId("terminal", "t2")]);
    state = closeTab(state, extensionTabId("terminal", "t2"));
    expect(state.tabs.map((tab) => tab.id)).toEqual([ID]);
    expect(setFileView(state, ID, "diff")).toEqual(state);
  });

  it("renames itself and carries a dirty mark", () => {
    let state = openExtensionTab(EMPTY_STAGE, TERMINAL);
    state = setExtensionTabTitle(state, ID, "zsh · building");
    expect(activeTab(state)).toMatchObject({ title: "zsh · building" });
    expect(setExtensionTabTitle(state, ID, "zsh · building")).toBe(state);
    state = setExtensionTabDirty(state, ID, true);
    expect(activeTab(state)).toMatchObject({ dirty: true });
    expect(setExtensionTabDirty(state, ID, true)).toBe(state);
    expect(activeTab(setExtensionTabDirty(state, ID, false))).toMatchObject({ dirty: false });
  });

  it("leaves a tab of another kind alone", () => {
    const state = openThreadTab(EMPTY_STAGE, "child", { pin: true });
    expect(setExtensionTabTitle(state, threadTabId("child"), "nope")).toBe(state);
    expect(setExtensionTabDirty(state, threadTabId("child"), true)).toBe(state);
  });

  it("keys a tab by its params, whatever order they were written in", () => {
    expect(stageParamsKey({ a: 1, b: { d: 4, c: 3 } })).toBe(stageParamsKey({ b: { c: 3, d: 4 }, a: 1 }));
    expect(stageParamsKey({ a: 1, b: undefined })).toBe(stageParamsKey({ a: 1 }));
    expect(stageParamsKey({ a: 1 })).not.toBe(stageParamsKey({ a: 2 }));
  });
});

describe("the tab strip's own commands", () => {
  it("moves the preview slot to the tab that is unpinned", () => {
    let state = openFileTab(EMPTY_STAGE, A, { pin: true });
    state = openFileTab(state, B);
    state = unpinTab(state, fileTabId(A));
    expect(state.tabs.map((tab) => tab.preview)).toEqual([true, false]);
    expect(unpinTab(state, fileTabId(A))).toBe(state);
  });

  it("names what close-others and close-to-the-right would remove", () => {
    let state = openFileTab(EMPTY_STAGE, A, { pin: true });
    state = openFileTab(state, B, { pin: true });
    state = openFileTab(state, C, { pin: true });
    expect(otherTabIds(state, fileTabId(B))).toEqual([fileTabId(A), fileTabId(C)]);
    expect(tabIdsToTheRight(state, fileTabId(B))).toEqual([fileTabId(C)]);
    expect(tabIdsToTheRight(state, fileTabId(C))).toEqual([]);
    expect(otherTabIds(state, "nothing")).toEqual([]);
    expect(tabIdsToTheRight(state, "nothing")).toEqual([]);
  });
});
