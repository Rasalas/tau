import { describe, expect, it, vi } from "vitest";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { PromptHistory } from "../../workbench/prompt-history";
import { handleComposerReadlineKey, ComposerKillRing } from "./useComposerReadline";

function createMockTextarea(text: string, selectionStart: number, selectionEnd = selectionStart) {
  const element = {
    value: text,
    selectionStart,
    selectionEnd,
    setSelectionRange: vi.fn((start: number, end: number) => {
      element.selectionStart = start;
      element.selectionEnd = end;
    }),
  } as unknown as HTMLTextAreaElement;
  return { current: element };
}

function createKeyboardEvent(key: string, modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}) {
  let defaultPrevented = false;
  return {
    key,
    ctrlKey: Boolean(modifiers.ctrl),
    metaKey: Boolean(modifiers.meta),
    altKey: Boolean(modifiers.alt),
    shiftKey: Boolean(modifiers.shift),
    currentTarget: { selectionStart: 0, selectionEnd: 0 },
    preventDefault: () => { defaultPrevented = true; },
    get defaultPrevented() { return defaultPrevented; },
  } as unknown as ReactKeyboardEvent<HTMLTextAreaElement>;
}

describe("useComposerReadline", () => {
  it("navigates history on ArrowUp and ArrowDown", () => {
    const promptHistory = new PromptHistory({ initialEntries: ["first", "second"] });
    const textareaRef = createMockTextarea("draft", 0, 0);
    let draft = "draft";
    const updateDraft = vi.fn((next: string) => { draft = next; });
    const setCaret = vi.fn();

    const upEvent = createKeyboardEvent("ArrowUp");
    (upEvent.currentTarget as any).selectionStart = 0;
    (upEvent.currentTarget as any).selectionEnd = 0;

    const handledUp = handleComposerReadlineKey(upEvent, {
      textareaRef,
      text: draft,
      updateDraft,
      setCaret,
      promptHistory,
    });

    expect(handledUp).toBe(true);
    expect(updateDraft).toHaveBeenCalledWith("second");
    expect(promptHistory.isNavigating).toBe(true);

    const downEvent = createKeyboardEvent("ArrowDown");
    const handledDown = handleComposerReadlineKey(downEvent, {
      textareaRef,
      text: draft,
      updateDraft,
      setCaret,
      promptHistory,
    });

    expect(handledDown).toBe(true);
    expect(updateDraft).toHaveBeenCalledWith("draft");
    expect(promptHistory.isNavigating).toBe(false);
  });

  it("handles Ctrl+A (start of line) and Ctrl+E (end of line)", () => {
    const promptHistory = new PromptHistory();
    const textareaRef = createMockTextarea("hello world", 5);
    const updateDraft = vi.fn();
    const setCaret = vi.fn();

    const ctrlA = createKeyboardEvent("a", { ctrl: true });
    (ctrlA.currentTarget as any).selectionStart = 5;
    const handledA = handleComposerReadlineKey(ctrlA, {
      textareaRef,
      text: "hello world",
      updateDraft,
      setCaret,
      promptHistory,
    });

    expect(handledA).toBe(true);
    expect(setCaret).toHaveBeenCalledWith(0);
    expect(textareaRef.current.setSelectionRange).toHaveBeenCalledWith(0, 0);

    const ctrlE = createKeyboardEvent("e", { ctrl: true });
    (ctrlE.currentTarget as any).selectionStart = 0;
    const handledE = handleComposerReadlineKey(ctrlE, {
      textareaRef,
      text: "hello world",
      updateDraft,
      setCaret,
      promptHistory,
    });

    expect(handledE).toBe(true);
    expect(setCaret).toHaveBeenCalledWith(11);
    expect(textareaRef.current.setSelectionRange).toHaveBeenCalledWith(11, 11);
  });

  it("handles Ctrl+U (kill to start of line) and Ctrl+K (kill to end of line)", () => {
    const promptHistory = new PromptHistory();
    const textareaRef = createMockTextarea("hello world", 5);
    const updateDraft = vi.fn();
    const setCaret = vi.fn();

    const ctrlU = createKeyboardEvent("u", { ctrl: true });
    (ctrlU.currentTarget as any).selectionStart = 5;
    const handledU = handleComposerReadlineKey(ctrlU, {
      textareaRef,
      text: "hello world",
      updateDraft,
      setCaret,
      promptHistory,
    });

    expect(handledU).toBe(true);
    expect(updateDraft).toHaveBeenCalledWith(" world");
    expect(setCaret).toHaveBeenCalledWith(0);

    const ctrlK = createKeyboardEvent("k", { ctrl: true });
    (ctrlK.currentTarget as any).selectionStart = 5;
    const handledK = handleComposerReadlineKey(ctrlK, {
      textareaRef,
      text: "hello world",
      updateDraft,
      setCaret,
      promptHistory,
    });

    expect(handledK).toBe(true);
    expect(updateDraft).toHaveBeenCalledWith("hello");
    expect(setCaret).toHaveBeenCalledWith(5);
  });

  it("handles Ctrl+W (delete word backward)", () => {
    const promptHistory = new PromptHistory();
    const textareaRef = createMockTextarea("hello world", 11);
    const updateDraft = vi.fn();
    const setCaret = vi.fn();

    const ctrlW = createKeyboardEvent("w", { ctrl: true });
    (ctrlW.currentTarget as any).selectionStart = 11;
    const handledW = handleComposerReadlineKey(ctrlW, {
      textareaRef,
      text: "hello world",
      updateDraft,
      setCaret,
      promptHistory,
    });

    expect(handledW).toBe(true);
    expect(updateDraft).toHaveBeenCalledWith("hello");
    expect(setCaret).toHaveBeenCalledWith(5);
  });

  it("handles external editor shortcut (Mod+E / Ctrl+G)", () => {
    const promptHistory = new PromptHistory();
    const textareaRef = createMockTextarea("hello", 5);
    const updateDraft = vi.fn();
    const setCaret = vi.fn();
    const onOpenPromptEditor = vi.fn();

    const modE = createKeyboardEvent("e", { meta: true });
    const handledE = handleComposerReadlineKey(modE, {
      textareaRef,
      text: "hello",
      updateDraft,
      setCaret,
      promptHistory,
      onOpenPromptEditor,
    });

    expect(handledE).toBe(true);
    expect(onOpenPromptEditor).toHaveBeenCalled();

    const ctrlG = createKeyboardEvent("g", { ctrl: true });
    const handledG = handleComposerReadlineKey(ctrlG, {
      textareaRef,
      text: "hello",
      updateDraft,
      setCaret,
      promptHistory,
      onOpenPromptEditor,
    });

    expect(handledG).toBe(true);
    expect(onOpenPromptEditor).toHaveBeenCalledTimes(2);

    const ctrlO = createKeyboardEvent("o", { ctrl: true });
    const handledO = handleComposerReadlineKey(ctrlO, {
      textareaRef,
      text: "hello",
      updateDraft,
      setCaret,
      promptHistory,
      onOpenPromptEditor,
    });

    expect(handledO).toBe(false);
    expect(onOpenPromptEditor).toHaveBeenCalledTimes(2);
  });

  it("handles Kill Ring: Ctrl+K, Alt+D, Ctrl+Y (yank) and Alt+Y (yank-pop)", () => {
    const promptHistory = new PromptHistory();
    const killRing = new ComposerKillRing();
    const textareaRef = createMockTextarea("first second third", 0);
    let draft = "first second third";
    const updateDraft = vi.fn((next: string) => { draft = next; });
    const setCaret = vi.fn();

    // 1. Alt+D kills "first "
    (textareaRef.current as any).selectionStart = 0;
    const altD = createKeyboardEvent("d", { alt: true });
    handleComposerReadlineKey(altD, {
      textareaRef,
      text: draft,
      updateDraft,
      setCaret,
      promptHistory,
      killRing,
    });
    expect(killRing.peek()).toBe("first");

    // 2. Kill "second" with Alt+D
    (textareaRef.current as any).selectionStart = 1; // space before second
    const altD2 = createKeyboardEvent("d", { alt: true });
    handleComposerReadlineKey(altD2, {
      textareaRef,
      text: draft,
      updateDraft,
      setCaret,
      promptHistory,
      killRing,
    });

    // 3. Ctrl+Y yanks the last killed word
    (textareaRef.current as any).selectionStart = 0;
    const ctrlY = createKeyboardEvent("y", { ctrl: true });
    const handledY = handleComposerReadlineKey(ctrlY, {
      textareaRef,
      text: draft,
      updateDraft,
      setCaret,
      promptHistory,
      killRing,
    });
    expect(handledY).toBe(true);

    // 4. Alt+Y cycles to earlier kill
    (textareaRef.current as any).selectionStart = killRing.lastYankLength;
    const altY = createKeyboardEvent("y", { alt: true });
    const handledAltY = handleComposerReadlineKey(altY, {
      textareaRef,
      text: draft,
      updateDraft,
      setCaret,
      promptHistory,
      killRing,
    });
    expect(handledAltY).toBe(true);
  });

  it("handles word navigation with Alt+B and Alt+F", () => {
    const promptHistory = new PromptHistory();
    const textareaRef = createMockTextarea("hello world test", 11);
    const updateDraft = vi.fn();
    const setCaret = vi.fn();

    const altB = createKeyboardEvent("b", { alt: true });
    (altB.currentTarget as any).selectionStart = 11;
    const handledB = handleComposerReadlineKey(altB, {
      textareaRef,
      text: "hello world test",
      updateDraft,
      setCaret,
      promptHistory,
    });
    expect(handledB).toBe(true);
    expect(setCaret).toHaveBeenCalledWith(6);

    const altF = createKeyboardEvent("f", { alt: true });
    (altF.currentTarget as any).selectionStart = 6;
    const handledF = handleComposerReadlineKey(altF, {
      textareaRef,
      text: "hello world test",
      updateDraft,
      setCaret,
      promptHistory,
    });
    expect(handledF).toBe(true);
    expect(setCaret).toHaveBeenCalledWith(11);
  });

  it("handles dequeue with Alt+Up or Alt+Q", () => {
    const promptHistory = new PromptHistory();
    const textareaRef = createMockTextarea("hello", 5);
    const updateDraft = vi.fn();
    const setCaret = vi.fn();
    const onDequeue = vi.fn();

    const altUp = createKeyboardEvent("ArrowUp", { alt: true });
    const handledUp = handleComposerReadlineKey(altUp, {
      textareaRef,
      text: "hello",
      updateDraft,
      setCaret,
      promptHistory,
      onDequeue,
    });
    expect(handledUp).toBe(true);
    expect(onDequeue).toHaveBeenCalledTimes(1);

    const altQ = createKeyboardEvent("q", { alt: true });
    const handledQ = handleComposerReadlineKey(altQ, {
      textareaRef,
      text: "hello",
      updateDraft,
      setCaret,
      promptHistory,
      onDequeue,
    });
    expect(handledQ).toBe(true);
    expect(onDequeue).toHaveBeenCalledTimes(2);
  });
});
