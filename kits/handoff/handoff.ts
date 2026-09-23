import type { CompletionModelRef, CompletionRequest, UiToolRun } from "tau/host-extension";
import { HANDOFF_TAG, MERGE_BACK_TAG } from "./protocol.js";

/** A visible message as the kit reads it; `id` marks how far a merge-back reached. */
export interface ConversationMessage {
  id?: string;
  role: string;
  text: string;
}

/** What the source conversation may cost the summary's model, in characters. */
export const MAX_CONVERSATION_CHARS = 24_000;
const MAX_GOAL_CHARS = 2_000;
const MAX_FILES = 200;
const SUMMARY_TOKENS = 900;

export const HANDOFF_SYSTEM = [
  "You write a handoff note so that another coding agent can continue a conversation it has not seen.",
  "Be factual and brief; name files, commands and decisions exactly. Never invent anything.",
  "Use these Markdown sections and leave out any that would be empty:",
  "## Goal", "## Decisions and constraints", "## Done so far", "## Files", "## Open questions and next steps",
  "No preamble, no closing remarks, at most 250 words.",
].join("\n");

export const MERGE_BACK_SYSTEM = [
  "A forked conversation explored something on its own. You summarize what it found for the conversation it came from, which will continue with it.",
  "Be factual and brief; name files, commands and decisions exactly. Never invent anything.",
  "Use these Markdown sections and leave out any that would be empty:",
  "## What was done", "## Decisions", "## Files changed", "## Open points",
  "Under Files changed, list the files you are given, one per line. No preamble, at most 250 words.",
].join("\n");

const BLOCK = new RegExp(`(?:^|\\n)<(${HANDOFF_TAG}|${MERGE_BACK_TAG})>\\n[\\s\\S]*?\\n</\\1>(?:\\n|$)`, "gu");

/** The text without the handoff and merge-back blocks it carries. */
export function withoutBlocks(text: string): string {
  return text.replace(BLOCK, "\n").trim();
}

function line(message: ConversationMessage, limit = Number.POSITIVE_INFINITY): string | undefined {
  const text = message.text.trim();
  if (!text || (message.role !== "user" && message.role !== "assistant")) return undefined;
  const body = text.length > limit ? `${text.slice(0, limit)} …` : text;
  return `${message.role === "user" ? "User" : "Assistant"}: ${body}`;
}

/**
 * The conversation for the summary's model: the first request, which usually
 * states the goal, and then as much of the end as fits. The middle goes first
 * because the latest turns say where the work stands.
 */
export function conversationText(messages: readonly ConversationMessage[], maxChars = MAX_CONVERSATION_CHARS): string {
  const lines = messages.map((message) => line(message)).filter((entry): entry is string => Boolean(entry));
  if (lines.length === 0) return "";
  const firstUser = messages.findIndex((message) => message.role === "user" && message.text.trim());
  const goal = firstUser >= 0 ? line(messages[firstUser]!, MAX_GOAL_CHARS) : undefined;
  const tail: string[] = [];
  let budget = maxChars - (goal?.length ?? 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = lines[index]!;
    if (entry.length + 2 > budget) break;
    tail.unshift(entry);
    budget -= entry.length + 2;
  }
  if (tail.length === lines.length) return tail.join("\n\n");
  if (tail.length === 0) {
    // One turn longer than the budget: keep its end, where it concluded.
    const last = lines.at(-1)!;
    return [goal, `… ${last.slice(-Math.max(0, budget - 2))}`].filter(Boolean).join("\n\n");
  }
  return [goal, "[… earlier turns left out …]", ...tail].filter(Boolean).join("\n\n");
}

/** The messages after the one a previous merge-back ended at; all of them when it is unknown. */
export function messagesAfter<T extends ConversationMessage>(messages: readonly T[], through: string | undefined): T[] {
  if (!through) return [...messages];
  const index = messages.findIndex((message) => message.id === through);
  return index < 0 ? [...messages] : messages.slice(index + 1);
}

