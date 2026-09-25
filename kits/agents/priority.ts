/**
 * Shell lines that move the shell running a sub-agent's command to low
 * priority; everything it starts inherits it. They run before the command in
 * the same shell, so they must stay silent and must not fail it.
 */
export function backgroundPriorityPrefix(platform: NodeJS.Platform = process.platform): string | undefined {
  // Background policy: lowest CPU, throttled disk and network; efficiency cores only on Apple silicon.
  if (platform === "darwin") return "{ /usr/sbin/taskpolicy -b -p $$; renice -n 10 -p $$; } >/dev/null 2>&1";
  if (platform === "linux") return "{ renice -n 10 -p $$; ionice -c 3 -p $$; } >/dev/null 2>&1";
  return undefined;
}

/** Whether sub-agents run at low priority; on unless `~/.tau/agents.json` says `"lowPriority": false`. */
export function readLowPriority(value: unknown): boolean {
  const setting = value && typeof value === "object" ? (value as { lowPriority?: unknown }).lowPriority : undefined;
  return setting !== false;
}
