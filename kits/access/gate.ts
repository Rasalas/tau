import type { ExtensionFactory, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { AccessLevel } from "./protocol.js";

/**
 * Tools that can change the workspace or run arbitrary commands. Agents Kit's
 * apply writes a sub-agent's work into this checkout, so it asks like an edit.
 */
const MUTATING_TOOLS = new Set(["edit", "write", "bash", "powershell", "tau_apply_thread_changes", "tau_background_command"]);

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

/** Names Pi and Tau own; a tool from another source that takes one never gets a read-only pass. */
const RESERVED_READ_TOOLS = new Set(["read", "grep", "find", "ls", "tool_search"]);
const RESERVED_PREFIXES = ["computer_use_", "tau_"];

/** What a tool says about itself, in the meaning of MCP tool annotations. */
export interface ToolHints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/**
 * Where a tool really comes from and what it claims. `tau` is Tau's own surface (host
 * extensions, Pi's core tools); anything else is `foreign` and is judged by its hints.
 */
export interface ToolMetadata {
  origin: "tau" | "foreign";
  annotations?: ToolHints;
}

/** The registered tool as Pi's `getAllTools()` lists it; structural so a test needs no Pi. */
interface RegisteredToolInfo {
  name: string;
  annotations?: ToolHints;
  sourceInfo?: { path?: string; source?: string };
}

/**
 * Whether the registry entry is what it claims: a path no extension file can have
 * (`<inline:…>` is a host-contributed runtime extension, `builtin:<name>` a Pi core tool).
 */
function isTauOwned(tool: RegisteredToolInfo): boolean {
  const { path, source } = tool.sourceInfo ?? {};
  if (source === "inline") return typeof path === "string" && path.startsWith("<inline:");
  if (source !== "builtin") return false;
  return path === `builtin:${tool.name}` || (tool.name === "tool_search" && path === "builtin:tool-search");
}

/**
 * Reads a tool's origin and hints off the live registry. `undefined` when the
 * runtime offers no registry or no such tool is registered: the name policy alone
 * applies then, and a call to a tool that does not exist runs nothing anyway.
 */
export function toolMetadataOf(
  getAllTools: (() => readonly RegisteredToolInfo[]) | undefined,
  toolName: string,
): ToolMetadata | undefined {
  if (typeof getAllTools !== "function") return undefined;
  let tools: readonly RegisteredToolInfo[];
  try { tools = getAllTools(); } catch { return { origin: "foreign" }; }
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) return undefined;
  return { origin: isTauOwned(tool) ? "tau" : "foreign", ...(tool.annotations ? { annotations: tool.annotations } : {}) };
}

function mutatesByName(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === "tau_background_tasks") return input.action === "stop";
  if (MUTATING_TOOLS.has(toolName)) return true;
  if (!toolName.startsWith("computer_use_")) return false;

  const operation = toolName.slice("computer_use_".length);
  if (READ_ONLY_COMPUTER_USE_TOOLS.has(operation)) return false;
  if (operation === "check_permissions") return input.prompt !== false;
  if (operation === "page") return input.action !== "get_text" && input.action !== "query_dom";
  if (operation === "browser_dialog") return input.action !== "inspect";
  return true;
}

/**
 * The one classification behind every gate. Tau's own tools keep the name policy; a
 * tool from elsewhere runs unasked only when its own hint says read-only and it takes
 * no name Tau or Pi owns. A hint that says "mutates" is believed from anyone.
 */
export function isMutatingToolCall(
  toolName: string,
  input: Record<string, unknown>,
  metadata: ToolMetadata = { origin: "tau" },
): boolean {
  if (mutatesByName(toolName, input)) return true;
  const hints = metadata.annotations;
  if (hints?.destructiveHint === true || hints?.readOnlyHint === false) return true;
  if (metadata.origin === "tau") return false;
  if (RESERVED_READ_TOOLS.has(toolName) || RESERVED_PREFIXES.some((prefix) => toolName.startsWith(prefix))) return true;
  return hints?.readOnlyHint !== true;
}

/** Short human-readable description of what a tool is about to do. */
export function approvalSummary(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash" || toolName === "powershell") return String(input.command ?? "shell command");
  if (toolName === "tau_apply_thread_changes") return `${input.discard === true ? "Discard" : "Apply"} the changes of thread ${String(input.threadId ?? "?")}`;
  const path = input.path;
  if (typeof path === "string") return path;
  return Object.keys(input).join(" · ") || toolName;
}

/** The approval card's head, as the workbench design words it: "Wants to edit", "Wants to run". */
export function approvalTitle(toolName: string): string {
  if (toolName === "edit" || toolName === "write") return "Wants to edit";
  if (toolName === "bash" || toolName === "powershell") return "Wants to run";
  if (toolName === "tau_apply_thread_changes") return "Wants to apply an agent's work";
  return toolName.startsWith("computer_use_") ? "Wants to use the computer" : `Wants to use ${toolName}`;
}

export interface AccessControl {
  /** The level for one thread; `sessionId` is absent where the runtime did not name one. */
  level(sessionId?: string): AccessLevel;
  onBlocked(toolName: string, reason: string): void;
}

/**
 * The one decision behind both doors — Pi's `tool_call` hook and the host's
 * MCP gate — so a tool is gated the same whichever runtime calls it.
 */
export async function gateToolCall(
  level: AccessLevel,
  toolName: string,
  input: Record<string, unknown>,
  confirm: (title: string, message: string) => Promise<boolean>,
  onBlocked: AccessControl["onBlocked"],
  metadata?: ToolMetadata,
): Promise<{ block: true; reason: string } | undefined> {
  if (level === "full" || !isMutatingToolCall(toolName, input, metadata)) return undefined;
  // Tau has no reviewer of its own: at `auto` it asks, as at `ask`.
  if (level === "read-only") {
    const reason = `Blocked by Tau: this thread is read-only, so ${toolName} cannot run.`;
    onBlocked(toolName, reason);
    return { block: true, reason };
  }
  if (await confirm(approvalTitle(toolName), approvalSummary(toolName, input))) return undefined;
  const reason = `Blocked by Tau: ${toolName} was not approved.`;
  onBlocked(toolName, reason);
  return { block: true, reason };
}

/**
 * Pi has no permission model of its own; every tool it is asked to run, runs.
 * This extension turns the access level into a gate on the `tool_call` hook, the
 * one hook allowed to block. Approvals are ordinary `ctx.ui.confirm` questions,
 * so whatever renders Pi's dialogs renders them; stopping the run cancels them.
 */
export function createAccessExtension(control: AccessControl): (pi: Parameters<ExtensionFactory>[0], session?: { sessionId: string }) => void {
  return (pi, session) => {
    pi.on("tool_call", (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => {
      const level = control.level(session?.sessionId);
      return gateToolCall(
        level,
        event.toolName,
        event.input as Record<string, unknown>,
        (title, message) => ctx.ui.confirm(title, message, { signal: ctx.signal }),
        control.onBlocked,
        level === "full" ? undefined : toolMetadataOf(pi.getAllTools?.bind(pi), event.toolName),
      );
    });
  };
}
