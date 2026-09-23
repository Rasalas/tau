import { askElicitation, elicitationFieldTitle, elicitationFields, type BackendPrompt, type ElicitationField, type ExtensionUiAnswer, type RuntimePermissionLevel } from "tau/host-extension";
import type { AcpElicitationAnswer, AcpElicitationRequest, AcpPermissionRequest, AcpPermissionResponse, AcpSelectOption } from "./acp-session.js";
import { QUESTIONNAIRE_EXTRA } from "./protocol.js";

/**
 * The agent's `session/request_permission` on the workbench's dialog surface.
 * Two flavours share the method: an approval of a tool call, and a native
 * question whose choices are not approvals at all.
 */
export const ALLOW = "Allow";
export const ALLOW_THREAD = "Allow for this thread";
export const DENY = "Deny";
const SECURITY_WARNING_META_KEY = "agy.security.warning";
const LABEL_MAX = 512;

export function isQuestion(request: AcpPermissionRequest): boolean {
  return request.toolCall.toolCallId.startsWith("interaction_");
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

function securityWarning(request: AcpPermissionRequest): string | undefined {
  const always = request.options.find((option) => option.kind === "allow_always");
  const warning = always?.["_meta"]?.[SECURITY_WARNING_META_KEY];
  if (!warning || typeof warning !== "object") return undefined;
  const { message, title } = warning as { message?: unknown; title?: unknown };
  const text = typeof message === "string" && message.trim() ? message : typeof title === "string" ? title : undefined;
  return text?.trim().slice(0, LABEL_MAX);
}

export interface PermissionDialog {
  prompt: BackendPrompt;
  answerFor(answer: ExtensionUiAnswer): AcpPermissionResponse;
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
export function permissionDialog(request: AcpPermissionRequest): PermissionDialog | undefined {
  if (isQuestion(request)) return questionDialog(request);
  const byKind = (kind: string) => request.options.find((option) => option.kind === kind)?.optionId;
  const allowOnce = byKind("allow_once");
  const allowAlways = byKind("allow_always");
  const rejectOnce = byKind("reject_once");
  if (!allowOnce && !allowAlways && !rejectOnce) return undefined;
  const warning = securityWarning(request);
  const message = [summarizeInput(request.toolCall.rawInput), warning ? `Antigravity warns: ${warning}` : undefined].filter((part): part is string => Boolean(part)).join("\n");
  const options = [...(allowOnce ? [ALLOW] : []), ...(allowAlways ? [ALLOW_THREAD] : []), ...(rejectOnce ? [DENY] : [])];
  return {
    prompt: { kind: "select", title: request.toolCall.title?.trim() || `Antigravity wants to run ${request.toolCall.kind ?? "a tool"}`, ...(message ? { message } : {}), options },
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

/** Tau's access level as one of the agent's session modes; the agent keeps its own when none fits. */
export function modeForLevel(level: RuntimePermissionLevel, available: readonly AcpSelectOption[]): string | undefined {
  const ids = new Set(available.map((option) => option.value));
  const first = (...candidates: string[]) => candidates.find((candidate) => ids.has(candidate));
  switch (level) {
    case "read-only": return first("plan", "default");
    case "ask": return first("default");
    case "full": return first("yolo", "auto_edit", "default");
    default: return undefined;
  }
}

/** Tags each field's dialog so Questionnaire Kit pages through the form; one field needs no pager. */
function pageForm(prompt: BackendPrompt, index: number, fields: readonly ElicitationField[]): void {
  if (fields.length < 2) return;
  const questions = fields.map((field) => ({
    question: elicitationFieldTitle(field),
    header: "Antigravity",
    multiSelect: field.kind === "choices",
    options: field.kind === "boolean" ? [{ label: "Yes", description: "" }, { label: "No", description: "" }] : (field.options ?? []).map((option) => ({ label: option.label, description: "" })),
  }));
  prompt.extras = { ...prompt.extras, [QUESTIONNAIRE_EXTRA]: { index, questions } };
}

/** A form the agent wants filled, asked field by field; a form without fields is a yes or no. */
export async function answerElicitation(request: AcpElicitationRequest, ask: ((prompt: BackendPrompt) => Promise<ExtensionUiAnswer>) | undefined): Promise<AcpElicitationAnswer> {
  const fields = elicitationFields(request.requestedSchema ?? { properties: {} });
  const message = (request.message ?? "").slice(0, LABEL_MAX);
  if (!fields || !ask) return { action: "decline" };
  if (fields.length === 0) {
    const answer = await ask({ kind: "select", title: "Antigravity asks", ...(message.trim() ? { message } : {}), options: [ALLOW, DENY] });
    if ("cancelled" in answer) return { action: "cancel" };
    return "value" in answer && answer.value === ALLOW && !answer.typed ? { action: "accept", content: {} } : { action: "decline" };
  }
  return askElicitation({ source: "Antigravity", message, fields, ask, decorate: pageForm });
}
