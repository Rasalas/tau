import { createReadStream } from "node:fs";
import { keyHash } from "./outside-keys.js";

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

/** Where a read of a log stopped: after its last complete line. */
export interface MarkedLinesRead {
  /** Oversized lines that might have carried usage (`mayCarryUsage` over their first bytes). */
  skipped: number;
  /** Byte offset just past the last complete line; the next read may start here. */
  end: number;
}

/**
 * Hands `consume` each complete line from byte `start` on that contains one
 * of `markers`; the rest is never decoded. An unfinished last line belongs to
 * a writer still at work and is read next time, from `end`.
 */
export async function scanMarkedLines(path: string, markers: readonly string[], consume: (line: string) => void, mayCarryUsage: (head: string) => boolean, options: { start?: number; maxLineBytes?: number } = {}): Promise<MarkedLinesRead> {
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  const needles = markers.map((marker) => Buffer.from(marker));
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let discarding = false;
  let skipped = 0;
  let position = options.start ?? 0;
  let end = position;
  const offer = (line: Buffer) => { if (needles.some((needle) => line.includes(needle))) consume(line.toString("utf8")); };
  const drop = (piece: Buffer) => {
    const head = (pending.length > 0 ? pending[0]! : piece).subarray(0, 4096).toString("utf8");
    if (mayCarryUsage(head)) skipped += 1;
    pending = [];
    pendingBytes = 0;
  };
  for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024, start: position }) as AsyncIterable<Buffer>) {
    let start = 0;
    for (let newline = chunk.indexOf(10, start); newline !== -1; newline = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, newline);
      start = newline + 1;
      end = position + start;
      if (discarding) { discarding = false; continue; }
      if (pendingBytes + piece.length > maxLineBytes) { drop(piece); continue; }
      offer(pending.length > 0 ? Buffer.concat([...pending, piece]) : piece);
      pending = [];
      pendingBytes = 0;
    }
    position += chunk.length;
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
  return { skipped, end };
}

/** `scanMarkedLines` from the start; answers the oversized lines that might have carried usage. */
export async function readMarkedLines(path: string, markers: readonly string[], consume: (line: string) => void, mayCarryUsage: (head: string) => boolean, maxLineBytes = MAX_LINE_BYTES): Promise<number> {
  return (await scanMarkedLines(path, markers, consume, mayCarryUsage, { maxLineBytes })).skipped;
}

/** Where a parser takes each response it finds. `add` answers false for one counted elsewhere already. */
export interface OutsideSink {
  add(record: OutsideRecord): boolean;
  /** A response added before, with the figures of a later line. */
  replace(previous: OutsideRecord, next: OutsideRecord): void;
}

/** Who a log's session is. */
export interface OutsideIdentity {
  sessionId: string;
  cwd: string;
  parentId?: string;
}

/**
 * A rollout whose older counters were counted up to a time a response record
 * now claims: it is read again from the start, counting counters only before
 * `modernSince`.
 */
export class RereadNeeded extends Error {
  constructor(readonly modernSince: number) {
    super("the rollout started writing response records after its counters were counted");
  }
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

/** What a rollout's parser carries from one read of a growing file to the next. */
export interface CodexParserState {
  sessionId?: string;
  cwd: string;
  parentId?: string;
  model: string;
  forkAnchor?: number;
  cumulative?: CodexUsage;
  signature: string;
  /** The first response record's time: counters from here on are the same responses again. */
  modernSince?: number;
  /** The latest counter counted. */
  legacyLastAt?: number;
}

/**
 * One rollout's responses, handed to the sink as they are read. A current
 * CLI writes a `token_usage_record` per response; before that only
 * `token_count` events, whose `total_token_usage` runs on over the session
 * and which repeat themselves, so each counts the step from the one before.
 * Where a file has both, counters count only before the first record. A
 * fork or a sub-agent replays its parent's events in one burst at its start;
 * those were counted in the parent.
 */
export class CodexRolloutParser {
  private readonly state: CodexParserState;
  skipped = 0;

  /** `modernSince` is known when a first read found records after counters it had counted. */
  constructor(private readonly fallbackId: string, private readonly sink: OutsideSink, state?: CodexParserState, modernSince?: number) {
    this.state = state ? { ...state } : { cwd: "", model: "unknown model", signature: "", ...(modernSince === undefined ? {} : { modernSince }) };
  }

