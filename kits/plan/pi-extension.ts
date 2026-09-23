import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { threadModeFromEntries } from "tau/host-extension";
import { PLAN_BLOCKED_TOOLS, PLAN_MODE, PLAN_MODE_INSTRUCTIONS } from "./protocol.js";

function planning(ctx: ExtensionContext): boolean {
  return threadModeFromEntries(ctx.sessionManager.getBranch()) === PLAN_MODE;
}

/**
 * Plan mode for Pi, which has none of its own: while the thread's mode is
 * `plan`, every turn's system prompt carries the plan-mode instructions and
 * the writing tools are refused. The mode is read from the thread's journal
 * on each turn, so switching it back takes effect with the next prompt.
 */
export function createPlanModeExtension(): (pi: Parameters<ExtensionFactory>[0]) => void {
  return (pi) => {
    pi.on("before_agent_start", (event, ctx) => planning(ctx)
      ? { systemPrompt: `${event.systemPrompt}\n\n${PLAN_MODE_INSTRUCTIONS}` }
      : undefined);
    pi.on("tool_call", (event, ctx) => PLAN_BLOCKED_TOOLS.has(event.toolName) && planning(ctx)
      ? { block: true, reason: `Blocked by Tau: this thread is in plan mode, so ${event.toolName} cannot run. Propose the change in the plan instead.` }
      : undefined);
  };
}
