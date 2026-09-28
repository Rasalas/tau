import { createReadStream } from "node:fs";

/**
 * Usage the agent CLIs wrote into their own logs, read as counts only: a
 * record keeps its time, model and tokens, never a word of the conversation.
 * Codex writes a rollout per session, the Agent SDK's CLI a JSONL file per
 * session under its projects folder; both carry usage on a few kinds of line.
 */

/** One billed model response. */
export interface OutsideRecord {
  /** Unique across copies: a resumed or forked session repeats it. */
  key: string;
  at: number;
  model: string;
  provider?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** What the tool itself priced it at; 0 when it names no price. */
  cost: number;
}

export interface OutsideSession {
  /** The tool's own session id, the one a Tau thread keeps when it runs there. */
  sessionId: string;
  cwd: string;
  /** The session it was forked or spawned from. */
  parentId?: string;
  records: OutsideRecord[];
}

/** Lines longer than this are dropped unread; a usage line is never near it. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function timeOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Hands `consume` each complete line that contains one of `markers`; the
 * rest is never decoded. An unfinished last line belongs to a writer still
 * at work and is read next time. Answers how many oversized lines might have
 * carried usage (`mayCarryUsage` over their first bytes).
 */
export async function readMarkedLines(path: string, markers: readonly string[], consume: (line: string) => void, mayCarryUsage: (head: string) => boolean, maxLineBytes = MAX_LINE_BYTES): Promise<number> {
  const needles = markers.map((marker) => Buffer.from(marker));
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let discarding = false;
  let skipped = 0;
  const offer = (line: Buffer) => { if (needles.some((needle) => line.includes(needle))) consume(line.toString("utf8")); };
  const drop = (piece: Buffer) => {
    const head = (pending.length > 0 ? pending[0]! : piece).subarray(0, 4096).toString("utf8");
    if (mayCarryUsage(head)) skipped += 1;
    pending = [];
    pendingBytes = 0;
  };
  for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 }) as AsyncIterable<Buffer>) {
    let start = 0;
    for (let newline = chunk.indexOf(10, start); newline !== -1; newline = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, newline);
      start = newline + 1;
      if (discarding) { discarding = false; continue; }
      if (pendingBytes + piece.length > maxLineBytes) { drop(piece); continue; }
      offer(pending.length > 0 ? Buffer.concat([...pending, piece]) : piece);
      pending = [];
      pendingBytes = 0;
    }
    if (start >= chunk.length || discarding) continue;
    const rest = chunk.subarray(start);
    if (pendingBytes + rest.length > maxLineBytes) {
      drop(rest);
      discarding = true;
    } else {
      // Copied: the stream may reuse the chunk's memory.
      pending.push(Buffer.from(rest));
      pendingBytes += rest.length;
    }
  }
  return skipped;
}

interface CodexUsage { input_tokens?: unknown; cached_input_tokens?: unknown; cache_write_input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown }

/** Codex counts cached input inside input; Tau keeps the buckets apart, as its Codex kit does. */
function codexTokens(usage: CodexUsage): Pick<OutsideRecord, "input" | "output" | "cacheRead" | "cacheWrite" | "total"> {
  const read = count(usage.cached_input_tokens);
  const write = count(usage.cache_write_input_tokens);
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  return { input: Math.max(0, input - read - write), output, cacheRead: read, cacheWrite: write, total: count(usage.total_tokens) || input + output };
}

function codexDelta(total: CodexUsage, previous: CodexUsage): CodexUsage | undefined {
  const fields = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "total_tokens"] as const;
  const delta: Record<string, number> = {};
  for (const field of fields) {
    const value = count(total[field]) - count(previous[field]);
    if (value < 0) return undefined;
    delta[field] = value;
  }
  return delta;
}

export const CODEX_MARKERS = ["\"token_count\"", "\"token_usage_record\"", "\"turn_context\"", "\"session_meta\""];

