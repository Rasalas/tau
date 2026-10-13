import type { UiBackgroundTask } from "./contracts.js";

/**
 * Whether the work holds the thread's run open, so it is not announced as done.
 * Unknown work holds it open. A checked service may explicitly be released.
 */
export function backgroundHoldsRun(tasks: readonly UiBackgroundTask[] | undefined): boolean {
  return Boolean(tasks?.some((task) => task.blocksCompletion !== false));
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

/** Monitoring for an open watch, Waiting for required work or results, Running for released services. */
export function backgroundSummary(tasks: readonly UiBackgroundTask[]): { label: string; hint: string } {
  const label = tasks.some((task) => task.kind === "monitor" && task.blocksCompletion !== false && !task.state) ? "Monitoring" : backgroundHoldsRun(tasks) ? "Waiting" : "Running";
  const names = tasks.map((task) => task.label).join(", ");
  const after = tasks.some((task) => task.state === "reported") ? "The agent still needs to handle the result." : backgroundHoldsRun(tasks) ? "The agent continues when it reports." : "These services do not hold the request open.";
  return { label, hint: `${backgroundCount(tasks)} in the background: ${names}. ${after}` };
}
