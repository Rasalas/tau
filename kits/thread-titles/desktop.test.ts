// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, PreferencesStore, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { shouldTitleAutomatically, threadModel, titleModel, titleGeneratorExtension } from "./desktop.js";
import { THREAD_TITLES_HOST_EXTENSION_ID, TITLE_FAILED_EVENT } from "./protocol.js";

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
  it("shows a title failure after the deferred command has already returned", async () => {
    const { registry } = createKitHarness();
    const notify = vi.fn();
    registry.activate(titleGeneratorExtension);
    await registry.notifyPromptSubmitted({ prompt: "first", snapshot: snapshot([]) }, { notify } as unknown as WorkbenchActions);
    registry.dispatchExtensionEvent({ type: "extension-event", extensionId: THREAD_TITLES_HOST_EXTENSION_ID, name: TITLE_FAILED_EVENT, payload: { sessionId: "session", message: "Model unavailable" } });
    expect(notify).toHaveBeenCalledWith("Could not name the thread: Model unavailable");
  });
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
  it("is whatever the settings name, else left to the host", () => {
    expect(titleModel(preferences)).toBeUndefined();
    preferences.setValue(THREAD_TITLES_HOST_EXTENSION_ID, "model", "openai-codex/gpt-5.6-luna");
    expect(titleModel(preferences)).toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });
    preferences.setValue(THREAD_TITLES_HOST_EXTENSION_ID, "model", "malformed");
    expect(titleModel(preferences)).toBeUndefined();
  });

  it("passes the thread's model on as a hint, whatever its runtime", () => {
    expect(threadModel(snapshot([], "codex"))).toEqual({ provider: "provider", id: "model" });
    expect(threadModel(snapshot([], "pi"))).toEqual({ provider: "provider", id: "model" });
    expect(threadModel(undefined)).toBeUndefined();
  });
});
