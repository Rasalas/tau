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
