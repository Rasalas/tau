// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionPrompt, OptionRow, PromptSubmitContext, usePromptSubmit, type PromptSubmitAction } from "./ExtensionPrompt.js";
import type { ExtensionUiPrompt } from "../../shared/contracts.js";

afterEach(cleanup);

function SubmitProbe({ label, disabled, onSubmit }: { label?: string; disabled: boolean; onSubmit?(): void }) {
  usePromptSubmit(label, disabled, onSubmit);
  return null;
}

describe("ExtensionPrompt", () => {
  it("renders radio indicator and toggles chosen state in OptionRow", () => {
    const onPick = vi.fn();
    const { rerender } = render(
      <OptionRow label="Option A" index="1" mode="radio" chosen={false} onPick={onPick} />,
    );
    const button = screen.getByRole("button", { name: /Option A/u });
    expect(button.classList.contains("mode-radio")).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.querySelector(".lucide-circle")).toBeTruthy();

    fireEvent.click(button);
    expect(onPick).toHaveBeenCalledTimes(1);

    rerender(<OptionRow label="Option A" index="1" mode="radio" chosen={true} onPick={onPick} />);
    expect(button.classList.contains("chosen")).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.querySelector(".lucide-circle-dot")).toBeTruthy();
  });

  it("renders checkbox indicator in OptionRow", () => {
    const onPick = vi.fn();
    const { rerender } = render(
      <OptionRow label="Feature B" index="2" mode="checkbox" chosen={false} onPick={onPick} />,
    );
    const button = screen.getByRole("button", { name: /Feature B/u });
    expect(button.classList.contains("mode-checkbox")).toBe(true);
    expect(button.querySelector(".lucide-square")).toBeTruthy();

    rerender(<OptionRow label="Feature B" index="2" mode="checkbox" chosen={true} onPick={onPick} />);
    expect(button.classList.contains("chosen")).toBe(true);
    expect(button.querySelector(".lucide-square-check")).toBeTruthy();
  });

  it("renders select prompt with radio options", () => {
    const onAnswer = vi.fn();
    const prompt: ExtensionUiPrompt = {
      id: "p1",
      sessionId: "s1",
      kind: "select",
      title: "Choose runtime",
      options: ["1. Node.js", "2. Bun"],
    };
    render(<ExtensionPrompt prompt={prompt} pending={0} onAnswer={onAnswer} onCancel={() => {}} />);

    const first = screen.getByRole("button", { name: /Node\.js/u });
    expect(first.classList.contains("mode-radio")).toBe(true);
    fireEvent.click(first);
    expect(onAnswer).toHaveBeenCalledWith("1. Node.js");
  });

  it("registers and unregisters submit action via usePromptSubmit", () => {
    let currentAction: PromptSubmitAction | undefined;
    const register = (action: PromptSubmitAction | undefined) => { currentAction = action; };
    const onSubmit = vi.fn();

    const { rerender, unmount } = render(
      <PromptSubmitContext.Provider value={register}>
        <SubmitProbe label="Send 2" disabled={false} onSubmit={onSubmit} />
      </PromptSubmitContext.Provider>,
    );

    expect(currentAction?.label).toBe("Send 2");
    expect(currentAction?.disabled).toBe(false);
    currentAction?.submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);

    rerender(
      <PromptSubmitContext.Provider value={register}>
        <SubmitProbe label="Send 0" disabled={true} onSubmit={onSubmit} />
      </PromptSubmitContext.Provider>,
    );
    expect(currentAction?.disabled).toBe(true);

    unmount();
    expect(currentAction).toBeUndefined();
  });
});
