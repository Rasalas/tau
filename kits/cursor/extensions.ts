import type { BackendPrompt, ExtensionUiAnswer } from "tau/host-extension";
import { tagQuestionnaire, type QuestionnaireQuestion } from "../_acp/approvals.js";

/**
 * Cursor's own ACP methods (cursor.com/docs/cli/acp): questions for the user,
 * a finished plan, the to-do list, sub-agent tasks and generated images.
 */
const LABEL_MAX = 512;
const clip = (text: string) => text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;

export interface CursorQuestion { id: string; prompt: string; options?: Array<{ id: string; label: string }>; allowMultiple?: boolean }
export interface CursorAskQuestion { toolCallId?: string; title?: string; questions?: CursorQuestion[] }
export type CursorAskAnswer = { outcome: { outcome: "answered"; answers: Array<{ questionId: string; selectedOptionIds: string[] }> } | { outcome: "skipped" } | { outcome: "cancelled" } };

export interface CursorTodo { id?: string; content?: string; title?: string; status?: string }
export interface CursorCreatePlan { toolCallId?: string; name?: string; overview?: string; plan?: string; todos?: CursorTodo[] }

/**
 * One dialog per question, paged together by Questionnaire Kit. A question
 * with several answers is free text Questionnaire fills with option numbers
 * (`1,3`); Cursor takes option ids only, so typed text answers nothing.
 */
export function askQuestionDialogs(request: CursorAskQuestion): { prompts: BackendPrompt[]; answer(replies: readonly ExtensionUiAnswer[]): CursorAskAnswer } {
  const questions = (request.questions ?? []).filter((question) => question && typeof question.id === "string");
  const paged: QuestionnaireQuestion[] = questions.map((question) => ({
    question: clip(question.prompt?.trim() || request.title?.trim() || "Cursor asks"),
    header: request.title?.trim() && request.title.trim() !== question.prompt?.trim() ? clip(request.title.trim()) : "",
    multiSelect: question.allowMultiple === true,
    options: (question.options?.length ? question.options : [{ id: "", label: "OK" }]).map((option) => ({ label: option.label, description: "" })),
  }));
  const prompts = paged.map((question, index): BackendPrompt => {
    const title = question.header ? `[${question.header}] ${question.question}` : question.question;
    const prompt: BackendPrompt = question.multiSelect
      ? { kind: "input", title, placeholder: "Option numbers, e.g. 1,3" }
      : { kind: "select", title, options: question.options.map((option) => option.label) };
    if (paged.length > 1 || question.multiSelect) tagQuestionnaire(prompt, index, paged);
    return prompt;
  });
  return {
    prompts,
    answer: (replies) => {
      if (replies.some((reply) => "cancelled" in reply)) return { outcome: { outcome: "cancelled" } };
      if (replies.length < questions.length) return { outcome: { outcome: "skipped" } };
      const answers = questions.map((question, index) => {
        const reply = replies[index]!;
        const options = question.options ?? [];
        if (!("value" in reply)) return { questionId: question.id, selectedOptionIds: [] };
        const byLabel = (label: string) => options.find((option) => option.label === label.trim())?.id;
        const chosen = question.allowMultiple && /^\s*\d+(?:\s*,\s*\d+)*\s*$/u.test(reply.value)
          ? reply.value.split(",").flatMap((entry) => { const option = options[Number(entry.trim()) - 1]; return option ? [option.id] : []; })
          : reply.typed ? [] : [byLabel(reply.value)].filter((id): id is string => Boolean(id));
        return { questionId: question.id, selectedOptionIds: chosen };
      });
      return { outcome: { outcome: "answered", answers } };
    },
  };
}

/** A finished plan as the block Plan Kit draws as a card. */
export function planReply(request: CursorCreatePlan): string {
  const name = request.name?.trim();
  const overview = request.overview?.trim();
  const plan = request.plan?.trim() || todoList(request.todos ?? []) || "(Cursor sent no plan text.)";
  const body = [name && !/^\s{0,3}#/u.test(plan) ? `# ${name}` : "", overview ?? "", plan].filter(Boolean).join("\n\n");
  return `<proposed_plan>\n${body}\n</proposed_plan>`;
}

/** The to-do list as a Markdown checklist; a cancelled item is struck through. */
export function todoList(todos: readonly CursorTodo[]): string {
  return todos.flatMap((todo) => {
    const step = todo.content?.trim() || todo.title?.trim();
    if (!step) return [];
    const status = todo.status?.toLowerCase();
    if (status === "cancelled") return [`- [ ] ~~${step}~~`];
    return [`- [${status === "completed" ? "x" : " "}] ${step}${status === "in_progress" || status === "inprogress" ? " (in progress)" : ""}`];
  }).join("\n");
}

/** A Cursor notification or request that becomes a tool card; undefined for methods Tau does not show. */
export function extensionCard(method: string, params: unknown): { id: string; name: string; args: Record<string, unknown>; output?: string } | undefined {
  const item = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  const id = typeof item.toolCallId === "string" && item.toolCallId ? item.toolCallId : `${method}-${Date.now()}`;
  switch (method) {
    case "cursor/update_todos": {
      const todos = Array.isArray(item.todos) ? item.todos as CursorTodo[] : [];
      return { id: `todos-${id}`, name: "Update todos", args: { todos: todos.length }, output: todoList(todos) };
    }
    case "cursor/task": {
      const description = typeof item.description === "string" ? item.description : "Sub-agent";
      const subagent = typeof item.subagentType === "string" ? item.subagentType : undefined;
      return { id, name: `Task: ${clip(description)}`, args: { ...(subagent ? { subagent } : {}), ...(typeof item.model === "string" ? { model: item.model } : {}) }, ...(typeof item.prompt === "string" ? { output: item.prompt } : {}) };
    }
    case "cursor/generate_image": {
      const path = typeof item.filePath === "string" ? item.filePath : undefined;
      return { id, name: "Generate image", args: { ...(path ? { path } : {}) }, ...(typeof item.description === "string" ? { output: item.description } : {}) };
    }
    default:
      return undefined;
  }
}

/** Cursor sometimes answers a turn whose transport failed with nothing but the diagnostic. */
const TRANSPORT_ERROR = /^Error: (?:RetriableError: (?!\[internal\]).+|ConnectError: \[(?:unavailable|aborted|deadline_exceeded)\].*)$/u;
const SERVER_ERROR = "Something went wrong communicating with the server. Please try again.";

/** The diagnostic, when a reply is only that (stack lines allowed); quoting one inside an answer does not count. */
export function transportFailure(reply: string): string | undefined {
  const lines = reply.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
  const first = lines[0];
  if (!first || !(TRANSPORT_ERROR.test(first) || first === SERVER_ERROR)) return undefined;
  return lines.slice(1).every((line) => /^\s+at\s/u.test(line)) ? first : undefined;
}
