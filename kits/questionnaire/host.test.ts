import { describe, expect, it } from "vitest";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createQuestionnaireHostExtension } from "./host.js";
import { QUESTIONNAIRE_HOST_EXTENSION_ID, questionnaireOf, type TaggablePrompt } from "./protocol.js";

type Prompt = TaggablePrompt & { id: string; sessionId: string; kind: string; title: string; options?: string[] };

async function harness() {
  const decorators: Array<(prompt: never) => void> = [];
  let announce: ((payload: unknown) => void) | undefined;
  const registry = await activateHostKit(createQuestionnaireHostExtension(), {
    decorateUiPrompt: (decorator) => { decorators.push(decorator as (prompt: never) => void); return () => undefined; },
    registerRuntimeExtension: (_name, factory) => {
      // Drive the Pi extension the kit contributed with a fake ExtensionAPI.
      const piHandlers = new Map<string, (event: unknown, ctx: unknown) => void>();
      const busHandlers = new Map<string, (payload: unknown) => void>();
      factory({
        on: (event: string, handler: (event: unknown, ctx: unknown) => void) => { piHandlers.set(event, handler); },
        events: { on: (name: string, handler: (payload: unknown) => void) => { busHandlers.set(name, handler); } },
      } as never, { sessionId: "s1", cwd: "/project" });
      piHandlers.get("session_start")?.({}, { sessionManager: { getSessionId: () => "s1" } });
      announce = (payload) => busHandlers.get("rpiv:ask-user:prompt")?.(payload);
      return () => undefined;
    },
  });
  return { registry, decorate: (prompt: Prompt) => decorators.forEach((entry) => (entry as (p: Prompt) => void)(prompt)), announce: announce! };
}

describe("Questionnaire host extension", () => {
  it("tags select and input dialogs with their place in the announced questionnaire", async () => {
    const { decorate, announce } = await harness();
    announce({ questions: [
      { question: "Which colour?", header: "Theme", options: [{ label: "red" }, { label: "blue" }] },
      { question: "Which size?", options: [{ label: "s" }] },
    ] });
    const prompt: Prompt = { id: "p1", sessionId: "s1", kind: "select", title: "[Theme] Which colour?", options: ["red", "blue"] };
    decorate(prompt);
    expect(questionnaireOf(prompt)?.index).toBe(0);
    expect(questionnaireOf(prompt)?.questions).toHaveLength(2);
    const confirm: Prompt = { id: "p2", sessionId: "s1", kind: "confirm", title: "Sure?" };
    decorate(confirm);
    expect(questionnaireOf(confirm)).toBeUndefined();
  });

  it("does not activate without the runtime permission its manifest declares", async () => {
    const registry = await activateHostKit({ ...createQuestionnaireHostExtension(), permissions: [] });
    expect(registry.isActive(QUESTIONNAIRE_HOST_EXTENSION_ID)).toBe(false);
  });
});
