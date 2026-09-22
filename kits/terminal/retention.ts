/** Lines of output one shell keeps for a view that reattaches; the view's own scrollback is as long. */
export const RETAINED_LINES = 5_000;
/** A second cap in UTF-16 units, so one endless line cannot hold the host's memory. */
export const RETAINED_CHARS = 2 * 1024 * 1024;

/** How far a character cut may move forward to land on a line start. */
const LINE_START_REACH = 4096;

function countNewlines(text: string): number {
  let count = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count += 1;
  return count;
}

function afterNthNewline(text: string, n: number): number {
  let index = -1;
  for (let found = 0; found < n; found += 1) {
    index = text.indexOf("\n", index + 1);
    if (index === -1) return text.length;
  }
  return index + 1;
}

/**
 * The tail of a shell's output, capped at `RETAINED_LINES` lines and
 * `RETAINED_CHARS` characters. Appending keeps the chunks as they came; only
 * the oldest ones are dropped or cut, at a line start where one is near and
 * never inside a surrogate pair.
 */
export class Scrollback {
  private chunks: string[] = [];
  private chars = 0;
  private lines = 0;

  constructor(
    private readonly maxLines = RETAINED_LINES,
    private readonly maxChars = RETAINED_CHARS,
  ) {}

  append(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.chars += data.length;
    this.lines += countNewlines(data);
    this.trim();
  }

  text(): string {
    if (this.chunks.length > 1) this.chunks = [this.chunks.join("")];
    return this.chunks[0] ?? "";
  }

  get lineCount(): number {
    return this.lines;
  }

  private trim(): void {
    while (this.chunks.length > 1) {
      const head = this.chunks[0]!;
      const headLines = countNewlines(head);
      const excessLines = this.lines - this.maxLines;
      // A head that ends mid-line keeps its tail unless the character cap needs it gone.
      const pastLines = headLines < excessLines || (headLines === excessLines && head.endsWith("\n"));
      if (!pastLines && this.chars - head.length < this.maxChars) break;
      this.chunks.shift();
      this.chars -= head.length;
      this.lines -= headLines;
    }
    if (this.lines <= this.maxLines && this.chars <= this.maxChars) return;
    const head = this.chunks[0]!;
    let cut = this.lines > this.maxLines ? afterNthNewline(head, this.lines - this.maxLines) : 0;
    const excess = this.chars - this.maxChars;
    if (excess > cut) {
      const newline = head.indexOf("\n", excess);
      cut = newline === -1 || newline - excess > LINE_START_REACH ? excess : newline + 1;
    }
    const code = head.charCodeAt(cut);
    if (code >= 0xdc00 && code <= 0xdfff) cut += 1;
    const dropped = head.slice(0, cut);
    this.chunks[0] = head.slice(cut);
    this.chars -= dropped.length;
    this.lines -= countNewlines(dropped);
    if (!this.chunks[0]) this.chunks.shift();
  }
}