/** An oversized rollout line is almost always a response item or a compaction. */
export function codexMayCarryUsage(head: string): boolean {
  return !/^\s*\{\s*(?:"timestamp"\s*:\s*"[^"\\]*"\s*,\s*)?"type"\s*:\s*"(?:response_item|compacted)"/u.test(head);
}

/**
 * One rollout's responses. A current CLI writes a `token_usage_record` per
 * response; before that only `token_count` events, whose `total_token_usage`
 * runs on over the session and which repeat themselves, so each counts the
 * step from the one before. A fork or a sub-agent replays its parent's
 * events in one burst at its start; those were counted in the parent.
 */
export class CodexRolloutParser {
  private sessionId?: string;
  private cwd = "";
  private parentId?: string;
  private model = "unknown model";
  private forkAnchor?: number;
  private cumulative?: CodexUsage;
  private signature = "";
  private modernSince?: number;
  private readonly legacy: OutsideRecord[] = [];
  private readonly modern: OutsideRecord[] = [];
  skipped = 0;

  constructor(private readonly fallbackId: string) {}

  line(line: string): void {
    let record: Record<string, unknown> | undefined;
    try { record = object(JSON.parse(line)); } catch { this.skipped += 1; return; }
    const payload = object(record?.payload);
    const type = record?.type;
    if (!payload || typeof type !== "string") return;
    if (type === "session_meta") {
      if (this.sessionId) return;
      this.sessionId = text(payload.id) ?? text(payload.session_id) ?? this.fallbackId;
      this.cwd = text(payload.cwd) ?? "";
      const spawn = object(object(object(payload.source)?.subagent)?.thread_spawn);
      this.parentId = text(payload.forked_from_id) ?? text(spawn?.parent_thread_id);
      if (payload.forked_from_id !== undefined || object(payload.source)?.subagent !== undefined) this.forkAnchor = timeOf(record!.timestamp);
      return;
    }
    if (type === "turn_context") { this.model = text(payload.model) ?? this.model; return; }
    const at = timeOf(record!.timestamp);
    if (at === undefined) return;
    if (type === "token_usage_record") {
      const usage = object(payload.usage);
      const id = text(payload.response_id);
      if (!usage || !id) return;
      const tokens = codexTokens(usage);
      if (tokens.total <= 0) return;
      this.modernSince = Math.min(this.modernSince ?? at, at);
      this.modern.push({ key: `codex:${id}`, at, model: this.model, provider: "openai", ...tokens, cost: 0 });
      return;
    }
    if (type !== "event_msg" || payload.type !== "token_count") return;
    const info = object(payload.info);
    const last = object(info?.last_token_usage) as CodexUsage | undefined;
    if (!last) return;
    const total = object(info?.total_token_usage) as CodexUsage | undefined;
    const signature = `${count(total?.total_tokens)}|${count(last.input_tokens) + count(last.output_tokens)}|${count(last.cached_input_tokens)}`;
    const repeated = signature === this.signature;
    this.signature = signature;
    const previous = this.cumulative;
    if (total) this.cumulative = total;
    if (this.forkAnchor !== undefined) {
      if (at - this.forkAnchor < 1000) { this.forkAnchor = at; return; }
      this.forkAnchor = undefined;
    }
    if (repeated) return;
    const step = total && previous ? codexDelta(total, previous) : undefined;
    const tokens = codexTokens(step ?? last);
    if (tokens.total <= 0) return;
    this.legacy.push({ key: `codex:${this.sessionId ?? this.fallbackId}@${at}|${signature}`, at, model: this.model, provider: "openai", ...tokens, cost: 0 });
  }

  finish(): OutsideSession {
    const since = this.modernSince;
    // Where a file has both, the response records replace the older counters.
    const records = [...this.modern, ...this.legacy.filter((record) => since === undefined || record.at < since)];
    return { sessionId: this.sessionId ?? this.fallbackId, cwd: this.cwd, ...(this.parentId ? { parentId: this.parentId } : {}), records };
  }
}

export const CLAUDE_MARKERS = ["\"usage\""];

export function claudeMayCarryUsage(head: string): boolean {
  return head.includes("\"role\":\"assistant\"");
}

/**
 * One session file of the Agent SDK's CLI. Every assistant line carries its
 * response's usage, and a response of several content blocks is several
 * lines with the same message and request id: it counts once, with the last
 * line's figures. Sub-agent files carry their parent's session id.
 */
export class ClaudeProjectParser {
  private sessionId?: string;
  private cwd = "";
  private readonly records = new Map<string, OutsideRecord>();
  skipped = 0;

  constructor(private readonly fallbackId: string) {}

  line(line: string): void {
    let record: Record<string, unknown> | undefined;
    try { record = object(JSON.parse(line)); } catch { this.skipped += 1; return; }
    if (record?.type !== "assistant") return;
    const message = object(record.message);
    const usage = object(message?.usage);
    const at = timeOf(record.timestamp);
    const id = text(message?.id);
    const request = text(record.requestId);
    if (!message || !usage || at === undefined || (!id && !request)) return;
    this.sessionId ??= text(record.sessionId);
    if (!this.cwd) this.cwd = text(record.cwd) ?? "";
    const model = text(message.model) ?? "unknown model";
    if (model === "<synthetic>") return;
    const input = count(usage.input_tokens);
    const output = count(usage.output_tokens);
    const cacheRead = count(usage.cache_read_input_tokens);
    const cacheWrite = count(usage.cache_creation_input_tokens);
    const total = input + output + cacheRead + cacheWrite;
    if (total <= 0) return;
    const key = `claude:${id ?? ""}|${request ?? ""}`;
    const first = this.records.get(key);
    this.records.set(key, { key, at: first?.at ?? at, model, provider: "anthropic", input, output, cacheRead, cacheWrite, total, cost: 0 });
  }

  finish(): OutsideSession {
    return { sessionId: this.sessionId ?? this.fallbackId, cwd: this.cwd, records: [...this.records.values()] };
  }
}
