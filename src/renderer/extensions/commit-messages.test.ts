// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { REVIEW_HOST_EXTENSION_ID } from "../../shared/review-protocol";
import { preferences } from "../preferences";
import { automaticCommitMessages, commitMessageModel, commitMessageStyle } from "./commit-messages";

beforeEach(() => localStorage.clear());

describe("commit message settings", () => {
  it("uses the configured model and supports multiple formats", () => {
    expect(commitMessageModel({ provider: "anthropic", id: "claude" })).toEqual({ provider: "anthropic", id: "claude" });
    preferences.setValue(REVIEW_HOST_EXTENSION_ID, "commit-model", "openai/gpt-luna");
    preferences.setValue(REVIEW_HOST_EXTENSION_ID, "commit-style", "gitmoji");
    expect(commitMessageModel(undefined)).toEqual({ provider: "openai", id: "gpt-luna" });
    expect(commitMessageStyle()).toBe("gitmoji");
    expect(automaticCommitMessages()).toBe(true);
    preferences.setOption(REVIEW_HOST_EXTENSION_ID, "propose-message", false);
    expect(automaticCommitMessages()).toBe(false);
  });
});
