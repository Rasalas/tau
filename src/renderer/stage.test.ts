import { describe, expect, it } from "vitest";
import { activeTab, closeTab, EMPTY_STAGE, fileTabId, openFileTab, openThreadTab, pinTab, setFileView, threadTabId } from "./stage";

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
});

