import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { UiQuestionnaireQuestion } from "./protocol.js";

/** Events `@juicesharp/rpiv-ask-user-question` publishes on Pi's shared bus. */
export const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt";
export const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked";

export interface QuestionnaireControl {
  onQuestionnaire(sessionId: string, questions: UiQuestionnaireQuestion[]): void;
  onCleared(sessionId: string): void;
}

function readQuestions(payload: unknown): UiQuestionnaireQuestion[] | undefined {
  const questions = (payload as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions)) return undefined;
  const parsed: UiQuestionnaireQuestion[] = [];
  for (const raw of questions) {
    const item = raw as { question?: unknown; header?: unknown; multiSelect?: unknown; options?: unknown };
    if (typeof item?.question !== "string" || !Array.isArray(item.options)) return undefined;
    parsed.push({
      question: item.question,
      header: typeof item.header === "string" ? item.header : "",
      multiSelect: item.multiSelect === true,
      options: item.options.map((option) => {
        const value = option as { label?: unknown; description?: unknown };
        return { label: String(value?.label ?? ""), description: String(value?.description ?? "") };
      }),
    });
  }
  return parsed;
}

/**
 * The ask tool walks its questions one dialog at a time on RPC hosts, so Tau
 * would only ever see the current one. The tool announces the whole
 * questionnaire first; listening to that lets the workbench page through it.
 */
export function createQuestionnaireExtension(control: QuestionnaireControl): ExtensionFactory {
  return (pi) => {
    let sessionId = "";
    pi.on("session_start", (_event, ctx) => { sessionId = ctx.sessionManager.getSessionId(); });
    pi.on("before_agent_start", (_event, ctx) => { sessionId = ctx.sessionManager.getSessionId(); });
    pi.events.on(ASK_USER_PROMPT_EVENT, (payload) => {
      const questions = readQuestions(payload);
      if (questions && sessionId) control.onQuestionnaire(sessionId, questions);
    });
    pi.events.on(ASK_USER_BLOCKED_EVENT, (payload) => {
      if ((payload as { active?: unknown } | null)?.active === false && sessionId) control.onCleared(sessionId);
    });
  };
}
