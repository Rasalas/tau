import type { BackendPrompt, ExtensionUiAnswer, RuntimePermissionLevel } from "tau/host-extension";
import type { OpenCodePermissionRule } from "./client.js";
import { TAU_MCP_SERVER } from "./events.js";
import { tagQuestionnaire, type QuestionnaireQuestion } from "./protocol.js";

/**
 * OpenCode's permission requests and questions on the workbench's dialog
 * surface, and Tau's access levels as OpenCode's own permission rules.
 */
export const ALLOW = "Allow";
export const ALLOW_SESSION = "Allow for this session";
export const DENY = "Deny";
const LABEL_MAX = 600;

const rule = (permission: string, action: OpenCodePermissionRule["action"], pattern = "*"): OpenCodePermissionRule => ({ permission, pattern, action });

/** What only looks around: allowed at every level. `.env` files still ask where anything asks. */
const LOOKING = ["read", "glob", "grep", "list", "lsp", "skill", "todoread", "todowrite", "question"];

/**
 * The session's rules; later rules win. Tau's own MCP tools never ask here:
 * Tau's gate asks for them, as it does for Pi.
 * read-only: nothing that writes; a command still asks, since OpenCode has no sandbox to hold it.
 * ask: looking is free, everything else asks first.
 * auto: as ask; OpenCode has no reviewer of its own.
 * full: nothing asks, the way a Pi thread at full access runs.
 */
export function rulesForLevel(level: RuntimePermissionLevel): OpenCodePermissionRule[] {
  const tau = rule(`${TAU_MCP_SERVER}_*`, "allow");
  if (level === "full") return [rule("*", "allow"), rule("external_directory", "allow"), tau];
  const envFiles = [rule("read", "ask", "*.env"), rule("read", "ask", "*.env.*"), rule("read", "allow", "*.env.example")];
  if (level === "read-only") {
    return [rule("*", "deny"), ...LOOKING.map((name) => rule(name, "allow")), ...envFiles, rule("bash", "ask"), rule("webfetch", "ask"), rule("websearch", "ask"), rule("edit", "deny"), tau];
  }
  return [rule("*", "ask"), ...LOOKING.map((name) => rule(name, "allow")), ...envFiles, tau];
}

function clip(text: string): string {
  const line = text.trim();
  return line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX - 1)}…` : line;
}

export interface PermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
}

const TITLES: Record<string, string> = {
  bash: "OpenCode wants to run a command",
  edit: "OpenCode wants to edit files",
  write: "OpenCode wants to write a file",
  read: "OpenCode wants to read a file",
  webfetch: "OpenCode wants to fetch a page",
  websearch: "OpenCode wants to search the web",
  external_directory: "OpenCode wants to work outside the project",
  doom_loop: "OpenCode keeps repeating the same call",
  task: "OpenCode wants to start a sub-agent",
};

/** The dialog for a permission request, and OpenCode's reply for each answer. */
export function permissionDialog(request: PermissionRequest): { prompt: BackendPrompt; reply(answer: ExtensionUiAnswer | undefined): "once" | "always" | "reject" } {
  const patterns = (request.patterns ?? []).filter((pattern) => pattern && pattern !== "*");
  const metadata = request.metadata ?? {};
  const detail = typeof metadata.command === "string" ? metadata.command
    : typeof metadata.filepath === "string" ? metadata.filepath
      : typeof metadata.filePath === "string" ? metadata.filePath
        : patterns.join("\n");
  const always = (request.always ?? []).filter((pattern) => pattern && pattern !== "*");
  const lines = [detail, always.length ? `For this session: ${always.join(", ")}` : ""].filter(Boolean).join("\n");
  const title = TITLES[request.permission] ?? `OpenCode asks for “${request.permission}”`;
  return {
    prompt: { kind: "select", title, ...(lines ? { message: clip(lines) } : {}), options: [ALLOW, ALLOW_SESSION, DENY] },
    reply: (answer) => {
      if (!answer || !("value" in answer) || answer.typed) return "reject";
      return answer.value === ALLOW ? "once" : answer.value === ALLOW_SESSION ? "always" : "reject";
    },
  };
}

export interface QuestionInfo {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiple?: boolean;
  custom?: boolean;
}

/**
 * One dialog per question, paged together by Questionnaire Kit. A question
 * with several answers is free text that Questionnaire fills with option
 * numbers (`1,3`); one without options is free text.
 */
export function questionDialogs(questions: readonly QuestionInfo[]): { prompts: BackendPrompt[]; answers(replies: readonly ExtensionUiAnswer[]): string[][] | undefined } {
  const paged: QuestionnaireQuestion[] = questions.map((question) => ({
    question: clip(question.question || question.header || "OpenCode asks"),
    header: question.header?.trim() ?? "",
    multiSelect: question.multiple === true,
    options: (question.options ?? []).map((option) => ({ label: option.label, description: option.description ?? "" })),
  }));
  const prompts = paged.map((question, index): BackendPrompt => {
    const title = question.header ? `[${question.header}] ${question.question}` : question.question;
    const prompt: BackendPrompt = question.options.length && !question.multiSelect
      ? { kind: "select", title, options: question.options.map((option) => option.label) }
      : { kind: "input", title, ...(question.multiSelect ? { placeholder: "Option numbers, e.g. 1,3" } : {}) };
    if (questions.length > 1 || question.multiSelect) tagQuestionnaire(prompt, index, paged);
    return prompt;
  });
  return {
    prompts,
    answers: (replies) => {
      if (replies.length < questions.length || replies.some((reply) => "cancelled" in reply)) return undefined;
      return paged.map((question, index) => {
        const reply = replies[index]!;
        if (!("value" in reply) || !reply.value.trim()) return [];
        if (question.multiSelect && /^\s*\d+(?:\s*,\s*\d+)*\s*$/u.test(reply.value)) {
          return reply.value.split(",").flatMap((entry) => { const option = question.options[Number(entry.trim()) - 1]; return option ? [option.label] : []; });
        }
        return [reply.value.trim()];
      });
    },
  };
}
