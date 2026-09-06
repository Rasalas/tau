// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { HostSnapshot, PreferencesStore } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { automaticTitleModel } from "./desktop.js";

function snapshot(messages: HostSnapshot["messages"]): HostSnapshot {
  return {
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
  it("selects a model only before the first user prompt", () => {
    expect(automaticTitleModel({ prompt: "first", snapshot: snapshot([]) }, preferences)).toEqual({
      provider: "provider",
      id: "model",
      name: "Model",
    });
    expect(automaticTitleModel({
      prompt: "later",
      snapshot: snapshot([{ id: "user", role: "user", text: "first", timestamp: 1 }]),
    }, preferences)).toBeUndefined();
  });
});
