// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElectronPlatform } from "./platform-electron";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { STORAGE_KEYS, threadStageKey } from "../workbench/storage-keys";
import { createLocalStorageAdapter } from "./browser-storage";
import { readSubmittedMessages, writeSubmittedMessages } from "../workbench/submitted-messages";
import { buildOptimisticMessage } from "../workbench/submission-optimistic";
import { createNewThreadRequestId } from "../shared/contracts";

class MemoryWebStorage {
  [key: string]: unknown;
  getItem(key: string): string | null { return typeof this[key] === "string" ? this[key] as string : null; }
  setItem(key: string, value: string): void { this[key] = value; }
  removeItem(key: string): void { delete this[key]; }
  clear(): void { for (const key of Object.keys(this)) delete this[key]; }
  key(index: number): string | null { return Object.keys(this)[index] ?? null; }
  get length(): number { return Object.keys(this).length; }
}
beforeEach(() => vi.stubGlobal("localStorage", new MemoryWebStorage()));
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

describe("client storage on a page that shows another machine", () => {
  it("keeps unconfirmed messages with their own host", () => {
    const own = createLocalStorageAdapter();
    const remote = createLocalStorageAdapter("rex");
    writeSubmittedMessages(remote, [{ scope: "session:one", message: buildOptimisticMessage({ text: "remote message" }).optimistic, input: { text: "remote message" }, requestId: createNewThreadRequestId("request-one") }]);
    expect(readSubmittedMessages(remote)).toHaveLength(1);
    expect(readSubmittedMessages(own)).toEqual([]);
  });

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

  it("keeps the closed notice about unavailable extensions apart per machine", () => {
    const own = createLocalStorageAdapter();
    const studio = createLocalStorageAdapter("studio");
    studio.set(STORAGE_KEYS.unavailableExtensions, '["tau.terminal"]');
    expect(own.get(STORAGE_KEYS.unavailableExtensions)).toBeNull();
    expect(localStorage.getItem(`${STORAGE_KEYS.unavailableExtensions}@studio`)).toBe('["tau.terminal"]');
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


it("scopes extension keys marked for the host without sharing cached private requests", () => {
  const key = "host:package.saved-requests.v1";
  const own = createLocalStorageAdapter();
  const studio = createLocalStorageAdapter("studio");
  own.set(key, "local request");
  studio.set(key, "studio request");
  expect(own.get(key)).toBe("local request");
  expect(studio.get(key)).toBe("studio request");
  expect(createLocalStorageAdapter("attic").get(key)).toBeNull();
  expect(own.keys("host:")).toEqual([key]);
  expect(studio.keys("host:")).toEqual([key]);
  studio.remove(key);
  expect(own.get(key)).toBe("local request");
});


it("clears machine-owned extension data when the desktop forgets a saved machine", async () => {
  const key = "host:package.saved-requests.v1";
  const storage = createLocalStorageAdapter();
  storage.set(key, "local");
  createLocalStorageAdapter("studio").set(key, "studio");
  createLocalStorageAdapter("attic").set(key, "attic");
  const platform = createElectronPlatform({ storage, client: createFakeHostClient(), openInEditor: () => undefined, hasLocalFiles: () => true });
  await platform.environments!.remove("studio");
  expect(createLocalStorageAdapter("studio").get(key)).toBeNull();
  expect(storage.get(key)).toBe("local");
  expect(createLocalStorageAdapter("attic").get(key)).toBe("attic");
});
