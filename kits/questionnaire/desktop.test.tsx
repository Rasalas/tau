// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptSubmitContext, type ExtensionUiPrompt, type PromptSubmitAction } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { createQuestionnaireExtension, QuestionnaireStore } from "./desktop.js";
import { QUESTIONNAIRE_EXTRA, type UiQuestionnaireQuestion } from "./protocol.js";

const questions: UiQuestionnaireQuestion[] = [
  { question: "Which colour?", header: "Theme", multiSelect: false, options: [{ label: "red", description: "warm" }, { label: "blue", description: "cool" }] },
  { question: "Which sizes?", header: "Size", multiSelect: true, options: [{ label: "S", description: "" }, { label: "M", description: "" }, { label: "L", description: "" }] },
];
const ask = (index: number, kind: "select" | "input", options?: string[]): ExtensionUiPrompt => ({
  id: `p${index}`, sessionId: "s1", kind, title: `[${questions[index]!.header}] ${questions[index]!.question}`, options,
  extras: { [QUESTIONNAIRE_EXTRA]: { index, questions } },
});

afterEach(cleanup);

describe("Questionnaire Kit", () => {
  it("pages ahead, takes a pick for a later question, and answers it when the extension gets there", () => {
    const store = new QuestionnaireStore();
    const { registry } = createKitHarness();
    registry.activate(createQuestionnaireExtension(store));
    const first = ask(0, "select", ["red", "blue"]);
    // A fresh questionnaire is never intercepted and forgets older picks in the thread.
    store.set("s1", 1, { labels: ["L"], answered: false });
    expect(registry.interceptPrompt(first)).toBeUndefined();
    expect(store.choice("s1", 1)).toBeUndefined();
    const renderer = registry.getPromptRenderer(first)!;
    const onAnswer = vi.fn();
    render(<renderer.Component prompt={first} pending={0} onAnswer={onAnswer} onCancel={() => {}} />);
    expect(screen.getByText("1/2")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Next question"));
    fireEvent.click(screen.getByText("S"));
    fireEvent.click(screen.getByText("M"));
    expect(screen.getByText(/“S, M” is sent when the extension gets here/u)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Previous question"));
    fireEvent.click(screen.getByText("red"));
    expect(onAnswer).toHaveBeenCalledWith("red");
    registry.notifyPromptAnswered(first, { value: "red" });
    expect(store.choice("s1", 0)).toEqual({ labels: ["red"], answered: true });
    // The second question arrives as a free-text input listing the options; the pick answers it as option numbers.
    expect(registry.interceptPrompt(ask(1, "input"))).toEqual({ value: "1,2" });
    expect(store.choice("s1", 1)).toEqual({ labels: ["S", "M"], answered: true });
    expect(registry.interceptPrompt(ask(1, "input"))).toBeUndefined();
  });

  it("registers multi-select submission for the composer and marks choice modes", () => {
    const store = new QuestionnaireStore();
    const { registry } = createKitHarness();
    registry.activate(createQuestionnaireExtension(store));
    const prompt = ask(1, "input");
    const renderer = registry.getPromptRenderer(prompt)!;
    const onAnswer = vi.fn();
    let action: PromptSubmitAction | undefined;

    render(
      <PromptSubmitContext.Provider value={(next) => { action = next; }}>
        <renderer.Component prompt={prompt} pending={0} onAnswer={onAnswer} onCancel={() => {}} />
      </PromptSubmitContext.Provider>,
    );

    expect(screen.getByText("Multiple choice")).toBeTruthy();
    expect(screen.getByText("S").closest("button")?.classList.contains("mode-checkbox")).toBe(true);
    fireEvent.click(screen.getByText("S"));
    expect(screen.getByText("Multiple choice · 1 selected")).toBeTruthy();
    expect(action?.label).toBe("Send 1");
    expect(action?.disabled).toBe(false);
    action?.submit();
    expect(onAnswer).toHaveBeenCalledWith("1");
  });

  it("keeps typed free text as the page summary and leaves prompts without a questionnaire to core", () => {
    const store = new QuestionnaireStore();
    const { registry } = createKitHarness();
    registry.activate(createQuestionnaireExtension(store));
    registry.notifyPromptAnswered(ask(0, "select", ["red", "blue"]), { value: "purple", typed: true });
    expect(store.choice("s1", 0)).toEqual({ labels: ["purple"], answered: true });
    expect(registry.getPromptRenderer({ id: "x", sessionId: "s1", kind: "confirm", title: "Sure?" })).toBeUndefined();
    expect(registry.getPromptRenderer({ ...ask(0, "select"), answerElsewhere: true })).toBeUndefined();
  });

  it("pages a runtime's form whose later field takes free text", () => {
    const { registry } = createKitHarness();
    registry.activate(createQuestionnaireExtension(new QuestionnaireStore()));
    const form: UiQuestionnaireQuestion[] = [
      { question: "Environment", header: "deploy", multiSelect: false, options: [{ label: "Staging", description: "" }] },
      { question: "Note (optional)", header: "deploy", multiSelect: false, options: [] },
    ];
    const prompt: ExtensionUiPrompt = { id: "f0", sessionId: "s1", kind: "select", title: "Environment", options: ["Staging"], extras: { [QUESTIONNAIRE_EXTRA]: { index: 0, questions: form } } };
    const renderer = registry.getPromptRenderer(prompt)!;
    render(<renderer.Component prompt={prompt} pending={0} onAnswer={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByLabelText("Next question"));
    expect(screen.getByText("Free text")).toBeTruthy();
    expect(screen.getByText("answered below when the extension gets here")).toBeTruthy();
  });
});

