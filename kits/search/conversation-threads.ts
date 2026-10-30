import type { HostConversationServices, HostConversationSummary, HostTranscriptCursor, ThreadTextChunk, UiMessage } from "tau/host-extension";
import type { PersistentMessageIndex } from "./persistent-index.js";
import { findInThread, type ThreadText } from "./threads.js";

const SOURCE = "tau.conversations";

/** Adapts the host's generic persisted conversation pages to Search's text index. */
export class ConversationThreadIndex {
  private summaries = new Map<string, HostConversationSummary>();
  private usable = new Set<string>();
  private memory = new Map<string, ThreadText[]>();
  private syncing?: Promise<void>;
  revision = 0;
  truncated = false;

  constructor(private readonly services: HostConversationServices | undefined, private readonly options: {
    persistent?: PersistentMessageIndex; budgetChars?: number;
  } = {}) {}

  /** Suppress aliases only when a full replacement is committed, or the host retains a tombstone. */
  suppresses(id: string): boolean { return this.summaries.get(id)?.deleted === true || this.usable.has(id); }

  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    const before = this.suppressionKey();
    const work = this.refresh().finally(() => {
      if (this.suppressionKey() !== before) this.revision++;
      this.syncing = undefined;
    });
    this.syncing = work;
    return work;
  }

  private suppressionKey(): string {
    return JSON.stringify([...new Set([...this.usable, ...[...this.summaries.values()].filter(summary => summary.deleted).map(summary => summary.sessionId)])].sort());
  }

  private async refresh(): Promise<void> {
    if (!this.services) return;
    let summaries: HostConversationSummary[];
    try { summaries = await this.services.list(); }
    catch { this.truncated = true; this.usable.clear(); return; }
    this.summaries = new Map(summaries.map(summary => [summary.sessionId, summary]));
    this.usable.clear(); this.memory.clear(); this.truncated = false;
    const persistent = this.options.persistent;
    if (persistent) for (const entry of await persistent.catalog()) {
      if (entry.source === SOURCE && (!this.summaries.has(entry.id) || this.summaries.get(entry.id)?.deleted)) await persistent.drop(entry);
    }
    let remaining = this.options.budgetChars ?? 4_000_000;
    for (const summary of summaries) {
      if (summary.deleted) continue;
      try {
        if (persistent) await persistent.putRuntimeStream(SOURCE, summary.sessionId, summary.modifiedAt, summary.version, () => this.chunks(summary));
        else {
          const messages: ThreadText[] = [];
          let current: ThreadText | undefined;
          let complete = true;
          for await (const chunk of this.chunks(summary)) {
            if (chunk.text.length > remaining) { complete = false; break; }
            if (chunk.offset === 0) { current = { role: chunk.role, text: "" }; messages.push(current); }
            current!.text += chunk.text; remaining -= chunk.text.length;
          }
          this.memory.set(summary.sessionId, messages);
          if (!complete) { this.truncated = true; continue; }
        }
        this.usable.add(summary.sessionId);
      } catch { this.truncated = true; }
    }
  }

  private async read(summary: HostConversationSummary, cursor?: HostTranscriptCursor) {
    const answer = await this.services!.page(summary.sessionId, summary.version, cursor);
    if (answer.status !== "ok" || answer.page.sessionId !== summary.sessionId
      || answer.page.hasMore && (!answer.page.olderCursor || answer.page.olderCursor === cursor)) throw new Error("Conversation changed during export");
    return answer.page;
  }

  private async *chunks(summary: HostConversationSummary): AsyncGenerator<ThreadTextChunk> {
    // The transcript protocol reads newest pages first. Retain only their
    // opaque cursors, then read them oldest first without holding all text.
    const cursors: Array<HostTranscriptCursor | undefined> = [undefined];
    const seen = new Set<HostTranscriptCursor>();
    let cursor: HostTranscriptCursor | undefined;
    for (;;) {
      const page = await this.read(summary, cursor);
      if (!page.hasMore) break;
      cursor = page.olderCursor!;
      if (seen.has(cursor)) throw new Error("Conversation cursor repeated");
      seen.add(cursor); cursors.push(cursor);
    }
    let ordinal = 0;
    for (const position of cursors.reverse()) {
      const page = await this.read(summary, position);
      for (const message of page.messages) {
        if ((message.role !== "user" && message.role !== "assistant") || !message.text.trim()) continue;
        yield* this.messageChunks(message, ordinal++);
      }
    }
  }

  private *messageChunks(message: UiMessage, ordinal: number): Iterable<ThreadTextChunk> {
    for (let offset = 0; offset < message.text.length;) {
      let end = Math.min(message.text.length, offset + 16_384);
      if (end < message.text.length && /[\uD800-\uDBFF]/u.test(message.text[end - 1]!) && /[\uDC00-\uDFFF]/u.test(message.text[end]!)) end--;
      yield { messageId: String(ordinal), role: message.role as "user" | "assistant", offset,
        text: message.text.slice(offset, end), end: end === message.text.length };
      offset = end;
    }
  }

  async *search(tokens: readonly string[], candidates?: ReadonlySet<string>, excluded?: string) {
    for (const [id, summary] of this.summaries) {
      if (summary.deleted || id === excluded || candidates && !candidates.has(id)) continue;
      if (this.options.persistent && !this.usable.has(id)) continue;
      try {
        const found = this.options.persistent
          ? (await this.options.persistent.searchRuntime(SOURCE, id, tokens))?.match
          : findInThread(this.memory.get(id) ?? [], tokens, tokens.join(" "));
        if (found) yield { sessionId: id, path: summary.path, modifiedAt: summary.modifiedAt, match: found };
      } catch { this.usable.delete(id); this.truncated = true; }
    }
  }
}
