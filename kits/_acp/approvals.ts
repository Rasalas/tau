import { askElicitation, elicitationFieldTitle, elicitationFields, type BackendPrompt, type ElicitationField, type ExtensionUiAnswer } from "tau/host-extension";
import type { AcpElicitationAnswer, AcpElicitationRequest, AcpPermissionRequest, AcpPermissionResponse } from "./session.js";

/**
 * An agent's `session/request_permission` and forms on the workbench's dialog
 * surface. Two flavours share the permission method: an approval of a tool
 * call, and a native question whose choices are not approvals at all.
 */
export const ALLOW = "Allow";
export const ALLOW_THREAD = "Allow for this thread";
export const DENY = "Deny";
const LABEL_MAX = 512;

/**
 * Questionnaire Kit pages through prompts that carry this extra; its shape is
 * `UiQuestionnaire` in `kits/questionnaire/protocol.ts`.
 */
export const QUESTIONNAIRE_EXTRA = "tau.questionnaire";

export interface QuestionnaireQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string }>;
}

export function tagQuestionnaire(prompt: { extras?: Record<string, unknown> }, index: number, questions: readonly QuestionnaireQuestion[]): void {
  prompt.extras = { ...prompt.extras, [QUESTIONNAIRE_EXTRA]: { index, questions } };
}

function summarizeInput(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== "object") return typeof rawInput === "string" ? rawInput.slice(0, LABEL_MAX) : undefined;
  const input = rawInput as Record<string, unknown>;
  const command = input.CommandLine ?? input.command_line ?? input.commandLine ?? input.command;
  if (typeof command === "string") return command;
  if (Array.isArray(command)) return command.map(String).join(" ");
  const path = input.path ?? input.file_path ?? input.filePath ?? input.TargetFile;
  if (typeof path === "string") return path;
  try { return JSON.stringify(rawInput).slice(0, LABEL_MAX); } catch { return undefined; }
}

export interface PermissionDialog {
  prompt: BackendPrompt;
  answerFor(answer: ExtensionUiAnswer): AcpPermissionResponse;
}

export interface PermissionDialogOptions {
  /** How the dialog names the agent: `Cursor wants to run a tool`. */
  agent: string;
  /** A request that is the agent's own question rather than an approval. */
  isQuestion?(request: AcpPermissionRequest): boolean;
  /** A warning the agent attached, shown under the input. */
  warning?(request: AcpPermissionRequest): string | undefined;
}

/** A native question: its options verbatim, answered by the option chosen. */
function questionDialog(request: AcpPermissionRequest): PermissionDialog | undefined {
  const seen = new Set<string>();
  const options = request.options.map((option) => ({ id: option.optionId, label: (option.name.trim() || option.optionId).slice(0, LABEL_MAX) }));
  for (const option of options) {
    if (!option.id.trim() || seen.has(option.id)) return undefined;
    seen.add(option.id);
  }
  if (options.length === 0) return undefined;
  return {
    prompt: { kind: "select", title: request.toolCall.title?.trim() || "Choose an option.", options: options.map((option) => option.label) },
    answerFor: (answer) => {
      if ("value" in answer && !answer.typed) {
        const match = options.find((option) => option.label === answer.value) ?? options.find((option) => option.id === answer.value);
        if (match) return { outcome: { outcome: "selected", optionId: match.id } };
      }
      return { outcome: { outcome: "cancelled" } };
    },
  };
}

/** An approval: Allow, Allow for this thread (when the agent offers it), Deny. Anything else cancels. */
export function permissionDialog(request: AcpPermissionRequest, options: PermissionDialogOptions): PermissionDialog | undefined {
  if (options.isQuestion?.(request)) return questionDialog(request);
  const byKind = (kind: string) => request.options.find((option) => option.kind === kind)?.optionId;
  const allowOnce = byKind("allow_once");
  const allowAlways = byKind("allow_always");
  const rejectOnce = byKind("reject_once");
  if (!allowOnce && !allowAlways && !rejectOnce) return undefined;
  const warning = options.warning?.(request)?.trim().slice(0, LABEL_MAX);
  const message = [summarizeInput(request.toolCall.rawInput), warning ? `${options.agent} warns: ${warning}` : undefined].filter((part): part is string => Boolean(part)).join("\n");
  const choices = [...(allowOnce ? [ALLOW] : []), ...(allowAlways ? [ALLOW_THREAD] : []), ...(rejectOnce ? [DENY] : [])];
  return {
    prompt: { kind: "select", title: request.toolCall.title?.trim() || `${options.agent} wants to run ${request.toolCall.kind ?? "a tool"}`, ...(message ? { message } : {}), options: choices },
    answerFor: (answer) => {
      const select = (optionId: string | undefined): AcpPermissionResponse => optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
      if ("confirmed" in answer) return answer.confirmed ? select(allowOnce ?? allowAlways) : select(rejectOnce);
      if ("value" in answer) {
        if (answer.typed) return select(rejectOnce);
        if (answer.value === ALLOW) return select(allowOnce);
        if (answer.value === ALLOW_THREAD) return select(allowAlways);
        if (answer.value === DENY) return select(rejectOnce);
      }
      return { outcome: { outcome: "cancelled" } };
    },
  };
}

/** Full access answers for the user: allow once, else allow always; undefined when the agent offers neither. */
export function autoApproval(request: AcpPermissionRequest): AcpPermissionResponse | undefined {
  const option = request.options.find((entry) => entry.kind === "allow_once") ?? request.options.find((entry) => entry.kind === "allow_always");
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : undefined;
}

/** Tags each field's dialog so Questionnaire Kit pages through the form; one field needs no pager. */
function pageForm(agent: string) {
  return (prompt: BackendPrompt, index: number, fields: readonly ElicitationField[]): void => {
    if (fields.length < 2) return;
    tagQuestionnaire(prompt, index, fields.map((field) => ({
      question: elicitationFieldTitle(field),
      header: agent,
      multiSelect: field.kind === "choices",
      options: field.kind === "boolean" ? [{ label: "Yes", description: "" }, { label: "No", description: "" }] : (field.options ?? []).map((option) => ({ label: option.label, description: "" })),
    })));
  };
}

/** A form the agent wants filled, asked field by field; a form without fields is a yes or no. */
export async function answerElicitation(request: AcpElicitationRequest, ask: ((prompt: BackendPrompt) => Promise<ExtensionUiAnswer>) | undefined, agent: string): Promise<AcpElicitationAnswer> {
  const fields = elicitationFields(request.requestedSchema ?? { properties: {} });
  const message = (request.message ?? "").slice(0, LABEL_MAX);
  if (!fields || !ask) return { action: "decline" };
  if (fields.length === 0) {
    const answer = await ask({ kind: "select", title: `${agent} asks`, ...(message.trim() ? { message } : {}), options: [ALLOW, DENY] });
    if ("cancelled" in answer) return { action: "cancel" };
    return "value" in answer && answer.value === ALLOW && !answer.typed ? { action: "accept", content: {} } : { action: "decline" };
  }
  return askElicitation({ source: agent, message, fields, ask, decorate: pageForm(agent) });
}