/** Workspace files an edit or a write touched, relative to `cwd` where they lie inside it. */
export function filesFromTool(tool: Pick<UiToolRun, "name" | "args" | "status">, cwd?: string): string[] {
  if (tool.status === "error" || !/^(?:edit|write|multiedit|apply_patch)$/iu.test(tool.name)) return [];
  const args = tool.args ?? {};
  const one = [args.path, args.file_path].find((value): value is string => typeof value === "string" && value.length > 0);
  const many = Array.isArray(args.paths) ? args.paths.filter((value): value is string => typeof value === "string" && value.length > 0) : [];
  const root = cwd ? `${cwd.replaceAll("\\", "/").replace(/\/+$/u, "")}/` : undefined;
  const relative = (path: string) => {
    const normal = path.replaceAll("\\", "/");
    return root && normal.startsWith(root) ? normal.slice(root.length) : normal;
  };
  return [...new Set([...(one ? [one] : []), ...many].map(relative))];
}

export function addFiles(known: readonly string[], added: readonly string[]): string[] {
  const next = [...known];
  for (const file of added) if (!next.includes(file)) next.push(file);
  return next.slice(-MAX_FILES);
}

export interface SummaryFacts {
  /** Where the conversation happened: the source thread's title, runtime and model. */
  source: string;
  cwd: string;
}

export function handoffRequest(conversation: string, facts: SummaryFacts): CompletionRequest {
  return {
    system: HANDOFF_SYSTEM,
    prompt: `Project folder: ${facts.cwd}\nConversation (${facts.source}):\n\n${conversation}`,
    maxTokens: SUMMARY_TOKENS,
  };
}

export function mergeBackRequest(conversation: string, files: readonly string[], facts: SummaryFacts): CompletionRequest {
  return {
    system: MERGE_BACK_SYSTEM,
    prompt: [
      `Project folder: ${facts.cwd}`,
      `Files the fork changed: ${files.length > 0 ? files.join(", ") : "none recorded"}`,
      `Forked conversation (${facts.source}):`,
      "",
      conversation,
    ].join("\n"),
    maxTokens: SUMMARY_TOKENS,
  };
}

/**
 * The summary without a model: the latest turns, shortened. Used when no small
 * model is reachable, because the handoff must never fall back to an expensive one.
 */
export function excerptSummary(messages: readonly ConversationMessage[], files: readonly string[] = [], maxChars = 4_000): string {
  const recent = conversationText(messages.map((message) => ({ ...message, text: message.text.length > 600 ? `${message.text.slice(0, 600)} …` : message.text })), maxChars);
  return [
    "## Recent conversation",
    recent || "(nothing yet)",
    ...(files.length > 0 ? ["", "## Files changed", ...files.map((file) => `- ${file}`)] : []),
  ].join("\n");
}

export type Complete = (request: CompletionRequest, model: CompletionModelRef) => Promise<string>;

export interface WrittenSummary {
  text: string;
  /** The model that wrote it, as `provider/id`; absent for the excerpt. */
  model?: string;
  /** Why the excerpt stands in for a summary. */
  fallback?: string;
}

/**
 * One summary on the small model; the excerpt when there is none or it fails.
 * Never the user's default model: that may be the most expensive one they have.
 */
export async function writeSummary(
  complete: Complete,
  model: CompletionModelRef | undefined,
  request: CompletionRequest,
  fallback: () => string,
): Promise<WrittenSummary> {
  if (!model) return { text: fallback(), fallback: "no small model is configured" };
  try {
    const text = (await complete(request, model)).trim();
    if (text) return { text, model: `${model.provider}/${model.id}` };
    return { text: fallback(), fallback: "the model answered with nothing" };
  } catch (error) {
    return { text: fallback(), fallback: error instanceof Error ? error.message : String(error) };
  }
}
