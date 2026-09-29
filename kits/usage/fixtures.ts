import { createWriteStream } from "node:fs";
import { once } from "node:events";
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

/** What `writeLargeOutsideFixture` wrote: its roots and what a reader must count. */
export interface LargeOutsideFixture {
  roots: Array<{ format: "codex" | "agent-sdk" | "opencode"; backend: string; label: string; path: string }>;
  /** Responses and tokens, each counted once (copies and oversized lines excluded). */
  requests: number;
  totalTokens: number;
  bytes: number;
}

/**
 * Agent CLI logs at scale: many rollouts and project files with conversation
 * text between the usage lines, a few huge files with oversized lines,
 * resumed copies that repeat responses, and an OpenCode database with large
 * rows. `scale` 1 is about 250 MB and 350,000 responses; every response lies
 * within `days` days before `now`.
 */
export async function writeLargeOutsideFixture(root: string, options: { now: number; scale?: number; days?: number }): Promise<LargeOutsideFixture> {
  const scale = options.scale ?? 1;
  const span = (options.days ?? 80) * DAY;
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const filler = (bytes: number) => "conversation text ".repeat(Math.ceil(bytes / 18)).slice(0, bytes);
  let requests = 0;
  let totalTokens = 0;
  let bytes = 0;
  const writeLines = async (path: string, lines: Iterable<string>) => {
    await mkdir(join(path, ".."), { recursive: true });
    const out = createWriteStream(path);
    for (const line of lines) {
      bytes += line.length + 1;
      if (!out.write(`${line}\n`)) await once(out, "drain");
    }
    out.end();
    await once(out, "close");
  };

  // Codex: rollouts with a response item of text before each counter, older CLIs only.
  const codexHome = join(root, "codex-home");
  const codexFiles = Math.round(400 * scale);
  for (let file = 0; file < codexFiles; file += 1) {
    const huge = file < 2;
    const steps = huge ? Math.round(8_000 * scale) : 400;
    const start = options.now - span + Math.floor(random() * (span - DAY));
    const id = `codex-${file}`;
    await writeLines(join(codexHome, "sessions", `rollout-${file}.jsonl`), (function* () {
      yield codexMeta(id, `/work/codex-${file % 7}`, start);
      yield codexLine("turn_context", start, { model: "gpt-5.6-luna" });
      let running = { input: 0, cached: 0, output: 0 };
      for (let step = 0; step < steps; step += 1) {
        const at = start + (step + 1) * 5_000;
        // A few oversized lines, which are dropped unread.
        yield codexLine("response_item", at, { type: "message", content: filler(huge && step % 2_000 === 0 ? 9 * 1024 * 1024 : 400) });
        const last = { input: 1_000 + Math.floor(random() * 5_000), cached: 0, output: 50 + Math.floor(random() * 400) };
        running = { input: running.input + last.input, cached: 0, output: running.output + last.output };
        requests += 1;
        totalTokens += last.input + last.output;
        yield codexTokenCount(at, last, running);
      }
    })());
  }

  // Claude Code: project files, and resumed sessions that repeat an earlier file's responses first.
  const claudeHome = join(root, "claude-home");
  const claudeFiles = Math.round(300 * scale);
  for (let file = 0; file < claudeFiles; file += 1) {
    const steps = 500;
    const start = options.now - span + Math.floor(random() * (span - DAY));
    const sessionId = `claude-${file}`;
    const cwd = `/work/claude-${file % 5}`;
    const response = (step: number, at: number, of: string) => claudeLine({ sessionId: of, cwd, at, messageId: `m-${file}-${step}`, requestId: `r-${file}-${step}`, input: 3, output: 100 + (step % 50), cacheRead: 2_000 });
    await writeLines(join(claudeHome, "projects", `-work-${file % 5}`, `${sessionId}.jsonl`), (function* () {
      for (let step = 0; step < steps; step += 1) {
        const at = start + step * 10_000;
        yield JSON.stringify({ type: "user", sessionId, message: { role: "user", content: filler(300) } });
        requests += 1;
        totalTokens += 3 + 100 + (step % 50) + 2_000;
        yield response(step, at, sessionId);
      }
    })());
    if (file % 6 !== 0) continue;
    // A resume: the earlier responses again, then new ones.
    await writeLines(join(claudeHome, "projects", `-work-${file % 5}`, `${sessionId}-resumed.jsonl`), (function* () {
      for (let step = 0; step < steps; step += 1) yield response(step, start + step * 10_000, `${sessionId}-resumed`);
      for (let step = steps; step < steps + 50; step += 1) {
        requests += 1;
        totalTokens += 3 + 100 + (step % 50) + 2_000;
        yield response(step, start + step * 10_000, `${sessionId}-resumed`);
      }
    })());
  }

  // OpenCode: one database, sessions one after another, message rows with their metadata and a few oversized rows.
  const openCodeHome = join(root, "opencode-data");
  await mkdir(openCodeHome, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(openCodeHome, "opencode.db"));
  db.exec("CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, parent_id text)");
  db.exec("CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)");
  const messages = Math.round(60_000 * scale);
  const insertSession = db.prepare("INSERT INTO session VALUES (?, ?, NULL)");
  const insert = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  const perSession = 300;
  for (let session = 0; session < Math.ceil(messages / perSession); session += 1) insertSession.run(`oc-${session}`, `/work/opencode-${session % 3}`);
  for (let index = 0; index < messages; index += 1) {
    const at = options.now - span + Math.floor((index / messages) * (span - DAY));
    const oversized = index % 20_000 === 19_999;
    const input = 500 + (index % 300);
    const data = JSON.stringify({ id: `oc-m-${index}`, role: "assistant", providerID: "anthropic", modelID: "claude-haiku-4-5", cost: 0.001, tokens: { input, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: at }, summary: filler(oversized ? 2_100_000 : 1_000) });
    bytes += data.length;
    if (!oversized) { requests += 1; totalTokens += input + 20; }
    insert.run(`oc-m-${String(index).padStart(8, "0")}`, `oc-${Math.floor(index / perSession)}`, at, at, data);
  }
  db.exec("COMMIT");
  db.close();

  return {
    roots: [
      { format: "codex", backend: "codex", label: "Codex", path: join(codexHome, "sessions") },
      { format: "agent-sdk", backend: "claude-code", label: "Claude Code", path: join(claudeHome, "projects") },
      { format: "opencode", backend: "opencode", label: "OpenCode", path: openCodeHome },
    ],
    requests,
    totalTokens,
    bytes,
  };
}

