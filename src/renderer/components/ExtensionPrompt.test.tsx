// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionPrompt, OptionRow, PromptSubmitContext, usePromptSubmit, type PromptSubmitAction } from "./ExtensionPrompt.js";
import type { ExtensionUiPrompt } from "../../shared/contracts.js";
import { runningTurn } from "../test-support/kit-harness";

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

  it("draws a yes-or-no question as a permission: what it wants in the head, Deny and Allow, and only ⌘↵ allows (K83)", () => {
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
    // Plain Enter never allows: the composer runs this action on ⌘↵ only.
    expect(action).toMatchObject({ label: "Allow", disabled: false, mod: true });
    expect(card.querySelector(".extension-prompt-send > kbd")?.textContent).toMatch(/^(⌘⏎|Ctrl ⏎)$/u);
    expect(screen.getByRole("button", { name: "Deny" }).querySelector("kbd")?.textContent).toBe("Esc");
  });

  it("reads a long command whole in the body, not cut off in the head", () => {
    const command = `curl -fsSL https://example.com/install.sh | sh -c '${"echo step && ".repeat(40)}true'`;
    expect(command.length).toBeGreaterThan(500);
    const prompt: ExtensionUiPrompt = { id: "p1", sessionId: "s1", kind: "confirm", title: "Wants to run", message: command };
    render(<ExtensionPrompt prompt={prompt} pending={0} onAnswer={() => {}} onCancel={() => {}} />);
    const card = screen.getByRole("region", { name: "Wants to run" });
    // The head's one-line subject ellipsizes; the body wraps and scrolls.
    expect(card.querySelector("header code")).toBeNull();
    expect(card.querySelector(":scope > code.extension-prompt-subject")?.textContent).toBe(command);
  });

  it("keeps a short command beside the action in the head", () => {
    const prompt: ExtensionUiPrompt = { id: "p1", sessionId: "s1", kind: "confirm", title: "Wants to run", message: "npm run lint" };
    render(<ExtensionPrompt prompt={prompt} pending={0} onAnswer={() => {}} onCancel={() => {}} />);
    const card = screen.getByRole("region", { name: "Wants to run" });
    expect(card.querySelector("header code")?.textContent).toBe("npm run lint");
    expect(card.querySelector(":scope > code")).toBeNull();
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

/** The chat column with the window's Escape for Stop live (`runningTurn`), a composer and a card in it. */
function inChat(card: ReactNode, field?: { onKeyDown(event: ReactKeyboardEvent): void }) {
  render(<>
    <nav><button type="button">A thread</button></nav>
    <main data-keybinding-context="chat">
      <textarea aria-label="Composer" {...field} />
      {card}
    </main>
  </>);
  const composer = screen.getByRole("textbox", { name: "Composer" });
  composer.focus();
  return composer;
}

describe("Escape over an approval", () => {
  const confirm: ExtensionUiPrompt = { id: "p1", sessionId: "s1", kind: "confirm", title: "Wants to run", message: "rm -rf build" };
  const escape = (target: Element) => fireEvent.keyDown(target, { key: "Escape" });

  it("denies it and leaves the run going", () => {
    const { abort } = runningTurn();
    const onAnswer = vi.fn();
    escape(inChat(<ExtensionPrompt prompt={confirm} pending={0} onAnswer={onAnswer} onCancel={() => {}} />));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(false);
    expect(abort).not.toHaveBeenCalled();
  });

  it("denies a runtime's Allow / Deny select with its own word", () => {
    const { abort } = runningTurn();
    const onAnswer = vi.fn();
    const prompt: ExtensionUiPrompt = { ...confirm, kind: "select", message: "npm test", options: ["Allow", "Allow for this session", "Deny"] };
    escape(inChat(<ExtensionPrompt prompt={prompt} pending={0} onAnswer={onAnswer} onCancel={() => {}} />));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith("Deny");
    expect(abort).not.toHaveBeenCalled();
  });

  it("does not deny from outside the chat, nor while an overlay is open", () => {
    const { abort } = runningTurn();
    const onAnswer = vi.fn();
    const composer = inChat(<>
      <ExtensionPrompt prompt={confirm} pending={0} onAnswer={onAnswer} onCancel={() => {}} />
      <section role="dialog" aria-label="Over the card" />
    </>);
    escape(composer);
    screen.getByRole("button", { name: "A thread" }).focus();
    escape(document.activeElement!);
    expect(onAnswer).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });

  it("leaves Escape to a field that handled it", () => {
    const { abort } = runningTurn();
    const onAnswer = vi.fn();
    escape(inChat(
      <ExtensionPrompt prompt={confirm} pending={0} onAnswer={onAnswer} onCancel={() => {}} />,
      { onKeyDown: (event) => { if (event.key === "Escape") event.preventDefault(); } },
    ));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });

  it("waits while the card is inert, before the typing stopped", () => {
    runningTurn();
    const onAnswer = vi.fn();
    escape(inChat(<div inert><ExtensionPrompt prompt={confirm} pending={0} onAnswer={onAnswer} onCancel={() => {}} /></div>));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("still stops the run over a question", () => {
    const { abort } = runningTurn();
    const onAnswer = vi.fn();
    const question: ExtensionUiPrompt = { id: "p2", sessionId: "s1", kind: "select", title: "Which index?", options: ["Add one", "Leave it"] };
    escape(inChat(<ExtensionPrompt prompt={question} pending={0} onAnswer={onAnswer} onCancel={() => {}} />));
    expect(abort).toHaveBeenCalledTimes(1);
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
