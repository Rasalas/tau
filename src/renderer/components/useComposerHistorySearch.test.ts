// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useComposerHistorySearch } from "./useComposerHistorySearch";
import { PromptHistory } from "../../workbench/prompt-history";

describe("useComposerHistorySearch", () => {
  it("starts search on Ctrl+R and finds matching prompts", () => {
    const promptHistory = new PromptHistory({
      initialEntries: ["git status", "npm test", "npm run build", "git diff"],
    });
    let draft = "current draft";
    const updateDraft = vi.fn((next: string) => {
      draft = next;
    });
    const setCaret = vi.fn();
    const textareaRef = { current: null };

    const { result } = renderHook(() =>
      useComposerHistorySearch({
        promptHistory,
        text: draft,
        updateDraft,
        setCaret,
        textareaRef,
      }),
    );

    expect(result.current.isSearching).toBe(false);

    // Press Ctrl+R to start search
    act(() => {
      const handled = result.current.handleSearchKeyDown({
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        key: "r",
        preventDefault: vi.fn(),
      } as any);
      expect(handled).toBe(true);
    });

    expect(result.current.isSearching).toBe(true);
    expect(result.current.searchQuery).toBe("");

    // Type "git"
    act(() => {
      result.current.handleSearchKeyDown({
        key: "g",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        preventDefault: vi.fn(),
      } as any);
      result.current.handleSearchKeyDown({
        key: "i",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        preventDefault: vi.fn(),
      } as any);
      result.current.handleSearchKeyDown({
        key: "t",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        preventDefault: vi.fn(),
      } as any);
    });

    expect(result.current.searchQuery).toBe("git");
    // Newest match is "git diff"
    expect(result.current.matchedPrompt).toBe("git diff");
    expect(draft).toBe("git diff");

    // Press Ctrl+R again to cycle to earlier match ("git status")
    act(() => {
      result.current.handleSearchKeyDown({
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        key: "r",
        preventDefault: vi.fn(),
      } as any);
    });

    expect(result.current.matchedPrompt).toBe("git status");
    expect(draft).toBe("git status");

    // Press Enter to accept
    act(() => {
      result.current.handleSearchKeyDown({
        key: "Enter",
        preventDefault: vi.fn(),
      } as any);
    });

    expect(result.current.isSearching).toBe(false);
    expect(draft).toBe("git status");
  });

  it("cancels search on Escape and restores original draft", () => {
    const promptHistory = new PromptHistory({
      initialEntries: ["echo hello"],
    });
    let draft = "original prompt";
    const updateDraft = vi.fn((next: string) => {
      draft = next;
    });
    const setCaret = vi.fn();
    const textareaRef = { current: null };

    const { result } = renderHook(() =>
      useComposerHistorySearch({
        promptHistory,
        text: draft,
        updateDraft,
        setCaret,
        textareaRef,
      }),
    );

    // Start search
    act(() => {
      result.current.startSearch();
    });

    // Type "echo"
    act(() => {
      result.current.handleSearchKeyDown({
        key: "e",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        preventDefault: vi.fn(),
      } as any);
    });

    expect(result.current.matchedPrompt).toBe("echo hello");
    expect(draft).toBe("echo hello");

    // Press Escape
    act(() => {
      result.current.handleSearchKeyDown({
        key: "Escape",
        preventDefault: vi.fn(),
      } as any);
    });

    expect(result.current.isSearching).toBe(false);
    expect(draft).toBe("original prompt");
  });
});
