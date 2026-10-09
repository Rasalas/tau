import type { UiBackgroundTask } from "./contracts.js";

/**
 * Whether the work holds the thread's run open, so it is not announced as done.
 * A command does not: a dev server would hold it for good.
 */
export function backgroundHoldsRun(tasks: readonly UiBackgroundTask[] | undefined): boolean {
  return Boolean(tasks?.some((task) => task.kind !== "command"));
}

const NOUNS: Record<UiBackgroundTask["kind"], [string, string]> = {
  monitor: ["monitor", "monitors"],
  agent: ["sub-agent", "sub-agents"],
  task: ["task", "tasks"],
  command: ["command", "commands"],
};

/** "2 monitors and 1 command", in the order monitors, sub-agents, tasks, commands. */
export function backgroundCount(tasks: readonly UiBackgroundTask[]): string {
  const parts = (Object.keys(NOUNS) as UiBackgroundTask["kind"][]).flatMap((kind) => {
    const count = tasks.filter((task) => task.kind === kind).length;
    return count ? [`${count} ${NOUNS[kind][count === 1 ? 0 : 1]}`] : [];
  });
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] ?? "nothing";
}

/** What a thread's row and pill say: Monitoring for a monitor, Waiting for agents and tasks, Running for commands alone. */
export function backgroundSummary(tasks: readonly UiBackgroundTask[]): { label: string; hint: string } {
  const label = tasks.some((task) => task.kind === "monitor") ? "Monitoring" : backgroundHoldsRun(tasks) ? "Waiting" : "Running";
  const names = tasks.map((task) => task.label).join(", ");
  const after = backgroundHoldsRun(tasks) ? "The agent continues when it reports." : "The agent hears when it ends.";
  return { label, hint: `${backgroundCount(tasks)} in the background: ${names}. ${after}` };
}
