// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreferencesStore, DesktopExtensionContext, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { TEXT_GENERATION_OPTIONS } from "../_shared/text-generation.js";
import { automaticCommitMessages, chosenWritingModel, COMMIT_MESSAGE_OPTIONS, commitMessageModel, commitMessageStyle, descriptionWriting, registerCommitMessages } from "./commit-messages.js";
import { GUIDE_OPTIONS } from "./guide-settings.js";
import type { WorkspaceStoreApi } from "./protocol.js";
import { REVIEW_HOST_EXTENSION_ID } from "./protocol.js";

let preferences: PreferencesStore;

beforeEach(() => {
  preferences = createKitHarness().preferences;
});

describe("commit message settings", () => {
  it("declares effort settings for every model choice, the commit model among Text generation's", () => {
    expect(COMMIT_MESSAGE_OPTIONS.some((option) => option.kind === "model")).toBe(false);
    expect(TEXT_GENERATION_OPTIONS.find((option) => option.id === "commit-model")).toMatchObject({ kind: "model", thinkingLevelValue: "commit-effort" });
    expect(GUIDE_OPTIONS.find((option) => option.kind === "model")).toMatchObject({ thinkingLevelValue: "review-guide-effort" });
  });

  it("writes a description with its own model, else the default, and its effort only beside a chosen model", () => {
    preferences.setValue(REVIEW_HOST_EXTENSION_ID, "pr-effort", "high");
    expect(chosenWritingModel(preferences)).toBeUndefined();
    expect(descriptionWriting(preferences)).toEqual({});
    preferences.setValue(REVIEW_HOST_EXTENSION_ID, "text-model", "test/default");
    expect(chosenWritingModel(preferences)).toEqual({ provider: "test", id: "default" });
    preferences.setValue(REVIEW_HOST_EXTENSION_ID, "pr-model", "test/writer");
    preferences.setValue(REVIEW_HOST_EXTENSION_ID, "pr-runtime", "thread");
    expect(chosenWritingModel(preferences)).toEqual({ provider: "test", id: "writer" });
    expect(descriptionWriting(preferences)).toEqual({ thinkingLevel: "high", runtime: "thread" });
  });

  it("asks the thread's runtime for a commit message with the thread's own model when nothing else is chosen", async () => {
    const invoke = vi.fn(async () => ({ message: "fix: save" }));
    let suggest: Parameters<WorkspaceStoreApi["registerCommitMessageSuggester"]>[0] | undefined;
    const workspace = { registerCommitMessageSuggester: (callback: NonNullable<typeof suggest>) => { suggest = callback; return () => undefined; } } as unknown as WorkspaceStoreApi;
    preferences.setValue(REVIEW_HOST_EXTENSION_ID, "text-runtime", "thread");
    registerCommitMessages({ preferences, host: { invoke } } as unknown as DesktopExtensionContext, workspace);
    await suggest!({ changes: { files: [], added: 0, removed: 0 }, diffs: [], actions: { activeThread: () => undefined } as unknown as WorkbenchActions });
    expect(invoke).toHaveBeenCalledWith("suggest-commit-message", expect.objectContaining({ runtime: "thread" }));
    expect(invoke).not.toHaveBeenCalledWith("suggest-commit-message", expect.objectContaining({ provider: expect.anything() }));
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
