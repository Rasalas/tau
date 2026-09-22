import type { BackendPrompt, ExtensionUiAnswer, RuntimePermissionLevel } from "tau/host-extension";
import type { CodexPolicy } from "./app-server.js";
import { displayCommand } from "./events.js";

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
 */
export function policyForLevel(level: RuntimePermissionLevel): CodexPolicy {
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

/** One dialog per question; a question without choices is free text. */
function questions(list: readonly Question[]): ApprovalDialog {
  return {
    prompts: list.map((question): BackendPrompt => question.options?.length
      ? { kind: "select", title: clip(question.question || question.header || "Codex asks"), options: question.options.map((option) => option.label) }
      : { kind: "input", title: clip(question.question || question.header || "Codex asks") }),
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
      return approval("Codex asks for more permissions", [reason, JSON.stringify(granted)].filter(Boolean).join("\n"), V2_WORDS, (word) => word === "accept" || word === "acceptForSession"
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
      // Only a plain yes/no is answerable here; a form with fields is declined.
      const schema = (params.requestedSchema ?? {}) as { properties?: Record<string, unknown> };
      if (params.mode !== "form" || Object.keys(schema.properties ?? {}).length > 0) return undefined;
      return {
        prompts: [{ kind: "select", title: `${String(params.serverName ?? "An MCP server")} asks`, message: clip(String(params.message ?? "")), options: [ALLOW, DENY] }],
        resultFor: ([answer]) => ({ action: answer && "value" in answer && answer.value === ALLOW ? "accept" : "decline", content: {}, _meta: null }),
      };
    }
    default:
      return undefined;
  }
}

/** What Codex gets back for a request no dialog answers. */
export function refusal(method: string): unknown {
  if (method === "mcpServer/elicitation/request") return { action: "decline", content: null, _meta: null };
  if (method === "item/tool/requestUserInput") return { answers: {} };
  return undefined;
}
