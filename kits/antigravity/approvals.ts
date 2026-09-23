import type { BackendPrompt, ExtensionUiAnswer, RuntimePermissionLevel } from "tau/host-extension";
import { answerElicitation as answerAcpElicitation, permissionDialog as acpPermissionDialog, type PermissionDialog } from "../_acp/approvals.js";
import type { AcpElicitationAnswer, AcpElicitationRequest, AcpPermissionRequest, AcpSelectOption } from "../_acp/session.js";

export { ALLOW, ALLOW_THREAD, DENY, type PermissionDialog } from "../_acp/approvals.js";

/** Antigravity's approvals and native questions share `session/request_permission`; see `kits/_acp/approvals.ts`. */
const SECURITY_WARNING_META_KEY = "agy.security.warning";

export function isQuestion(request: AcpPermissionRequest): boolean {
  return request.toolCall.toolCallId.startsWith("interaction_");
}

function securityWarning(request: AcpPermissionRequest): string | undefined {
  const always = request.options.find((option) => option.kind === "allow_always");
  const warning = always?.["_meta"]?.[SECURITY_WARNING_META_KEY];
  if (!warning || typeof warning !== "object") return undefined;
  const { message, title } = warning as { message?: unknown; title?: unknown };
  return typeof message === "string" && message.trim() ? message : typeof title === "string" ? title : undefined;
}

export function permissionDialog(request: AcpPermissionRequest): PermissionDialog | undefined {
  return acpPermissionDialog(request, { agent: "Antigravity", isQuestion, warning: securityWarning });
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

export function answerElicitation(request: AcpElicitationRequest, ask: ((prompt: BackendPrompt) => Promise<ExtensionUiAnswer>) | undefined): Promise<AcpElicitationAnswer> {
  return answerAcpElicitation(request, ask, "Antigravity");
}
