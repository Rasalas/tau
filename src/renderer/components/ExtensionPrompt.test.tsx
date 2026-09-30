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
    expect(button.querySelector(".extension-option-indicator.is-radio")).toBeTruthy();
    // The number the extension wrote is not drawn, and no loose chevron either.
    expect(button.textContent).toBe("Option A");

    fireEvent.click(button);
    expect(onPick).toHaveBeenCalledTimes(1);

    rerender(<OptionRow label="Option A" index="1" mode="radio" chosen={true} onPick={onPick} />);
    expect(button.classList.contains("chosen")).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders checkbox indicator in OptionRow", () => {
    const onPick = vi.fn();
    const { rerender } = render(
      <OptionRow label="Feature B" index="2" mode="checkbox" chosen={false} onPick={onPick} />,
    );
    const button = screen.getByRole("button", { name: /Feature B/u });
    expect(button.classList.contains("mode-checkbox")).toBe(true);
    expect(button.querySelector(".extension-option-indicator.is-checkbox svg")).toBeNull();

    rerender(<OptionRow label="Feature B" index="2" mode="checkbox" chosen={true} onPick={onPick} />);
    expect(button.classList.contains("chosen")).toBe(true);
    expect(button.querySelector(".extension-option-indicator.is-checkbox svg")).toBeTruthy();
  });

  it("fills a radio on a pick and answers with Answer, which Enter in the empty composer also does", () => {
    const onAnswer = vi.fn();
    let action: PromptSubmitAction | undefined;
    const prompt: ExtensionUiPrompt = {
      id: "p1",
      sessionId: "s1",
      kind: "select",
      title: "Choose runtime",
      options: ["1. Node.js", "2. Bun"],
    };
    render(
      <PromptSubmitContext.Provider value={(next) => { action = next; }}>
        <ExtensionPrompt prompt={prompt} pending={0} onAnswer={onAnswer} onCancel={() => {}} />
      </PromptSubmitContext.Provider>,
    );

    const card = screen.getByRole("region", { name: "Question" });
    expect(card.querySelector("header")?.textContent).toBe("Questionpick one");
    expect(screen.getByText("Or type an answer below")).toBeTruthy();
    const answer = screen.getByRole("button", { name: "Answer" }) as HTMLButtonElement;
    expect(answer.disabled).toBe(true);
    expect(action).toMatchObject({ label: "Answer", disabled: true });
    const first = screen.getByRole("button", { name: /Node\.js/u });
    expect(first.classList.contains("mode-radio")).toBe(true);
    fireEvent.click(first);
    expect(onAnswer).not.toHaveBeenCalled();
    expect(first.classList.contains("chosen")).toBe(true);
    expect(action).toMatchObject({ disabled: false });
    action?.submit();
    expect(onAnswer).toHaveBeenCalledWith("1. Node.js");
  });

  it("heads a question with who asks, and draws an option's second line", () => {
    const prompt: ExtensionUiPrompt = { id: "p1", sessionId: "s1", kind: "select", title: "Which index?", options: ["Add an index — one migration", "Leave it"] };
    render(<ExtensionPrompt prompt={prompt} pending={1} asker="GPT-5.6 Luna" onAnswer={() => {}} onCancel={() => {}} />);
    const card = screen.getByRole("region", { name: "Question from GPT-5.6 Luna" });
    expect(card.querySelector(".extension-prompt-from")?.textContent).toBe("GPT-5.6 Luna");
    expect(card.textContent).toContain("1 more");
    expect(screen.getByRole("button", { name: /Add an index/u }).querySelector("small")?.textContent).toBe("one migration");
  });

  it("draws a yes-or-no question as a permission: what it wants in the head, Deny, and Allow on Enter", () => {
    const onAnswer = vi.fn();
    let action: PromptSubmitAction | undefined;
    const prompt: ExtensionUiPrompt = { id: "p1", sessionId: "s1", kind: "confirm", title: "Wants to edit", message: "src/lib/cursor-helper.ts" };
    render(
      <PromptSubmitContext.Provider value={(next) => { action = next; }}>
        <ExtensionPrompt prompt={prompt} pending={0} asker="Fake 1" onAnswer={onAnswer} onCancel={() => {}} />
      </PromptSubmitContext.Provider>,
    );
    // The model's name is noise on a permission; only a sub-agent is named.
    const card = screen.getByRole("region", { name: "Wants to edit" });
    expect(card.querySelector("header code")?.textContent).toBe("src/lib/cursor-helper.ts");
    expect(card.querySelector(".extension-prompt-pick, .extension-prompt-title")).toBeNull();
    expect(screen.queryByRole("button", { name: "Always for this thread" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onAnswer).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onAnswer).toHaveBeenLastCalledWith(false);
    action?.submit();
    expect(onAnswer).toHaveBeenLastCalledWith(true);
  });

  it("draws a runtime's Allow / Allow for this session / Deny as the same permission card, naming a sub-agent", () => {
    const onAnswer = vi.fn();
    const prompt: ExtensionUiPrompt = {
      id: "p1", sessionId: "child", kind: "select", title: "Codex wants to run a command", message: "npm test\nin /repo",
      options: ["Allow", "Allow for this session", "Deny"],
    };
    render(<ExtensionPrompt prompt={prompt} pending={0} asker="GPT-5.6 Luna" agent="GET /orders agent" onAnswer={onAnswer} onCancel={() => {}} />);
    const card = screen.getByRole("region", { name: "Codex wants to run a command from GET /orders agent" });
    expect(card.querySelector(".extension-option")).toBeNull();
    expect(card.querySelector("code")?.textContent).toBe("npm test\nin /repo");
    fireEvent.click(screen.getByRole("button", { name: "Always for this thread" }));
    expect(onAnswer).toHaveBeenLastCalledWith("Allow for this session");
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onAnswer).toHaveBeenLastCalledWith("Deny");
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onAnswer).toHaveBeenLastCalledWith("Allow");
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
