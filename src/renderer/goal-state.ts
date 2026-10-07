import type { UiThreadGoal } from "../shared/contracts";

/**
 * The active thread's goal, for the palette's goal commands: a command's
 * `unavailable()` takes no arguments, so the workbench publishes what it shows.
 */
let shown: { sessionId: string; goal: UiThreadGoal | undefined; supported: boolean } | undefined;

export function showGoal(sessionId: string | undefined, goal: UiThreadGoal | undefined, supported: boolean): void {
  shown = sessionId ? { sessionId, goal, supported } : undefined;
}

export function shownGoal(): { goal: UiThreadGoal | undefined; supported: boolean } | undefined {
  return shown;
}

/** The goal can start its next turn again. */
export function goalResumable(goal: UiThreadGoal | undefined): boolean {
  if (!goal || !goal.actions.resume) return false;
  return goal.status === "paused" || goal.status === "blocked" || goal.status === "usage-limited" || goal.status === "unconfirmed";
}

/** Why a goal command cannot run on the thread on screen. */
export function goalCommandRefusal(command: "pause" | "resume" | "end"): string | undefined {
  const current = shownGoal();
  if (!current?.supported) return "This thread's runtime keeps no goals.";
  const goal = current.goal;
  if (!goal) return "This thread has no goal.";
  if (command === "pause") return goal.status !== "active" ? "The goal is not running." : goal.actions.pause ? undefined : "This runtime cannot pause a goal.";
  if (command === "resume") return goalResumable(goal) ? undefined : "The goal cannot be resumed now.";
  return undefined;
}
