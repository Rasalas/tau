/** Optional API 1.79.0 find semantics. Manual in-thread find remains literal. */
export type TranscriptFindMode = "literal" | "all-words";

export interface TranscriptFindOptions {
  /** Retain the request until this thread's transcript mounts, independently of the active DOM ref. */
  sessionId?: string;
  /** Global message hits select the best text-only message holding every whitespace-separated token. */
  mode?: TranscriptFindMode;
}

export interface ThreadFindRequest {
  sessionId: string;
  query?: string;
  mode?: TranscriptFindMode;
}

/** One window's latest explicit target. A foreign transcript cannot consume it. */
export class PendingThreadFind {
  private pending?: ThreadFindRequest;
  private receiver?: { sessionId: string; open(request: ThreadFindRequest): void };

  request(request: ThreadFindRequest): void {
    this.pending = request;
    this.deliver();
  }

  clear(): void { this.pending = undefined; }

  answer(sessionId: string, open: (request: ThreadFindRequest) => void): () => void {
    const receiver = { sessionId, open };
    this.receiver = receiver;
    this.deliver();
    return () => { if (this.receiver === receiver) this.receiver = undefined; };
  }

  private deliver(): void {
    const receiver = this.receiver;
    if (!this.pending || !receiver || this.pending.sessionId !== receiver.sessionId) return;
    const request = this.pending;
    this.pending = undefined;
    receiver.open(request);
  }
}

/** The global search's scalar case folding, including both Greek sigma forms. */
export function foldFindWords(text: string): string {
  return text.replace(/[Σς]/gu, "σ").toLowerCase();
}

export function findWordTokens(query: string): string[] {
  return [...new Set(foldFindWords(query).split(/\s+/u).filter(Boolean))];
}
