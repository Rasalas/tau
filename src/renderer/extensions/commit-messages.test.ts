// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { REVIEW_HOST_EXTENSION_ID } from "../../shared/review-protocol";
import { PreferencesStore } from "../preferences";
import { automaticCommitMessages, commitMessageModel, commitMessageStyle } from "./commit-messages";

let preferences: PreferencesStore;

beforeEach(() => {
  preferences = new PreferencesStore();
});

describe("commit message settings", () => {
  it("uses the configured model and supports multiple formats", () => {
    expect(commitMessageModel({ provider: "anthropic", id: "claude" }, preferences)).toEqual({ provider: "anthropic", id: "claude" });
    preferences.setValue(REVIEW_HOST_EXTENSION_ID, "commit-model", "openai/gpt-luna");
    preferences.setValue(REVIEW_HOST_EXTENSION_ID, "commit-style", "gitmoji");
    expect(commitMessageModel(undefined, preferences)).toEqual({ provider: "openai", id: "gpt-luna" });
    expect(commitMessageStyle(preferences)).toBe("gitmoji");
    expect(automaticCommitMessages(preferences)).toBe(true);
    preferences.setOption(REVIEW_HOST_EXTENSION_ID, "propose-message", false);
    expect(automaticCommitMessages(preferences)).toBe(false);
  });
});
