import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Test fixtures in Pi's session layout; only the kit's tests import this. */
export const DAY = 24 * 60 * 60 * 1000;

export interface FixtureResponse {
  id: string;
  at: number;
  provider?: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cost?: number;
}

export function assistantLine(response: FixtureResponse): string {
  const input = response.input ?? 100;
  const output = response.output ?? 10;
  const cacheRead = response.cacheRead ?? 0;
  return JSON.stringify({
    type: "message",
    id: response.id,
    parentId: null,
    timestamp: new Date(response.at).toISOString(),
    message: {
      role: "assistant",
      provider: response.provider ?? "anthropic",
      model: response.model ?? "claude-haiku-4-5",
      content: [{ type: "text", text: "ok" }],
      usage: { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { total: response.cost ?? 0.01 } },
      timestamp: response.at,
    },
  });
}

export function headerLine(id: string, cwd: string, createdAt: number): string {
  return JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(createdAt).toISOString(), cwd });
}

/** Writes `<sessionsDir>/<encoded cwd>/<id>.jsonl` and answers its path. */
export async function writeSession(sessionsDir: string, options: { id: string; cwd: string; createdAt: number; lines: string[] }): Promise<string> {
  const directory = join(sessionsDir, `--${options.cwd.replace(/[\\/]/gu, "-")}--`);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${options.id}.jsonl`);
  await writeFile(path, `${[headerLine(options.id, options.cwd, options.createdAt), ...options.lines].join("\n")}\n`);
  return path;
}

/** A Codex rollout line: `{ timestamp, type, payload }`. */
export function codexLine(type: string, at: number, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload });
}

export function codexMeta(id: string, cwd: string, at: number, extra: Record<string, unknown> = {}): string {
  return codexLine("session_meta", at, { id, cwd, originator: "codex_cli_rs", ...extra });
}

/** An older CLI's `token_count` event: the step and the running total. */
export function codexTokenCount(at: number, last: { input: number; cached?: number; output: number }, total: { input: number; cached?: number; output: number }): string {
  const usage = (value: typeof last) => ({ input_tokens: value.input, cached_input_tokens: value.cached ?? 0, output_tokens: value.output, reasoning_output_tokens: 0, total_tokens: value.input + value.output });
  return codexLine("event_msg", at, { type: "token_count", info: { last_token_usage: usage(last), total_token_usage: usage(total) } });
}

/** A current CLI's record of one response. */
export function codexResponse(at: number, responseId: string, usage: { input: number; cached?: number; output: number }): string {
  return codexLine("token_usage_record", at, { response_id: responseId, usage: { input_tokens: usage.input, cached_input_tokens: usage.cached ?? 0, output_tokens: usage.output, total_tokens: usage.input + usage.output } });
}

/** An assistant line of the Agent SDK CLI's session files. */
export function claudeLine(options: { sessionId: string; cwd: string; at: number; messageId: string; requestId: string; model?: string; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    cwd: options.cwd,
    sessionId: options.sessionId,
    message: {
      id: options.messageId,
      type: "message",
      role: "assistant",
      model: options.model ?? "claude-haiku-4-5-20251001",
      content: [{ type: "text", text: "a reply that must never be kept" }],
      usage: { input_tokens: options.input ?? 10, output_tokens: options.output ?? 5, cache_read_input_tokens: options.cacheRead ?? 0, cache_creation_input_tokens: options.cacheWrite ?? 0 },
    },
    requestId: options.requestId,
    type: "assistant",
    timestamp: new Date(options.at).toISOString(),
  });
}
