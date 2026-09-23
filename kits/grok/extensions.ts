import type { BackendPrompt, ExtensionUiAnswer } from "tau/host-extension";
import { tagQuestionnaire, type QuestionnaireQuestion } from "../_acp/approvals.js";
import type { AcpCommand, AcpSessionUpdate } from "../_acp/events.js";

/**
 * xAI's own ACP methods and fields: questions for the user, the plan Grok
 * leaves plan mode with, its commands and the usage a turn reports.
 */
export const ASK_USER_QUESTION = ["_x.ai/ask_user_question", "x.ai/ask_user_question"] as const;
export const EXIT_PLAN_MODE = ["_x.ai/exit_plan_mode", "x.ai/exit_plan_mode"] as const;
/** Grok's cost unit: 10^10 ticks to the dollar. */
const TICKS_PER_USD = 10_000_000_000;
const LABEL_MAX = 512;
const clip = (text: string) => text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The request's own fields; Grok sometimes wraps them as `{ method, params }`. */
function unwrap(value: unknown): Record<string, unknown> {
  const item = record(value) ?? {};
  return typeof item.method === "string" && record(item.params) ? record(item.params)! : item;
}

export interface GrokQuestion { id?: string; question: string; options: Array<{ label: string; description?: string; preview?: string }>; multiSelect?: boolean | null }
export type GrokAskAnswer =
  | { outcome: "accepted"; answers: Record<string, string[]>; annotations?: Record<string, { notes?: string; preview?: string }> }
  | { outcome: "cancelled" };

export function grokQuestions(params: unknown): GrokQuestion[] {
  const questions = unwrap(params).questions;
  return (Array.isArray(questions) ? questions : []).flatMap((entry) => {
    const item = record(entry);
    const question = typeof item?.question === "string" ? item.question.trim() : "";
    if (!question) return [];
    const options = (Array.isArray(item!.options) ? item!.options : []).flatMap((option) => {
      const choice = record(option);
      return typeof choice?.label === "string" && choice.label.trim()
        ? [{ label: choice.label.trim(), ...(typeof choice.description === "string" ? { description: choice.description } : {}), ...(typeof choice.preview === "string" ? { preview: choice.preview } : {}) }]
        : [];
    });
    return [{ ...(typeof item!.id === "string" ? { id: item!.id } : {}), question, options, multiSelect: item!.multiSelect === true }];
  });
}

/**
 * One dialog per question, paged by Questionnaire Kit. Several answers are
 * option numbers (`1,3`); anything the user typed goes to Grok as a note
 * beside "Other", the way its own window answers.
 */
export function askQuestionDialogs(params: unknown): { prompts: BackendPrompt[]; answer(replies: readonly ExtensionUiAnswer[]): GrokAskAnswer } {
  const questions = grokQuestions(params);
  const paged: QuestionnaireQuestion[] = questions.map((question) => ({
    question: clip(question.question),
    header: "Grok",
    multiSelect: question.multiSelect === true,
    options: (question.options.length ? question.options : [{ label: "OK", description: "Continue" }]).map((option) => ({ label: option.label, description: option.description ?? "" })),
  }));
  const prompts = paged.map((question, index): BackendPrompt => {
    const prompt: BackendPrompt = question.multiSelect
      ? { kind: "input", title: question.question, placeholder: "Option numbers, e.g. 1,3" }
      : { kind: "select", title: question.question, options: question.options.map((option) => option.label) };
    if (paged.length > 1 || question.multiSelect) tagQuestionnaire(prompt, index, paged);
    return prompt;
  });
  return {
    prompts,
    answer: (replies) => {
      if (replies.length < questions.length || replies.some((reply) => "cancelled" in reply)) return { outcome: "cancelled" };
      const answers: Record<string, string[]> = {};
      const annotations: Record<string, { notes?: string; preview?: string }> = {};
      questions.forEach((question, index) => {
        const reply = replies[index]!;
        const options = question.options.length ? question.options : [{ label: "OK" }];
        const value = "value" in reply ? reply.value.trim() : "confirmed" in reply && reply.confirmed ? options[0]!.label : "";
        if (!value) return;
        let labels: string[];
        let notes: string | undefined;
        if (question.multiSelect && /^\s*\d+(?:\s*,\s*\d+)*\s*$/u.test(value)) {
          labels = value.split(",").flatMap((entry) => { const option = options[Number(entry.trim()) - 1]; return option ? [option.label] : []; });
        } else {
          const match = "typed" in reply && reply.typed ? undefined : options.find((option) => option.label === value);
          labels = match ? [match.label] : [];
          if (!match) notes = value;
        }
        answers[question.question] = labels.length ? labels : ["Other"];
        const preview = !question.multiSelect ? question.options.find((option) => labels.includes(option.label))?.preview?.trim() : undefined;
        if (notes || preview) annotations[question.question] = { ...(preview ? { preview } : {}), ...(notes ? { notes } : {}) };
      });
      return { outcome: "accepted", answers, ...(Object.keys(annotations).length ? { annotations } : {}) };
    },
  };
}

/** Grok left plan mode with nothing written. */
export const EMPTY_PLAN = "# No plan written yet\n\n(Grok left plan mode without writing a plan.)";

