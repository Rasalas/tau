import type { ExtensionFactory, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { AccessLevel } from "../shared/contracts.js";

/** Tools that can change the workspace or run arbitrary commands. */
const MUTATING_TOOLS = new Set(["edit", "write", "bash", "powershell"]);

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
      if (!MUTATING_TOOLS.has(event.toolName)) return undefined;

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
