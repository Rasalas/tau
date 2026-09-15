// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useComposerVim } from "./useComposerVim";
import { ComposerKillRing } from "./useComposerReadline";

describe("useComposerVim", () => {
  it("does nothing when enabled is false", () => {
    let draft = "hello world";
    const updateDraft = vi.fn((next: string) => {
      draft = next;
    });
    const setCaret = vi.fn();
    const textareaRef = { current: { selectionStart: 0, setSelectionRange: vi.fn() } as any };

    const { result } = renderHook(() =>
      useComposerVim({
        enabled: false,
        text: draft,
        updateDraft,
        setCaret,
        textareaRef,
      }),
    );

    expect(result.current.isVimEnabled).toBe(false);

    // Escape should not be handled when disabled
    act(() => {
      const handled = result.current.handleVimKeyDown({
        key: "Escape",
        preventDefault: vi.fn(),
      } as any);
      expect(handled).toBe(false);
    });
  });

  it("handles mode transitions between Insert and Normal", () => {
    let draft = "hello world";
    const updateDraft = vi.fn((next: string) => {
      draft = next;
    });
    const setCaret = vi.fn();
    const textareaRef = { current: { selectionStart: 5, setSelectionRange: vi.fn() } as any };

    const { result } = renderHook(() =>
      useComposerVim({
        enabled: true,
        text: draft,
        updateDraft,
        setCaret,
        textareaRef,
      }),
    );

    expect(result.current.isVimEnabled).toBe(true);
    expect(result.current.vimMode).toBe("insert");

    // Press Escape to enter Normal mode
    act(() => {
      const handled = result.current.handleVimKeyDown({
        key: "Escape",
        preventDefault: vi.fn(),
      } as any);
      expect(handled).toBe(true);
    });

    expect(result.current.vimMode).toBe("normal");

    // Press 'i' to return to Insert mode
    act(() => {
      const handled = result.current.handleVimKeyDown({
        key: "i",
        preventDefault: vi.fn(),
      } as any);
      expect(handled).toBe(true);
    });

    expect(result.current.vimMode).toBe("insert");
  });

  it("handles deletion with 'x' and line deletion with 'dd' in Normal mode", () => {
    let draft = "hello\nworld";
    const updateDraft = vi.fn((next: string) => {
      draft = next;
    });
    const setCaret = vi.fn();
    const killRing = new ComposerKillRing();
    const textareaRef = { current: { selectionStart: 0, setSelectionRange: vi.fn() } as any };

    const { result } = renderHook(() =>
      useComposerVim({
        enabled: true,
        text: draft,
        updateDraft,
        setCaret,
        textareaRef,
        killRing,
      }),
    );

    // Switch to Normal mode
    act(() => {
      result.current.setVimMode("normal");
    });

    // Press 'x' to delete 'h'
    act(() => {
      const handled = result.current.handleVimKeyDown({
        key: "x",
        preventDefault: vi.fn(),
      } as any);
      expect(handled).toBe(true);
    });

    expect(updateDraft).toHaveBeenCalledWith("ello\nworld");

    // Press 'd' then 'd' to delete the first line
    act(() => {
      result.current.handleVimKeyDown({
        key: "d",
        preventDefault: vi.fn(),
      } as any);
      result.current.handleVimKeyDown({
        key: "d",
        preventDefault: vi.fn(),
      } as any);
    });

    expect(updateDraft).toHaveBeenCalledWith("world");
  });

  it("submits on Enter in Normal mode", () => {
    const onSubmit = vi.fn();
    const textareaRef = { current: { selectionStart: 0, setSelectionRange: vi.fn() } as any };

    const { result } = renderHook(() =>
      useComposerVim({
        enabled: true,
        text: "hello",
        updateDraft: vi.fn(),
        setCaret: vi.fn(),
        textareaRef,
        onSubmit,
      }),
    );

    act(() => {
      result.current.setVimMode("normal");
    });

    act(() => {
      const handled = result.current.handleVimKeyDown({
        key: "Enter",
        preventDefault: vi.fn(),
      } as any);
      expect(handled).toBe(true);
    });

    expect(onSubmit).toHaveBeenCalled();
  });
});
