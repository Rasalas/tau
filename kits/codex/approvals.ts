import { elicitationFieldTitle, elicitationFields, type BackendPrompt, type ElicitationField, type ElicitationOutcome, type ExtensionUiAnswer, type RuntimePermissionLevel } from "tau/host-extension";
import type { CodexPolicy } from "./app-server.js";
import { displayCommand } from "./events.js";
import { tagQuestionnaire, type QuestionnaireQuestion } from "./protocol.js";

/**
 * Codex's requests to Tau on the workbench's dialog surface, and Tau's access
 * levels as Codex's own approval policy and sandbox.
 */
export const ALLOW = "Allow";
export const ALLOW_SESSION = "Allow for this session";
export const DENY = "Deny";
const LABEL_MAX = 600;

/**
 * read-only: Codex's read-only sandbox, never asking — a write fails.
 * ask: every command outside Codex's known-safe list and every edit asks
 * first; what is allowed runs inside the workspace sandbox.
 * full: no sandbox and no questions, as a Pi thread at full access runs.
 * With `network: "none"` Codex's sandbox holds at every level and has no
 * network; its seatbelt and Landlock rules offer no host list, so the package
 * sources a limit allows stay out of reach too.
 */
export function policyForLevel(level: RuntimePermissionLevel, options: { network?: "any" | "none" } = {}): CodexPolicy {
  // A project that limits its network gets Codex's sandbox without network at every level.
  if (options.network === "none") {
    if (level === "read-only") return { approvalPolicy: "never", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false } };
    return { approvalPolicy: level === "ask" ? "untrusted" : "never", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite", networkAccess: false } };
  }
  switch (level) {
    case "read-only": return { approvalPolicy: "never", sandbox: "read-only", sandboxPolicy: { type: "readOnly" } };
    case "ask": return { approvalPolicy: "untrusted", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite" } };
    default: return { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } };
  }
}

export interface ApprovalDialog {
  prompts: BackendPrompt[];
  /** One answer per prompt, in order; fewer when the user cancelled one. */
  resultFor(answers: readonly ExtensionUiAnswer[]): unknown;
}

