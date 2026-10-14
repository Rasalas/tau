// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreferencesStore, DesktopExtensionContext, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { automaticCommitMessages, COMMIT_MESSAGE_OPTIONS, commitMessageModel, commitMessageStyle, registerCommitMessages, writingEffort } from "./commit-messages.js";
import { GUIDE_OPTIONS } from "./guide-settings.js";
import type { WorkspaceStoreApi } from "./protocol.js";
import { REVIEW_HOST_EXTENSION_ID } from "./protocol.js";

let preferences: PreferencesStore;

beforeEach(() => {
  preferences = createKitHarness().preferences;
});

describe("commit message settings", () => {
  it("declares effort settings for both model choices", () => {
    expect(COMMIT_MESSAGE_OPTIONS.find((option) => option.kind === "model")).toMatchObject({ thinkingLevelValue: "commit-effort" });
    expect(GUIDE_OPTIONS[0]).toMatchObject({ thinkingLevelValue: "review-guide-effort" });
    preferences.setValue(REVIEW_HOST_EXTENSION_ID, "commit-effort", "high");
    expect(writingEffort(preferences)).toBeUndefined();
    preferences.setValue(REVIEW_HOST_EXTENSION_ID, "commit-model", "test/writer");
    expect(writingEffort(preferences)).toBe("high");
  });

  it("sends the dedicated writer effort with a commit suggestion", async () => {
    const invoke = vi.fn(async () => ({ message: "fix: save" }));
    let suggest: Parameters<WorkspaceStoreApi["registerCommitMessageSuggester"]>[0] | undefined;
    const workspace = { registerCommitMessageSuggester: (callback: NonNullable<typeof suggest>) => { suggest = callback; return () => undefined; } } as unknown as WorkspaceStoreApi;
    preferences.setValue(REVIEW_HOST_EXTENSION_ID, "commit-model", "test/writer");
    preferences.setValue(REVIEW_HOST_EXTENSION_ID, "commit-effort", "high");
    registerCommitMessages({ preferences, host: { invoke } } as unknown as DesktopExtensionContext, workspace);
    await suggest!({ changes: { files: [], added: 0, removed: 0 }, diffs: [], actions: { activeThread: () => undefined } as unknown as WorkbenchActions });
    expect(invoke).toHaveBeenCalledWith("suggest-commit-message", expect.objectContaining({ provider: "test", modelId: "writer", thinkingLevel: "high" }));
  });

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
