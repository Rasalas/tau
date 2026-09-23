import type { UiMessage } from "tau";

/**
 * Plan Kit's contract between its halves. The mode itself is core's
 * (`snapshot.mode`, `actions.setMode`); what `plan` means, the card and the
 * way back to building are this kit's.
 */
export const PLAN_HOST_EXTENSION_ID = "tau.plan";

export const PLAN_MODE = "plan";
export const DEFAULT_MODE = "default";

/** The block a plan-mode reply wraps its plan in, on lines of their own. */
export const PLAN_TAG = "proposed_plan";

/** What the thread is sent when the user approves a plan. */
export const IMPLEMENTATION_PREFIX = "PLEASE IMPLEMENT THIS PLAN:\n";

export function implementationPrompt(plan: string): string {
  return `${IMPLEMENTATION_PREFIX}${plan.trim()}`;
}

/** The plan's first heading, if it has one. */
export function planTitle(plan: string): string | undefined {
  return /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/mu.exec(plan)?.[1]?.trim() || undefined;
}

/** The plan without the heading its title came from. */
export function planBody(plan: string): string {
  const lines = plan.trim().split(/\r?\n/u);
  if (lines[0] && /^\s{0,3}#{1,6}\s+/u.test(lines[0])) lines.shift();
  while (lines[0]?.trim() === "") lines.shift();
  return lines.join("\n");
}

const PLAN_BLOCK = new RegExp(`(?:^|\\n)[ \\t]*<${PLAN_TAG}>[ \\t]*\\n([\\s\\S]*?)\\n[ \\t]*</${PLAN_TAG}>[ \\t]*(?=\\n|$)`, "gu");

/** The last complete plan block of a reply. */
export function planOf(text: string): string | undefined {
  let found: string | undefined;
  for (const match of text.matchAll(PLAN_BLOCK)) found = match[1]!.trim();
  return found || undefined;
}

/**
 * The plan the thread is waiting on: one in the reply to the last prompt,
 * the way T3 Code offers it only for the turn that just settled.
 */
export function pendingPlan(messages: readonly UiMessage[]): { plan: string; messageId: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") return undefined;
    if (message.role !== "assistant") continue;
    const plan = planOf(message.text);
    if (plan) return { plan, messageId: message.id };
  }
  return undefined;
}

/** Writing tools a Pi thread may not call while it plans. */
export const PLAN_BLOCKED_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "tau_apply_thread_changes"]);

export const PLAN_MODE_INSTRUCTIONS = `# Plan mode

This thread is in plan mode until the user switches it back. Plan mode is for understanding the task and agreeing on a plan, not for doing the work.

- Explore with actions that change nothing: read and search files, inspect configuration, run commands that only read. Tools that write files are blocked.
- Do not edit or create files, apply patches, run formatters that rewrite files, or run a command whose purpose is to carry out the plan. If the user asks you to go ahead, answer with the plan for doing it.
- Learn what the code can tell you before you ask. Ask the user only about goals, trade-offs and preferences, with concrete options and the one you recommend.
- Once the plan leaves the implementer no decision to make, present it in a proposed_plan block, with each tag on a line of its own:

<${PLAN_TAG}>
# A short title

The approach, the files and interfaces that change, edge cases, and how to verify the result, in Markdown.
</${PLAN_TAG}>

A revised plan is a complete new block, never a patch of the old one.`;
