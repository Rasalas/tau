import { QUESTIONNAIRE_HOST_EXTENSION_ID, tagQuestionnaire, type UiQuestionnaireQuestion } from "../../shared/questionnaire-protocol.js";
import type { HostExtension, HostExtensionContext } from "../host-extensions.js";
import { createQuestionnaireExtension } from "../questionnaire-extension.js";

/**
 * Questionnaire Kit's host entry. The ask-user tool walks its questions one
 * dialog at a time; this listens for the whole questionnaire on Pi's event bus
 * and tags each dialog with its place in it, so the workbench can page ahead.
 */
export function createQuestionnaireHostExtension(): HostExtension {
  return {
    id: QUESTIONNAIRE_HOST_EXTENSION_ID,
    name: "Questionnaires",
    permissions: ["runtime:extend"],
    activate(context: HostExtensionContext) {
      const { services } = context;
      /** Questionnaires announced per thread, and how many of their questions were asked so far. */
      const questionnaires = new Map<string, { questions: UiQuestionnaireQuestion[]; asked: number }>();
      services.registerRuntimeExtension("tau-questionnaire", createQuestionnaireExtension({
        onQuestionnaire: (sessionId, questions) => questionnaires.set(sessionId, { questions, asked: 0 }),
        onCleared: (sessionId) => questionnaires.delete(sessionId),
      }));
      services.decorateUiPrompt((prompt) => {
        if (prompt.kind !== "select" && prompt.kind !== "input") return;
        const questionnaire = questionnaires.get(prompt.sessionId);
        if (!questionnaire) return;
        const { questions } = questionnaire;
        const byTitle = questions.findIndex((q) => prompt.title.startsWith(`${q.header ? `[${q.header}] ` : ""}${q.question}`));
        const index = byTitle >= 0 ? byTitle : Math.min(questionnaire.asked, questions.length - 1);
        questionnaire.asked = index + 1;
        tagQuestionnaire(prompt, { index, questions });
      });
    },
  };
}