  line(line: string): void {
    const state = this.state;
    let record: Record<string, unknown> | undefined;
    try { record = object(JSON.parse(line)); } catch { this.skipped += 1; return; }
    const payload = object(record?.payload);
    const type = record?.type;
    if (!payload || typeof type !== "string") return;
    if (type === "session_meta") {
      if (state.sessionId) return;
      state.sessionId = text(payload.id) ?? text(payload.session_id) ?? this.fallbackId;
      state.cwd = text(payload.cwd) ?? "";
      const spawn = object(object(object(payload.source)?.subagent)?.thread_spawn);
      const parentId = text(payload.forked_from_id) ?? text(spawn?.parent_thread_id);
      if (parentId) state.parentId = parentId;
      if (payload.forked_from_id !== undefined || object(payload.source)?.subagent !== undefined) {
        const anchor = timeOf(record!.timestamp);
        if (anchor !== undefined) state.forkAnchor = anchor;
      }
      return;
    }
    if (type === "turn_context") { state.model = text(payload.model) ?? state.model; return; }
    const at = timeOf(record!.timestamp);
    if (at === undefined) return;
    if (type === "token_usage_record") {
      const usage = object(payload.usage);
      const id = text(payload.response_id);
      if (!usage || !id) return;
      const tokens = codexTokens(usage);
      if (tokens.total <= 0) return;
      const since = Math.min(state.modernSince ?? at, at);
      if (state.legacyLastAt !== undefined && state.legacyLastAt >= since) throw new RereadNeeded(since);
      state.modernSince = since;
      this.sink.add({ key: `codex:${id}`, at, model: state.model, provider: "openai", ...tokens, cost: 0 });
      return;
    }
    if (type !== "event_msg" || payload.type !== "token_count") return;
    const info = object(payload.info);
    const last = object(info?.last_token_usage) as CodexUsage | undefined;
    if (!last) return;
    const total = object(info?.total_token_usage) as CodexUsage | undefined;
    const signature = `${count(total?.total_tokens)}|${count(last.input_tokens) + count(last.output_tokens)}|${count(last.cached_input_tokens)}`;
    const repeated = signature === state.signature;
    state.signature = signature;
    const previous = state.cumulative;
    if (total) state.cumulative = total;
    if (state.forkAnchor !== undefined) {
      if (at - state.forkAnchor < 1000) { state.forkAnchor = at; return; }
      delete state.forkAnchor;
    }
    if (repeated) return;
    if (state.modernSince !== undefined && at >= state.modernSince) return;
    const step = total && previous ? codexDelta(total, previous) : undefined;
    const tokens = codexTokens(step ?? last);
    if (tokens.total <= 0) return;
    state.legacyLastAt = Math.max(state.legacyLastAt ?? at, at);
    this.sink.add({ key: `codex:${state.sessionId ?? this.fallbackId}@${at}|${signature}`, at, model: state.model, provider: "openai", ...tokens, cost: 0 });
  }

  identity(): OutsideIdentity {
    const state = this.state;
    return { sessionId: state.sessionId ?? this.fallbackId, cwd: state.cwd, ...(state.parentId ? { parentId: state.parentId } : {}) };
  }

  /** What the next read of the same file, from where this one stopped, starts with. */
  snapshot(): CodexParserState {
    return { ...this.state };
  }
}

export const CLAUDE_MARKERS = ["\"usage\""];

export function claudeMayCarryUsage(head: string): boolean {
  return head.includes("\"role\":\"assistant\"");
}

/** The response a Claude log's last usage line belonged to; its key only as a hash. */
export interface ClaudeOpenResponse {
  hash: number;
  record: OutsideRecord;
  /** A copy was counted in another log first. */
  counted: "pending" | "yes" | "copy";
}

export interface ClaudeParserState {
  sessionId?: string;
  cwd: string;
  open?: ClaudeOpenResponse;
}

/**
 * One session file of the Agent SDK's CLI. Every assistant line carries its
 * response's usage, and a response of several content blocks is several
 * lines in a row with the same message and request id: it counts once, with
 * the last line's figures. Sub-agent files carry their parent's session id.
 */
export class ClaudeProjectParser {
  private readonly state: ClaudeParserState;
  skipped = 0;

  constructor(private readonly fallbackId: string, private readonly sink: OutsideSink, state?: ClaudeParserState, private readonly hash: (key: string) => number = keyHash) {
    this.state = state ? { ...state } : { cwd: "" };
  }

  line(line: string): void {
    const state = this.state;
    let record: Record<string, unknown> | undefined;
    try { record = object(JSON.parse(line)); } catch { this.skipped += 1; return; }
    if (record?.type !== "assistant") return;
    const message = object(record.message);
    const usage = object(message?.usage);
    const at = timeOf(record.timestamp);
    const id = text(message?.id);
    const request = text(record.requestId);
    if (!message || !usage || at === undefined || (!id && !request)) return;
    state.sessionId ??= text(record.sessionId);
    if (!state.cwd) state.cwd = text(record.cwd) ?? "";
    const model = text(message.model) ?? "unknown model";
    if (model === "<synthetic>") return;
    const input = count(usage.input_tokens);
    const output = count(usage.output_tokens);
    const cacheRead = count(usage.cache_read_input_tokens);
    const cacheWrite = count(usage.cache_creation_input_tokens);
    const total = input + output + cacheRead + cacheWrite;
    if (total <= 0) return;
    const key = `claude:${id ?? ""}|${request ?? ""}`;
    const hash = this.hash(key);
    const open = state.open;
    if (open && open.hash === hash) {
      const next: OutsideRecord = { ...open.record, key, model, input, output, cacheRead, cacheWrite, total };
      if (open.counted === "yes") this.sink.replace(open.record, next);
      open.record = next;
      return;
    }
    this.close();
    state.open = { hash, record: { key, at, model, provider: "anthropic", input, output, cacheRead, cacheWrite, total, cost: 0 }, counted: "pending" };
  }

  /** Counts the response the last lines belong to; a later line of it replaces its figures. */
  private close(): void {
    const open = this.state.open;
    if (!open || open.counted !== "pending") return;
    open.counted = this.sink.add(open.record) ? "yes" : "copy";
  }

  identity(): OutsideIdentity {
    this.close();
    return { sessionId: this.state.sessionId ?? this.fallbackId, cwd: this.state.cwd };
  }

  snapshot(): ClaudeParserState {
    this.close();
    const open = this.state.open;
    // The key is kept as its hash only.
    return { ...this.state, ...(open ? { open: { ...open, record: { ...open.record, key: "" } } } : {}) };
  }
}