/** The plan `exit_plan_mode` carries, else the last plan file Grok wrote this turn. */
export function exitPlanMarkdown(params: unknown, fallback: string | undefined): string {
  const content = unwrap(params).planContent;
  return (typeof content === "string" && content.trim()) || fallback?.trim() || EMPTY_PLAN;
}

/** The plan as the block Plan Kit draws as a card. */
export function planReply(markdown: string): string {
  return `<proposed_plan>\n${markdown.trim()}\n</proposed_plan>`;
}

/** Tau shows the plan; Grok's own approval window is closed so the turn can end, and building it is the user's next prompt. */
export const PLAN_CAPTURED = { outcome: "abandoned", feedback: "Tau is showing your plan to the user. Stop here and wait for their feedback or their request to implement it in a later turn." } as const;

/**
 * True for Grok's session plan file (`<home>/sessions/<cwd>/<session>/plan.md`,
 * home being `GROK_HOME` or `~/.grok`); a workspace's own `plan.md` is not one.
 */
export function isPlanFile(path: string | undefined, grokHome: string | undefined): boolean {
  if (!path) return false;
  const normalized = path.trim().replace(/\\/gu, "/");
  if (!normalized.endsWith("/plan.md") || normalized.split("/").includes("..")) return false;
  const home = grokHome?.trim().replace(/\\/gu, "/").replace(/\/+$/u, "");
  if (home && normalized.startsWith(`${home}/sessions/`)) return true;
  return /\/\.grok\/sessions\/(?:[^/]+\/)+plan\.md$/u.test(normalized);
}

/** The plan text of a tool call that writes Grok's plan file; undefined for any other tool. */
export function planWrite(update: AcpSessionUpdate, grokHome: string | undefined): string | undefined {
  const input = record(update.rawInput);
  const path = typeof input?.file_path === "string" ? input.file_path : typeof input?.path === "string" ? input.path : undefined;
  if (isPlanFile(path, grokHome) && typeof input?.content === "string") return input.content;
  for (const entry of Array.isArray(update.content) ? update.content : []) {
    if (entry.type === "diff" && isPlanFile(entry.path, grokHome) && typeof entry.newText === "string") return entry.newText;
  }
  return undefined;
}

/** Commands that would go around Tau: access changes belong to Tau's own control, and `/context` answers nothing over ACP. */
const HIDDEN_COMMANDS = new Set(["always-approve", "context"]);

export function visibleCommands(commands: readonly AcpCommand[]): AcpCommand[] {
  return commands.filter((command) => !HIDDEN_COMMANDS.has(command.name.toLowerCase()));
}

/** The commands `initialize` names before any session. */
export function initializeCommands(initialized: { _meta?: Record<string, unknown> | null } | undefined): AcpCommand[] {
  const listed = initialized?.["_meta"]?.availableCommands;
  return visibleCommands((Array.isArray(listed) ? listed : []).flatMap((entry) => {
    const command = record(entry);
    const name = typeof command?.name === "string" ? command.name.trim() : "";
    if (!name) return [];
    const description = typeof command!.description === "string" ? command!.description.trim() : "";
    const hint = typeof record(command!.input)?.hint === "string" ? String(record(command!.input)!.hint).trim() : "";
    return [{ name, ...(description ? { description } : {}), ...(hint ? { hint } : {}) }];
  }));
}

/** One model's share of a turn, as Tau counts tokens: input without its cached part. */
export interface GrokTurnUsage {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function ticks(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value / TICKS_PER_USD : undefined;
}

function tokens(raw: Record<string, unknown>): Omit<GrokTurnUsage, "model" | "costUsd"> {
  const cacheReadTokens = count(raw.cachedReadTokens);
  const cacheWriteTokens = count(raw.cacheCreationTokens);
  // Grok's input includes the cached part.
  const inputTokens = Math.max(0, count(raw.inputTokens) - cacheReadTokens - cacheWriteTokens);
  const outputTokens = count(raw.outputTokens);
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens };
}

/**
 * The usage of Grok's `turn_completed` update, one entry per model it names.
 * A model without its own cost gets a share of the rest by tokens.
 */
export function turnCompletedUsage(update: AcpSessionUpdate): GrokTurnUsage[] | undefined {
  if (update.sessionUpdate !== "turn_completed") return undefined;
  const usage = record((update as { usage?: unknown }).usage);
  if (!usage) return undefined;
  const total = ticks(usage.costUsdTicks);
  const models = Object.entries(record(usage.modelUsage) ?? {}).flatMap(([model, raw]) => {
    const entry = record(raw);
    if (!model || !entry) return [];
    const counted = tokens(entry);
    return counted.totalTokens > 0 ? [{ model, ...counted, own: ticks(entry.costUsdTicks) }] : [];
  });
  if (models.length === 0) {
    const counted = tokens(usage);
    return counted.totalTokens > 0 ? [{ ...counted, costUsd: total ?? 0 }] : [];
  }
  const priced = models.reduce((sum, entry) => sum + (entry.own ?? 0), 0);
  const unpriced = models.filter((entry) => entry.own === undefined).reduce((sum, entry) => sum + entry.totalTokens, 0);
  const rest = total === undefined ? 0 : Math.max(0, total - priced);
  return models.map(({ own, ...entry }) => ({ ...entry, costUsd: own ?? (unpriced > 0 ? rest * entry.totalTokens / unpriced : 0) }));
}
