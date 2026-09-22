import type { ExtensionFactory, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { AccessLevel } from "./protocol.js";

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

/** Short human-readable description of what a tool is about to do. */
export function approvalSummary(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash" || toolName === "powershell") return String(input.command ?? "shell command");
  const path = input.path;
  if (typeof path === "string") return path;
  return Object.keys(input).join(" · ") || toolName;
}

export interface AccessControl {
  /** The level for one thread; `sessionId` is absent where the runtime did not name one. */
  level(sessionId?: string): AccessLevel;
  onBlocked(toolName: string, reason: string): void;
}

/**
 * Pi has no permission model of its own; every tool it is asked to run, runs.
 * This extension turns the access level into a gate on the `tool_call` hook, the
 * one hook allowed to block. Approvals are ordinary `ctx.ui.confirm` questions,
 * so whatever renders Pi's dialogs renders them; stopping the run cancels them.
 */
export function createAccessExtension(control: AccessControl): (pi: Parameters<ExtensionFactory>[0], session?: { sessionId: string }) => void {
  return (pi, session) => {
    pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => {
      const level = control.level(session?.sessionId);
      if (level === "full") return undefined;
      const input = event.input as Record<string, unknown>;
      if (!isMutatingToolCall(event.toolName, input)) return undefined;

      if (level === "read-only") {
        const reason = `Blocked by Tau: this thread is read-only, so ${event.toolName} cannot run.`;
        control.onBlocked(event.toolName, reason);
        return { block: true, reason };
      }

      const allowed = await ctx.ui.confirm(
        `Approve ${event.toolName}?`,
        approvalSummary(event.toolName, input),
        { signal: ctx.signal },
      );
      if (allowed) return undefined;

      const reason = `Blocked by Tau: ${event.toolName} was not approved.`;
      control.onBlocked(event.toolName, reason);
      return { block: true, reason };
    });
  };
}
