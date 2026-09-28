/** Pi's `short` retention: Anthropic's default ephemeral cache. */
const SHORT_TTL_MS = 5 * 60_000;
/** `PI_CACHE_RETENTION=long`: the one-hour cache. */
const LONG_TTL_MS = 60 * 60_000;

const CACHED_APIS = new Set(["anthropic-messages", "bedrock-converse-stream"]);

/**
 * How long Pi's provider keeps a thread's context cached, for a Claude model
 * only: Pi marks cache breakpoints there, and a cold cache is written anew at
 * a premium. Undefined for every other model.
 */
export function piPromptCacheTtlMs(
  model: { api?: string; id?: string } | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number | undefined {
  if (!model?.api || !CACHED_APIS.has(model.api) || !/claude/iu.test(model.id ?? "")) return undefined;
  return env.PI_CACHE_RETENTION === "long" ? LONG_TTL_MS : SHORT_TTL_MS;
}

/** When the last reply of a Pi transcript was written, in ms since the epoch. */
export function lastReplyAt(messages: readonly unknown[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; timestamp?: unknown } | undefined;
    if (message?.role !== "assistant") continue;
    return typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : undefined;
  }
  return undefined;
}
