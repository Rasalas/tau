// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiModel } from "../../shared/contracts";
import { Composer } from "./Composer";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { TestProviders } from "../test-support/test-providers";

const luna: UiModel = { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };
const sol: UiModel = { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" };

const snapshot: HostSnapshot = {
  cwd: "/project", sessionId: "session", sessionTitle: "Thread", backendKind: "pi",
  model: luna, models: [luna, sol],
  thinkingLevel: "medium", thinkingLevels: ["medium"],
  messages: [], isStreaming: false, activeTools: [], allTools: [], extensionCount: 0,
};

function renderComposer() {
  const onSetModel = vi.fn();
  const textareaRef = createRef<HTMLTextAreaElement>();
  render(<TestProviders>
    <Composer
      scopeStore={new ComposerScopeStore()}
      snapshot={snapshot}
      queue={[]}
      contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
      textareaRef={textareaRef}
      onSubmit={vi.fn(async () => ({ accepted: true as const }))}
      onAbort={() => {}}
      onCancelQueued={() => {}}
      onSteerQueued={() => {}}
      onSetModel={onSetModel}
      onSetThinking={() => {}}
      onCompactContext={() => {}}
    />
  </TestProviders>);
  const chip = screen.getByLabelText(/^Select model:/u);
  return { onSetModel, chip, textareaRef };
}

async function openPicker(chip: HTMLElement) {
  chip.focus();
  fireEvent.click(chip);
  const picker = await screen.findByRole("dialog", { name: "Select model" });
  const input = screen.getByRole("textbox", { name: "Search models" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  return { picker, input };
}

afterEach(cleanup);

describe("model picker at the model chip", () => {
  it("opens as a popover without a scrim, beside its chip", async () => {
    const { chip } = renderComposer();
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    const { picker } = await openPicker(chip);
    expect(picker.classList).toContain("popover");
    expect(picker.getAttribute("aria-modal")).toBeNull();
    expect(document.querySelector(".palette-backdrop")).toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("true");
  });

  it("walks the list with the arrows, takes a model with Enter and hands focus to the prompt", async () => {
    const { chip, onSetModel, textareaRef } = renderComposer();
    const { input } = await openPicker(chip);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSetModel).toHaveBeenCalledWith("openai-codex", "gpt-5.6-sol");
    expect(screen.queryByRole("dialog", { name: "Select model" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(textareaRef.current));
  });

  it("gives focus back to its chip on Escape", async () => {
    const { chip, onSetModel } = renderComposer();
    await openPicker(chip);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Select model" })).toBeNull();
    expect(document.activeElement).toBe(chip);
    expect(onSetModel).not.toHaveBeenCalled();
  });

  it("closes on a second press of its chip and on a press outside", async () => {
    const { chip } = renderComposer();
    await openPicker(chip);
    fireEvent.pointerDown(chip);
    fireEvent.click(chip);
    expect(screen.queryByRole("dialog", { name: "Select model" })).toBeNull();
    await openPicker(chip);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Select model" })).toBeNull();
  });

  it("keeps Tab inside the popover", async () => {
    const { chip } = renderComposer();
    const { picker, input } = await openPicker(chip);
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(picker.contains(document.activeElement)).toBe(true);
  });
});
