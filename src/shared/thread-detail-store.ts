import { transcriptRetainedBytes } from "./transcript-memory.js";
import type { ThreadDetail } from "./host-protocol.js";

export const DETAIL_CACHE_BYTES = 32 * 1024 * 1024;
export const DETAIL_CACHE_MESSAGES = 5000;

/**
 * Thread detail cache. Entries are deliberately whole-record values; callers
 * replace one thread without invalidating records for other threads. The key is
 * the persisted runtime session ID because that is the host's stable identity.
 */
export class ThreadDetailStore {
  private readonly entries = new Map<string, ThreadDetail>();
  private readonly weights = new Map<string, { bytes: number; messages: number }>();
  private bytes = 0;
  private messages = 0;
  constructor(private readonly maxEntries = 5) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be positive");
  }

  get(sessionId: string): ThreadDetail | undefined {
    const detail = this.entries.get(sessionId);
    if (!detail) return undefined;
    this.entries.delete(sessionId);
    this.entries.set(sessionId, detail);
    return detail;
  }

  set(detail: ThreadDetail): void {
    this.delete(detail.sessionId);
    const bytes = transcriptRetainedBytes(detail);
    const messages = detail.messages.length;
    // A cache miss reloads the complete record. Never slice a detail and leave
    // its cursor/task/activity metadata describing a different window.
    if (bytes > DETAIL_CACHE_BYTES || messages > DETAIL_CACHE_MESSAGES) return;
    this.entries.set(detail.sessionId, detail);
    this.weights.set(detail.sessionId, { bytes, messages });
    this.bytes += bytes;
    this.messages += messages;
    while (this.entries.size > this.maxEntries || this.bytes > DETAIL_CACHE_BYTES || this.messages > DETAIL_CACHE_MESSAGES) {
      this.delete(this.entries.keys().next().value!);
    }
  }

  update(sessionId: string, update: (current: ThreadDetail | undefined) => ThreadDetail | undefined): ThreadDetail | undefined {
    const next = update(this.get(sessionId));
    if (next) this.set(next);
    return next;
  }

  delete(sessionId: string): void {
    const weight = this.weights.get(sessionId);
    if (weight) { this.bytes -= weight.bytes; this.messages -= weight.messages; }
    this.weights.delete(sessionId);
    this.entries.delete(sessionId);
  }
  clear(): void { this.entries.clear(); this.weights.clear(); this.bytes = 0; this.messages = 0; }
  has(sessionId: string): boolean { return this.entries.has(sessionId); }
  get size(): number { return this.entries.size; }
  ids(): string[] { return [...this.entries.keys()]; }
}

export function replaceDetailRecord(
  detail: ThreadDetail,
  patch: Partial<Omit<ThreadDetail, "sessionId">>,
): ThreadDetail {
  return { ...detail, ...patch, sessionId: detail.sessionId };
}
