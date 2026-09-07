import type { PermissionResult, PermissionUpdate, UserDialogResult } from "@anthropic-ai/claude-agent-sdk";
import type { BackendPrompt, ExtensionUiAnswer } from "tau/host-extension";

export const ALLOW = "Allow";
export const ALLOW_SESSION = "Allow for this session";
export const DENY = "Deny";

export const COMPACT_AND_CONTINUE = "Compact and continue";
export const KEEP_HISTORY = "Keep full history";
export const NEVER_ASK = "Don't ask again";

const SUMMARY_LIMIT = 240;

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  suggestions?: PermissionUpdate[];
}

/** One line naming what the tool is about to do, from the argument that matters for it. */
export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };
  const summary = pick("command", "file_path", "path", "pattern", "url", "query", "prompt", "description")
    ?? Object.entries(input).find(([, value]) => typeof value === "string" && value.trim())?.[1] as string | undefined
    ?? (Object.keys(input).length > 0 ? JSON.stringify(input) : "");
  const line = summary.replace(/\s+/gu, " ").trim();
  const text = line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT - 1)}…` : line;
  return text ? `${toolName}: ${text}` : toolName;
}

export function permissionPrompt(request: PermissionRequest): BackendPrompt {
  const message = [
    summarizeToolInput(request.toolName, request.input),
    request.description,
    request.decisionReason,
    request.blockedPath ? `Outside the allowed directories: ${request.blockedPath}` : undefined,
  ].filter((part): part is string => Boolean(part && part.trim())).join("\n");
  return {
    kind: "select",
    title: request.title ?? `Claude wants to run ${request.displayName ?? request.toolName}`,
    message,
    options: [ALLOW, ALLOW_SESSION, DENY],
  };
}

/**
 * "Allow for this session" must not outlive the session. Claude's own
 * suggestions usually target the project's local settings file, so each is
 * rescoped; without a suggestion (common for MCP tools) the whole tool is
 * allowed for the session, so the choice still sticks.
 */
export function sessionPermissionUpdates(suggestions: PermissionUpdate[] | undefined, toolName: string): PermissionUpdate[] {
  const rescoped = (suggestions ?? []).flatMap((update): PermissionUpdate[] => {
    if (update.type === "addRules" || update.type === "replaceRules" || update.type === "addDirectories") return [{ ...update, destination: "session" }];
    return [];
  });
  return rescoped.length > 0 ? rescoped : [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }];
}

export function permissionResultFor(answer: ExtensionUiAnswer, request: PermissionRequest): PermissionResult {
  if ("confirmed" in answer) {
    return answer.confirmed
      ? { behavior: "allow", decisionClassification: "user_temporary" }
      : { behavior: "deny", message: "The user declined this tool call.", decisionClassification: "user_reject" };
  }
  if ("value" in answer) {
    if (answer.typed) return { behavior: "deny", message: `The user declined and said: ${answer.value}`, decisionClassification: "user_reject" };
    if (answer.value === ALLOW) return { behavior: "allow", decisionClassification: "user_temporary" };
    if (answer.value === ALLOW_SESSION) {
      return { behavior: "allow", updatedPermissions: sessionPermissionUpdates(request.suggestions, request.toolName), decisionClassification: "user_permanent" };
    }
    return { behavior: "deny", message: "The user declined this tool call.", decisionClassification: "user_reject" };
  }
  return { behavior: "deny", message: "The user cancelled the request.", decisionClassification: "user_reject" };
}

export interface AskUserQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface QuestionPrompt {
  question: string;
  prompt: BackendPrompt;
  /** The label behind each option string, in order. */
  labels: string[];
}

/** One workbench select per question; the option rows read "Label — description". */
export function askUserQuestionPrompts(input: Record<string, unknown>): QuestionPrompt[] {
  const questions = Array.isArray(input.questions) ? input.questions as AskUserQuestion[] : [];
  return questions.filter((question) => typeof question?.question === "string").map((question) => {
    const options = Array.isArray(question.options) ? question.options.filter((option) => typeof option?.label === "string") : [];
    return {
      question: question.question,
      labels: options.map((option) => option.label),
      prompt: {
        kind: "select",
        title: question.question,
        ...(question.header ? { message: question.multiSelect ? `${question.header} · several may apply; name them all in one answer` : question.header } : {}),
        options: options.map((option) => option.description ? `${option.label} — ${option.description}` : option.label),
      },
    };
  });
}

/** The answer Claude reads: a chosen label, or what the user typed instead. */
export function askUserQuestionAnswer(answer: ExtensionUiAnswer, prompt: QuestionPrompt): string | undefined {
  if (!("value" in answer)) return undefined;
  if (answer.typed) return answer.value;
  const at = prompt.prompt.options?.indexOf(answer.value) ?? -1;
  return at >= 0 ? prompt.labels[at] : answer.value;
}

export function planPrompt(): BackendPrompt {
  return {
    kind: "confirm",
    title: "Approve Claude's plan?",
    message: "Claude finished planning and asks to start implementing. Approve to continue, or decline and tell it what to change.",
  };
}

export const PLAN_DECLINED = "The user did not approve the plan. Stay in plan mode and wait for their instructions.";

export function resumeDialogPrompt(): BackendPrompt {
  return {
    kind: "select",
    title: "This conversation is long. Compact it before continuing?",
    options: [COMPACT_AND_CONTINUE, KEEP_HISTORY, NEVER_ASK],
  };
}

export function resumeDialogResult(answer: ExtensionUiAnswer): UserDialogResult {
  if (!("value" in answer) || answer.typed) return { behavior: "cancelled" };
  if (answer.value === COMPACT_AND_CONTINUE) return { behavior: "completed", result: "compact" };
  if (answer.value === KEEP_HISTORY) return { behavior: "completed", result: "continue" };
  if (answer.value === NEVER_ASK) return { behavior: "completed", result: "never" };
  return { behavior: "cancelled" };
}
