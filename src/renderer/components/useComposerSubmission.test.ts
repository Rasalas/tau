// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../../workbench/client-storage";
import { createDraftKey, ComposerScopeStore } from "../../workbench/composer-scope-store";
import { readComposerDraft } from "../../workbench/draft-store";
import {
  classifyComposerInput,
  useComposerSubmission,
} from "./useComposerSubmission";
import { expandFileMentions } from "../file-mention-expander.js";

vi.mock("../file-mention-expander.js", () => ({
  expandFileMentions: vi.fn(async (text: string) => ({ text, attachments: [] })),
}));

const expandFileMentionsMock = vi.mocked(expandFileMentions);

afterEach(() => {
  vi.clearAllMocks();
});

describe("classifyComposerInput", () => {
  it("keeps typed prompt answers intact and invokes an enabled empty action", () => {
    expect(classifyComposerInput({
      text: "  Continue  ",
      answerable: true,
      promptActionAvailable: false,
      shellActionAvailable: false,
    })).toEqual({ kind: "prompt-answer", text: "  Continue  " });

    expect(classifyComposerInput({
      text: " ",
      answerable: true,
      promptActionAvailable: true,
      shellActionAvailable: false,
    })).toEqual({ kind: "prompt-action" });

    // Files alone answer a question that takes them.
    expect(classifyComposerInput({ text: "", answerable: true, answerFiles: true, promptActionAvailable: false, shellActionAvailable: false })).toEqual({ kind: "prompt-answer", text: "" });
    expect(classifyComposerInput({ text: "", answerable: true, promptActionAvailable: false, shellActionAvailable: false })).toEqual({ kind: "noop" });
  });

  it("routes shell commands with their context policy", () => {
    expect(classifyComposerInput({
      text: "  !git status ",
      answerable: false,
      promptActionAvailable: false,
      shellActionAvailable: true,
    })).toEqual({
      kind: "shell",
      command: "git status",
      includeInContext: true,
      historyText: "!git status",
    });

    expect(classifyComposerInput({
      text: "!!echo quiet",
      answerable: false,
      promptActionAvailable: false,
      shellActionAvailable: true,
    })).toEqual({
      kind: "shell",
      command: "echo quiet",
      includeInContext: false,
      historyText: "!!echo quiet",
    });
  });

  it("leaves ordinary prompts and unavailable actions alone", () => {
    expect(classifyComposerInput({
      text: "hello",
      answerable: false,
      promptActionAvailable: false,
      shellActionAvailable: false,
      delivery: "steer",
    })).toEqual({ kind: "prompt", delivery: "steer" });

    expect(classifyComposerInput({
      text: "",
      answerable: true,
      promptActionAvailable: false,
      shellActionAvailable: false,
    })).toEqual({ kind: "noop" });
  });
});

describe("useComposerSubmission", () => {
  it("captures, submits and persists one scope transaction", async () => {
    const scopeStore = new ComposerScopeStore();
    const scope = createDraftKey("session:test");
    const storage = createMemoryStorage();
    scopeStore.setDraft(scope, "hello");
    const onSubmit = vi.fn(async () => ({ accepted: true as const }));
    const recordPrompt = vi.fn();
    const clearPreviewForScope = vi.fn();
    const { result } = renderHook(() => useComposerSubmission({
      scopeStore,
      scope,
      draftStorageKey: scope,
      clientStorage: storage,
      onSubmit,
      recordPrompt,
      clearPreviewForScope,
    }));

    act(() => result.current.submit("steer"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("hello", [], "steer"));

    expect(scopeStore.getSnapshot(scope)).toMatchObject({ draft: "", submissionPending: false });
    expect(readComposerDraft(storage, scope)).toBe("");
    expect(recordPrompt).toHaveBeenCalledWith("hello");
    expect(clearPreviewForScope).toHaveBeenCalledWith(scope);
  });

  it("settles a preparation failure so the captured draft can be retried", async () => {
    const scopeStore = new ComposerScopeStore();
    const scope = createDraftKey("session:prepare-failure");
    const storage = createMemoryStorage();
    scopeStore.setDraft(scope, "include @broken.ts");
    expandFileMentionsMock.mockRejectedValueOnce(new Error("document source failed"));
    const onSubmit = vi.fn(async () => ({ accepted: true as const }));
    const { result } = renderHook(() => useComposerSubmission({
      scopeStore,
      scope,
      draftStorageKey: scope,
      clientStorage: storage,
      documentSource: {} as never,
      onSubmit,
      recordPrompt: vi.fn(),
      clearPreviewForScope: vi.fn(),
    }));

    act(() => result.current.submit());
    await waitFor(() => expect(scopeStore.getSnapshot(scope).submissionPending).toBe(false));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(scopeStore.getSnapshot(scope)).toMatchObject({
      draft: "include @broken.ts",
      error: "document source failed",
    });

    act(() => result.current.submit());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    await waitFor(() => expect(scopeStore.getSnapshot(scope).submissionPending).toBe(false));
    expect(scopeStore.getSnapshot(scope)).toMatchObject({ draft: "" });
    expect(scopeStore.getSnapshot(scope).error).toBeUndefined();
  });
});
