// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { STORAGE_KEYS, threadStageKey } from "../workbench/storage-keys";
import { createLocalStorageAdapter } from "./browser-storage";

afterEach(() => localStorage.clear());

describe("client storage on a page that shows another machine", () => {
  it("keeps that host's state apart and shares the window's own", () => {
    const own = createLocalStorageAdapter();
    const studio = createLocalStorageAdapter("studio");
    own.set(STORAGE_KEYS.composerDrafts, "laptop drafts");
    own.set(STORAGE_KEYS.sidebarWidth, "280");
    studio.set(STORAGE_KEYS.composerDrafts, "studio drafts");
    expect(own.get(STORAGE_KEYS.composerDrafts)).toBe("laptop drafts");
    expect(studio.get(STORAGE_KEYS.composerDrafts)).toBe("studio drafts");
    expect(studio.get(STORAGE_KEYS.sidebarWidth)).toBe("280");
    expect(localStorage.getItem(`${STORAGE_KEYS.composerDrafts}@studio`)).toBe("studio drafts");
  });

  it("lists only the keys that page can read, by their plain names", () => {
    const own = createLocalStorageAdapter();
    const studio = createLocalStorageAdapter("studio");
    own.set(STORAGE_KEYS.bootstrapCache, "a");
    studio.set(STORAGE_KEYS.bootstrapCache, "b");
    createLocalStorageAdapter("attic").set(STORAGE_KEYS.bootstrapCache, "c");
    own.set("tau.stage.v1:ws-1", "stage");
    expect(own.keys("tau.").sort()).toEqual([STORAGE_KEYS.bootstrapCache, "tau.stage.v1:ws-1"].sort());
    expect(studio.keys("tau.").sort()).toEqual([STORAGE_KEYS.bootstrapCache, "tau.stage.v1:ws-1"].sort());
    studio.remove(STORAGE_KEYS.bootstrapCache);
    expect(own.get(STORAGE_KEYS.bootstrapCache)).toBe("a");
  });

  it("keeps each machine's thread stages apart, so one page's cleanup never reaches another's", () => {
    const own = createLocalStorageAdapter();
    const studio = createLocalStorageAdapter("studio");
    own.set(threadStageKey("thread:t1"), "laptop");
    studio.set(threadStageKey("thread:t2"), "studio");
    expect(own.keys(`${STORAGE_KEYS.threadStage}:`)).toEqual([threadStageKey("thread:t1")]);
    expect(studio.keys(`${STORAGE_KEYS.threadStage}:`)).toEqual([threadStageKey("thread:t2")]);
  });
});