function clip(text: string): string {
  const line = text.trim();
  return line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX - 1)}…` : line;
}

/** Allow / Allow for this session / Deny, as Codex's decision words. */
function decision(answer: ExtensionUiAnswer | undefined, words: { accept: string; session: string; decline: string; cancel: string }): string {
  if (!answer || "cancelled" in answer) return words.cancel;
  if ("confirmed" in answer) return answer.confirmed ? words.accept : words.decline;
  if ("value" in answer && !answer.typed) {
    if (answer.value === ALLOW) return words.accept;
    if (answer.value === ALLOW_SESSION) return words.session;
  }
  return words.decline;
}

const V2_WORDS = { accept: "accept", session: "acceptForSession", decline: "decline", cancel: "cancel" };
const LEGACY_WORDS = { accept: "approved", session: "approved_for_session", decline: "denied", cancel: "abort" };

function approval(title: string, message: string, words: typeof V2_WORDS, wrap: (word: string) => unknown): ApprovalDialog {
  return {
    prompts: [{ kind: "select", title, ...(message.trim() ? { message: clip(message) } : {}), options: [ALLOW, ALLOW_SESSION, DENY] }],
    resultFor: ([answer]) => wrap(decision(answer, words)),
  };
}

interface Question { id: string; header?: string; question: string; isOther?: boolean; options?: Array<{ label: string; description?: string }> | null }

/** One dialog per question, paged together; a question without choices is free text. */
function questions(list: readonly Question[]): ApprovalDialog {
  const titled = list.map((question) => ({ question: clip(question.question || question.header || "Codex asks"), header: question.header?.trim() ?? "", options: question.options ?? [] }));
  const paged: QuestionnaireQuestion[] = titled.map((question) => ({ ...question, multiSelect: false, options: question.options.map((option) => ({ label: option.label, description: option.description ?? "" })) }));
  return {
    prompts: titled.map((question, index): BackendPrompt => {
      const title = question.header ? `[${question.header}] ${question.question}` : question.question;
      const prompt: BackendPrompt = question.options.length
        ? { kind: "select", title, options: question.options.map((option) => option.label) }
        : { kind: "input", title };
      if (list.length > 1) tagQuestionnaire(prompt, index, paged);
      return prompt;
    }),
    resultFor: (answers) => ({
      answers: Object.fromEntries(list.flatMap((question, index) => {
        const answer = answers[index];
        return answer && "value" in answer && answer.value.trim() ? [[question.id, { answers: [answer.value] }]] : [];
      })),
    }),
  };
}

/**
 * The dialog for a request Codex sent, or undefined for one Tau does not
 * answer with a dialog. `changedPaths` names what a file change would touch.
 */
export function approvalDialog(method: string, params: Record<string, unknown>, changedPaths: (itemId: string) => readonly string[] = () => []): ApprovalDialog | undefined {
  const reason = typeof params.reason === "string" ? params.reason : "";
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const command = typeof params.command === "string" ? displayCommand(params.command) : "";
      const cwd = typeof params.cwd === "string" ? `in ${params.cwd}` : "";
      return approval("Codex wants to run a command", [command, cwd, reason].filter(Boolean).join("\n"), V2_WORDS, (word) => ({ decision: word }));
    }
    case "item/fileChange/requestApproval": {
      const paths = changedPaths(String(params.itemId ?? ""));
      const root = typeof params.grantRoot === "string" ? `Write access under ${params.grantRoot} for the rest of the session` : "";
      return approval(paths.length === 1 ? `Codex wants to edit ${paths[0]}` : "Codex wants to edit files", [paths.length > 1 ? paths.join("\n") : "", root, reason].filter(Boolean).join("\n"), V2_WORDS, (word) => ({ decision: word }));
    }
    case "item/permissions/requestApproval": {
      const requested = (params.permissions ?? {}) as Record<string, unknown>;
      const granted = Object.fromEntries(Object.entries(requested).filter(([, value]) => value !== null && value !== undefined));
      return approval("Codex asks for more permissions", [reason, ...permissionLines(granted)].filter(Boolean).join("\n"), V2_WORDS, (word) => word === "accept" || word === "acceptForSession"
        ? { permissions: granted, scope: word === "acceptForSession" ? "session" : "turn" }
        : { permissions: {}, scope: "turn" });
    }
    case "item/tool/requestUserInput":
      return Array.isArray(params.questions) && params.questions.length > 0 ? questions(params.questions as Question[]) : undefined;
    case "execCommandApproval": {
      const command = Array.isArray(params.command) ? params.command.map(String).join(" ") : "";
      return approval("Codex wants to run a command", [command, reason].filter(Boolean).join("\n"), LEGACY_WORDS, (word) => ({ decision: word === "denied" ? { denied: { rejection: "The user declined." } } : word }));
    }
    case "applyPatchApproval": {
      const paths = Object.keys((params.fileChanges ?? {}) as Record<string, unknown>);
      return approval("Codex wants to edit files", [paths.join("\n"), reason].filter(Boolean).join("\n"), LEGACY_WORDS, (word) => ({ decision: word === "denied" ? { denied: { rejection: "The user declined." } } : word }));
    }
    case "mcpServer/elicitation/request": {
      // A form with fields is asked field by field (`elicitationForm`); this is the plain yes/no.
      if (elicitationForm(params)?.fields.length !== 0) return undefined;
      return {
        prompts: [{ kind: "select", title: `${String(params.serverName ?? "An MCP server")} asks`, message: clip(String(params.message ?? "")), options: [ALLOW, DENY] }],
        resultFor: ([answer]) => ({ action: answer && "value" in answer && answer.value === ALLOW ? "accept" : "decline", content: {}, _meta: null }),
      };
    }
    default:
      return undefined;
  }
}

/** What a permission profile grants, one line per kind, as the card reads it. */
export function permissionLines(permissions: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const network = permissions.network as { enabled?: unknown } | undefined;
  if (network?.enabled === true) lines.push("Network access");
  const files = permissions.fileSystem as { read?: unknown; write?: unknown; entries?: unknown } | undefined;
  const paths = (value: unknown) => Array.isArray(value) ? value.filter((path): path is string => typeof path === "string") : [];
  if (paths(files?.read).length) lines.push(`Read: ${paths(files?.read).join(", ")}`);
  if (paths(files?.write).length) lines.push(`Write: ${paths(files?.write).join(", ")}`);
  const entries = Array.isArray(files?.entries) ? files.entries.length : 0;
  if (entries > 0 && !paths(files?.read).length && !paths(files?.write).length) lines.push(`File system: ${entries} ${entries === 1 ? "entry" : "entries"}`);
  const known = new Set(["network", "fileSystem"]);
  for (const [kind, value] of Object.entries(permissions)) {
    if (!known.has(kind)) lines.push(`${kind}: ${clip(JSON.stringify(value))}`);
  }
  return lines;
}

/** Form modes Codex spells differently; the URL and user-verification modes are not forms. */
const FORM_MODES = new Set(["form", "openai/form", "openaiForm"]);

/** An elicitation Tau can ask as a form, or undefined. */
export function elicitationForm(params: Record<string, unknown>): { source: string; message: string; fields: ElicitationField[] } | undefined {
  if (!FORM_MODES.has(String(params.mode))) return undefined;
  const fields = elicitationFields(params.requestedSchema ?? { properties: {} });
  return fields ? { source: String(params.serverName ?? "MCP server"), message: clip(String(params.message ?? "")), fields } : undefined;
}

/** Tags each field's dialog so Questionnaire Kit pages through the form; one field needs no pager. */
export function pageElicitation(source: string) {
  return (prompt: BackendPrompt, index: number, fields: readonly ElicitationField[]): void => {
    if (fields.length < 2) return;
    tagQuestionnaire(prompt, index, fields.map((field) => ({
      question: elicitationFieldTitle(field),
      header: source,
      multiSelect: field.kind === "choices",
      options: field.kind === "boolean" ? [{ label: "Yes", description: "" }, { label: "No", description: "" }] : (field.options ?? []).map((option) => ({ label: option.label, description: "" })),
    })));
  };
}

export function elicitationResult(outcome: ElicitationOutcome): unknown {
  return outcome.action === "accept" ? { action: "accept", content: outcome.content, _meta: null } : { action: outcome.action, content: null, _meta: null };
}

/** What Codex gets back for a request no dialog answers. */
export function refusal(method: string): unknown {
  if (method === "mcpServer/elicitation/request") return { action: "decline", content: null, _meta: null };
  if (method === "item/tool/requestUserInput") return { answers: {} };
  return undefined;
}
