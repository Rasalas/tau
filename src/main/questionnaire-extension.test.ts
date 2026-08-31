import { describe, expect, it, vi } from "vitest";
import { ASK_USER_BLOCKED_EVENT, ASK_USER_PROMPT_EVENT, createQuestionnaireExtension } from "./questionnaire-extension.js";

function fakePi() {
  const hooks = new Map<string, (event: unknown, ctx: unknown) => void>();
  const bus = new Map<string, (data: unknown) => void>();
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => void) => { hooks.set(name, handler); },
    events: { on: (channel: string, handler: (data: unknown) => void) => { bus.set(channel, handler); return () => {}; }, emit: () => {} },
  };
  const ctx = { sessionManager: { getSessionId: () => "s1" } };
  return { pi, start: () => hooks.get("session_start")?.({}, ctx), emit: (channel: string, data: unknown) => bus.get(channel)?.(data) };
}

describe("questionnaire extension", () => {
  it("reports the announced questions for the session and clears when the tool is done", () => {
    const control = { onQuestionnaire: vi.fn(), onCleared: vi.fn() };
    const { pi, start, emit } = fakePi();
    createQuestionnaireExtension(control)(pi as never);
    start();
    emit(ASK_USER_PROMPT_EVENT, { questions: [
      { question: "Which colour?", header: "Colour", multiSelect: false, options: [{ label: "Red", description: "r", hasPreview: false }] },
    ] });
    expect(control.onQuestionnaire).toHaveBeenCalledWith("s1", [
      { question: "Which colour?", header: "Colour", multiSelect: false, options: [{ label: "Red", description: "r" }] },
    ]);
    emit(ASK_USER_BLOCKED_EVENT, { active: false });
    expect(control.onCleared).toHaveBeenCalledWith("s1");
  });

  it("ignores payloads that are not questionnaires", () => {
    const control = { onQuestionnaire: vi.fn(), onCleared: vi.fn() };
    const { pi, start, emit } = fakePi();
    createQuestionnaireExtension(control)(pi as never);
    start();
    emit(ASK_USER_PROMPT_EVENT, { questions: "nope" });
    expect(control.onQuestionnaire).not.toHaveBeenCalled();
  });
});
