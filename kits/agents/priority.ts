/** How hard a sub-agent's commands yield to the user's work (`priority` in `~/.tau/agents.json`). */
export type AgentPriority = "low" | "background" | "normal";

export const DEFAULT_AGENT_PRIORITY: AgentPriority = "low";

const PRIORITIES: readonly AgentPriority[] = ["low", "background", "normal"];

/**
 * Shell lines that lower the shell running a sub-agent's command; everything
 * it starts inherits that. They run before the command in the same shell, so
 * they stay silent and never fail it.
 */
export function priorityPrefix(priority: AgentPriority, platform: NodeJS.Platform = process.platform): string | undefined {
  if (priority === "normal") return undefined;
  if (platform === "darwin") {
    // `taskpolicy -c utility -p` has no effect on a running process; only the background band applies that way.
    // Background: lowest CPU band, throttled disk and network, efficiency cores only on Apple silicon.
    return priority === "background"
      ? "{ /usr/sbin/taskpolicy -b -p $$; renice -n 10 -p $$; } >/dev/null 2>&1"
      : "renice -n 10 -p $$ >/dev/null 2>&1";
  }
  if (platform === "linux") {
    return priority === "background"
      ? "{ renice -n 10 -p $$; ionice -c 3 -p $$; } >/dev/null 2>&1"
      : "{ renice -n 10 -p $$; ionice -c 2 -n 7 -p $$; } >/dev/null 2>&1";
  }
  return undefined;
}

/** `priority` when it names a level; else `"lowPriority": false` means normal; else low. */
export function readAgentPriority(value: unknown): AgentPriority {
  const settings = value && typeof value === "object" ? value as { priority?: unknown; lowPriority?: unknown } : {};
  if (PRIORITIES.includes(settings.priority as AgentPriority)) return settings.priority as AgentPriority;
  return settings.lowPriority === false ? "normal" : DEFAULT_AGENT_PRIORITY;
}