/**
 * Pi's session store at scale: files with tool output between the responses,
 * and forks that copy their parent's entries first. `scale` 1 is about 60 MB
 * and 120,000 responses.
 */
export async function writeLargePiFixture(sessionsDir: string, options: { now: number; scale?: number; days?: number }): Promise<{ requests: number; totalTokens: number }> {
  const scale = options.scale ?? 1;
  const span = (options.days ?? 80) * DAY;
  let requests = 0;
  let totalTokens = 0;
  const files = Math.round(400 * scale);
  for (let file = 0; file < files; file += 1) {
    const start = options.now - span + Math.floor((file / files) * (span - DAY));
    const stamp = new Date(start).toISOString().replace(/[:.]/gu, "-");
    const lines: string[] = [];
    for (let step = 0; step < 300; step += 1) {
      const at = start + step * 20_000;
      lines.push(JSON.stringify({ type: "message", id: `t${file}-${step}`, timestamp: new Date(at).toISOString(), message: { role: "toolResult", content: [{ type: "text", text: "tool output ".repeat(12) }] } }));
      lines.push(assistantLine({ id: `a${file}-${step}`, at, input: 2_000, output: 100 }));
      requests += 1;
      totalTokens += 2_100;
    }
    await writeSession(sessionsDir, { id: `${stamp}_s${file}`, cwd: `/work/pi-${file % 4}`, createdAt: start, lines });
    if (file % 8 !== 0) continue;
    // A fork, later: its parent's entries again, then its own.
    const forkAt = start + 7_000_000;
    const own = Array.from({ length: 20 }, (_, step) => {
      requests += 1;
      totalTokens += 2_100;
      return assistantLine({ id: `f${file}-${step}`, at: forkAt + step * 20_000, input: 2_000, output: 100 });
    });
    await writeSession(sessionsDir, { id: `${new Date(forkAt).toISOString().replace(/[:.]/gu, "-")}_f${file}`, cwd: `/work/pi-${file % 4}`, createdAt: forkAt, lines: [...lines, ...own] });
  }
  return { requests, totalTokens };
}
