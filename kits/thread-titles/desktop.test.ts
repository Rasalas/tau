// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { HostSnapshot, PreferencesStore } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { shouldTitleAutomatically, titleModel } from "./desktop.js";
import { THREAD_TITLES_HOST_EXTENSION_ID } from "./protocol.js";

function snapshot(messages: HostSnapshot["messages"], backendKind?: string): HostSnapshot {
  return {
    ...(backendKind ? { backendKind } : {}),
    cwd: "/repo",
    sessionId: "session",
    sessionTitle: "Untitled thread",
    model: { provider: "provider", id: "model", name: "Model" },
    models: [],
    thinkingLevel: "off",
    thinkingLevels: ["off"],
    messages,
    isStreaming: false,
    activeTools: [],
    allTools: [],
    extensionCount: 0,
    supportsImageInput: true,
  };
}

let preferences: PreferencesStore;

beforeEach(() => {
  preferences = createKitHarness().preferences;
});

describe("automatic title generation", () => {
  it("titles a thread on its first prompt only", () => {
    expect(shouldTitleAutomatically({ prompt: "first", snapshot: snapshot([]) }, preferences)).toBe(true);
    expect(shouldTitleAutomatically({
      prompt: "later",
      snapshot: snapshot([{ id: "user", role: "user", text: "first", timestamp: 1 }]),
    }, preferences)).toBe(false);
  });

  it("titles a thread of any runtime, not only Pi's", () => {
    expect(shouldTitleAutomatically({ prompt: "first", snapshot: snapshot([], "antigravity") }, preferences)).toBe(true);
  });
});

describe("the model that writes a title", () => {
  it("is the thread's own while Pi owns it", () => {
    expect(titleModel(snapshot([], "pi"), preferences)).toEqual({ provider: "provider", id: "model", name: "Model" });
    expect(titleModel(snapshot([]), preferences)).toMatchObject({ id: "model" });
  });

  it("is none for another runtime's thread, so the host falls back to the user's default", () => {
    // A model id belongs to the runtime that reported it; Pi's catalog does not know it.
    expect(titleModel(snapshot([], "claude-code"), preferences)).toBeUndefined();
    expect(titleModel(undefined, preferences)).toBeUndefined();
  });

  it("is whatever the settings name, for every thread", () => {
    preferences.setValue(THREAD_TITLES_HOST_EXTENSION_ID, "model", "openai-codex/gpt-5.6-luna");
    expect(titleModel(snapshot([], "antigravity"), preferences)).toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
    expect(titleModel(snapshot([], "pi"), preferences)).toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
    preferences.setValue(THREAD_TITLES_HOST_EXTENSION_ID, "model", "malformed");
    expect(titleModel(snapshot([], "antigravity"), preferences)).toBeUndefined();
  });
});
