// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { PreferencesStore } from "./preferences";
import { STORAGE_KEYS } from "../workbench/storage-keys";
import { createMemoryStorage, setClientStorage, type ClientStorage } from "../workbench/client-storage";

let preferences: PreferencesStore;
let storage: ClientStorage;

beforeEach(() => {
  storage = createMemoryStorage();
  setClientStorage(storage);
  preferences = new PreferencesStore();
});

describe("settled threads", () => {
  it("can be idempotently returned to active when work resumes", () => {
    preferences.toggleSettled("thread");
    expect(preferences.isSettled("thread")).toBe(true);
    preferences.unsettle("thread");
    preferences.unsettle("thread");
    expect(preferences.isSettled("thread")).toBe(false);
  });
});

describe("transcript detail", () => {
  const write = (value: Record<string, unknown>) => {
    storage.set(STORAGE_KEYS.preferences, JSON.stringify(value));
  };

  it("starts focused", () => {
    expect(new PreferencesStore().getSnapshot().transcriptDetail).toBe("focused");
  });

  it("migrates someone who expanded thinking to the level that shows it", () => {
    write({ showThinking: true });
    expect(new PreferencesStore().getSnapshot().transcriptDetail).toBe("detailed");
  });

  it("leaves someone who never expanded thinking focused", () => {
    write({ showThinking: false });
    expect(new PreferencesStore().getSnapshot().transcriptDetail).toBe("focused");
  });

  it("prefers a stored level over the old flag, and ignores an unknown one", () => {
    write({ showThinking: true, transcriptDetail: "everything" });
    expect(new PreferencesStore().getSnapshot().transcriptDetail).toBe("everything");
    write({ transcriptDetail: "verbose" });
    expect(new PreferencesStore().getSnapshot().transcriptDetail).toBe("focused");
  });

  it("gives one thread its own level and leaves the others alone", () => {
    preferences.overrideTranscriptDetail("thread-a", "everything");
    expect(preferences.transcriptDetailFor("thread-a")).toBe("everything");
    expect(preferences.transcriptDetailFor("thread-b")).toBe("focused");
    expect(preferences.transcriptDetailFor(undefined)).toBe("focused");
  });

  it("holds one override at a time, so leaving a thread drops its own level", () => {
    preferences.overrideTranscriptDetail("thread-a", "everything");
    preferences.overrideTranscriptDetail("thread-b", "detailed");
    expect(preferences.transcriptDetailFor("thread-a")).toBe("focused");
  });

  it("never persists the override", () => {
    preferences.overrideTranscriptDetail("thread-a", "everything");
    const stored = JSON.parse(storage.get(STORAGE_KEYS.preferences) ?? "{}") as Record<string, unknown>;
    expect(stored.transcriptDetailOverride).toBeUndefined();
    expect(stored.transcriptDetail).toBe("focused");
  });

  it("a new default clears whatever one thread had chosen", () => {
    preferences.overrideTranscriptDetail("thread-a", "everything");
    preferences.setTranscriptDetail("detailed");
    expect(preferences.transcriptDetailFor("thread-a")).toBe("detailed");
  });
});
