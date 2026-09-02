import type { ExtensionUiPrompt } from "./contracts.js";

/**
 * Questionnaire Kit: the ask-user tool walks its questions one Pi dialog at a
 * time; the kit's host entry tags each dialog with the whole questionnaire so
 * its desktop half can page through it. The tag travels in the prompt's `extras`.
 */
export const QUESTIONNAIRE_HOST_EXTENSION_ID = "tau.questionnaire";
export const QUESTIONNAIRE_EXTRA = "tau.questionnaire";

export interface UiQuestionnaireQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string }>;
}

export interface UiQuestionnaire {
  /** Position of this prompt's question. */
  index: number;
  questions: UiQuestionnaireQuestion[];
}

export function questionnaireOf(prompt: ExtensionUiPrompt): UiQuestionnaire | undefined {
  const extra = prompt.extras?.[QUESTIONNAIRE_EXTRA] as Partial<UiQuestionnaire> | undefined;
  return extra && typeof extra.index === "number" && Array.isArray(extra.questions) ? extra as UiQuestionnaire : undefined;
}

export function tagQuestionnaire(prompt: ExtensionUiPrompt, questionnaire: UiQuestionnaire): void {
  prompt.extras = { ...prompt.extras, [QUESTIONNAIRE_EXTRA]: questionnaire };
}
