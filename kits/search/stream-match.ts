import { tokenMatch } from "./relevance.js";
import { snippetAround } from "./threads.js";
import type { TextRecord } from "./pi-text-stream.js";
import type { ThreadMatch } from "./protocol.js";

type Occurrence = { rank: number; snippet: string };
type MessageMatch = Required<Pick<ThreadMatch, "role" | "snippet" | "quality">>;
/** Per-message search state, independent of where the index split its text. */
export class MessageMatcher {
  private buffer = "";
  private started = false;
  private readonly overlap: number;
  private readonly found: Array<Occurrence | undefined>;
  private phraseFound: Occurrence | undefined;

  constructor(private readonly tokens: readonly string[], private readonly phrase = tokens.join(" ")) {
    this.found = tokens.map(() => undefined);
    this.overlap = Math.max(phrase.length, ...tokens.map((token) => token.length), 0) + 100;
  }

  add(text: string): void {
    this.buffer += text;
    this.scan(false);
  }

  private scan(final: boolean): void {
    const before = final ? this.buffer.length + 1 : Math.max(0, this.buffer.length - this.overlap);
    // Keep real left-hand context at the start of every subsequent window.
    const context = this.started ? 4 : 0;
    const source = this.buffer;
    const scan = (token: string, held: Occurrence | undefined): Occurrence | undefined => {
      // The four carried characters are context only. Including them again is
      // harmless unless they would acquire an invented word-start at offset 0.
      const match = tokenMatch(source, token, before, context);
      if (!match || match.at < context || match.rank <= (held?.rank ?? 0)) return held;
      return { rank: match.rank, snippet: snippetAround(source, match.at, match.length) };
    };
    for (let at = 0; at < this.tokens.length; at += 1) this.found[at] = scan(this.tokens[at]!, this.found[at]);
    this.phraseFound = scan(this.phrase, this.phraseFound);
    if (!final && before > 4) {
      this.buffer = this.buffer.slice(before - 4);
      this.started = true;
    }
  }

  /** A text block ends with a newline in Pi's message text. Tokens cannot span it. */
  endBlock(): void { this.scan(true); this.buffer = ""; this.started = false; }

  merge(block: MessageMatcher): void {
    for (let at = 0; at < this.found.length; at += 1) {
      const next = block.found[at];
      if (next && next.rank > (this.found[at]?.rank ?? 0)) this.found[at] = next;
    }
    if ((block.phraseFound?.rank ?? 0) > (this.phraseFound?.rank ?? 0)) this.phraseFound = block.phraseFound;
  }

  result(): Pick<MessageMatch, "snippet" | "quality"> | undefined {
    if (!this.found.length || this.found.some((entry) => !entry)) return undefined;
    const rank = Math.min(...this.found.map((entry) => entry!.rank));
    const phrase = this.phraseFound && this.phraseFound.rank >= rank ? this.phraseFound : undefined;
    return { quality: rank * 10 + Number(Boolean(phrase)), snippet: (phrase ?? this.found[0])!.snippet };
  }
}

/** Candidate text is ignored unless its block and entire JSON line committed. */
export class RecordMatcher {
  private block: MessageMatcher;
  private message: MessageMatcher;
  private best: MessageMatch | undefined;
  constructor(private readonly tokens: readonly string[]) {
    this.block = new MessageMatcher(tokens);
    this.message = new MessageMatcher(tokens);
  }
  add(record: TextRecord): void {
    if (record.kind === "text") this.block.add(record.text);
    else if (record.kind === "block") {
      this.block.endBlock();
      if (record.visible) this.message.merge(this.block);
      this.block = new MessageMatcher(this.tokens);
    } else {
      const match = record.visible && record.role ? this.message.result() : undefined;
      if (match && match.quality > (this.best?.quality ?? 0)) this.best = { role: record.role!, ...match };
      this.block = new MessageMatcher(this.tokens);
      this.message = new MessageMatcher(this.tokens);
    }
  }
  result(): MessageMatch | undefined { return this.best; }
}
