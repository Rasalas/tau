import type { ExtensionFactory, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { AccessLevel } from "../shared/contracts.js";

/** Tools that can change the workspace or run arbitrary commands. */
const MUTATING_TOOLS = new Set(["edit", "write", "bash", "powershell"]);

const READ_ONLY_COMPUTER_USE_TOOLS = new Set([
  "list_apps",
  "list_windows",
  "get_window_state",
  "get_screen_size",
  "get_desktop_state",
  "get_cursor_position",
  "get_agent_cursor_state",
  "health_report",
  "get_config",
  "get_accessibility_tree",
  "zoom",
  "get_browser_state",
  "get_recording_state",
  "get_session_state",
  "check_for_update",
  // Session identity is required for scoped reads and owns no target-app action.
  "start_session",
  "end_session",
]);

export function isMutatingToolCall(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (MUTATING_TOOLS.has(toolName)) return true;
  if (!toolName.startsWith("computer_use_")) return false;

  const operation = toolName.slice("computer_use_".length);
  if (READ_ONLY_COMPUTER_USE_TOOLS.has(operation)) return false;
  if (operation === "check_permissions") return input.prompt !== false;
  if (operation === "page") return input.action !== "get_text" && input.action !== "query_dom";
  if (operation === "browser_dialog") return input.action !== "inspect";
  return true;
}

export interface AccessDecision {
  allowed: boolean;
  reason?: string;
}

export interface AccessControl {
  level(): AccessLevel;
  /** Asks the workbench; resolves false if nobody answers. */
  requestApproval(toolCallId: string, toolName: string, input: Record<string, unknown>): Promise<AccessDecision>;
  onBlocked(toolName: string, reason: string): void;
}

/**
 * Pi has no permission model of its own — every tool it is asked to run, runs.
 * This inline extension is what turns Tau's access setting into an actual gate,
 * using the `tool_call` hook, which is allowed to block.
 */
export function createAccessExtension(control: AccessControl): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event: ToolCallEvent): Promise<ToolCallEventResult | undefined> => {
      const level = control.level();
      if (level === "full") return undefined;
      if (!isMutatingToolCall(event.toolName, event.input as Record<string, unknown>)) return undefined;

      if (level === "read-only") {
        const reason = `Blocked by Tau: this thread is read-only, so ${event.toolName} cannot run.`;
        control.onBlocked(event.toolName, reason);
        return { block: true, reason };
      }

      const decision = await control.requestApproval(
        event.toolCallId,
        event.toolName,
        event.input as Record<string, unknown>,
      );
      if (decision.allowed) return undefined;

      const reason = decision.reason ?? `Blocked by Tau: ${event.toolName} was not approved.`;
      control.onBlocked(event.toolName, reason);
      return { block: true, reason };
    });
  };
}
