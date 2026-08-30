import type { ThreadDetail } from "./host-protocol.js";

/**
 * Session detail cache. Entries are deliberately whole-record values; callers
 * replace one session without invalidating records for other sessions.
 */
export class ThreadDetailStore {
  private readonly entries = new Map<string, ThreadDetail>();
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
    this.entries.delete(detail.sessionId);
    this.entries.set(detail.sessionId, detail);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  update(sessionId: string, update: (current: ThreadDetail | undefined) => ThreadDetail | undefined): ThreadDetail | undefined {
    const next = update(this.get(sessionId));
    if (next) this.set(next);
    return next;
  }

  delete(sessionId: string): void { this.entries.delete(sessionId); }
  clear(): void { this.entries.clear(); }
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
