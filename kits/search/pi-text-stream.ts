/**
 * A bounded JSONL reader for Pi's visible message text. Even a multi-megabyte
 * string is decoded in pieces; tool and image fields do not enter the search.
 * Provisional blocks are committed only by a valid message terminator. This
 * also permits type/role fields to follow content, as JSON permits.
 */
export type TextRecord =
  | { kind: "text"; text: string }
  | { kind: "block"; visible: boolean }
  | { kind: "message"; role?: "user" | "assistant"; visible: boolean };
export const TEXT_CHUNK = 16_384;
type Path = Array<string | number>;
type Frame = { path: Path; array: boolean; state: "key" | "colon" | "value" | "comma" | "first"; key: string; index: number; seen: Set<string> };

class JsonLine {
  private stack: Frame[] = [];
  private root = false;
  private invalid = false;
  private mode: "idle" | "string" | "atom" = "idle";
  private path: Path = [];
  private key = false;
  private value = "";
  private piece = "";
  private escape = "";
  private escaped = false;
  private type = "";
  private role = "";
  private blockType = "";

  constructor(private readonly emit: (record: TextRecord) => void) {}

  private visiblePath(): boolean {
    return this.path.length === 2 && this.path[0] === "message" && this.path[1] === "content"
      || this.path.length === 4 && this.path[0] === "message" && this.path[1] === "content"
        && typeof this.path[2] === "number" && this.path[3] === "text";
  }

  private stringPiece(): void {
    const allowedRole = !this.role || this.role === "user" || this.role === "assistant";
    const allowedType = !this.type || this.type === "message";
    const allowedBlock = this.path.length === 2 || !this.blockType || this.blockType === "text";
    if (allowedRole && allowedType && allowedBlock && this.visiblePath() && this.piece) this.emit({ kind: "text", text: this.piece });
    this.piece = "";
  }

  private decoded(char: string): void {
    if (this.key || !this.visiblePath()) {
      // Only JSON keys and the three small discriminators are needed. Long
      // unrelated strings do not consume memory. Long keys cannot match ours.
      if (this.value.length < 128) this.value += char;
    } else {
      this.piece += char;
      if (this.piece.length >= TEXT_CHUNK) this.stringPiece();
    }
  }

  private completeValue(): void {
    const parent = this.stack.at(-1);
    if (parent) { parent.state = "comma"; parent.index += 1; }
    else this.root = true;
  }

  private valuePath(): Path {
    const parent = this.stack.at(-1);
    return parent ? [...parent.path, parent.array ? parent.index : parent.key] : [];
  }

  feed(input: string): void {
    if (this.invalid) return;
    try {
      for (let at = 0; at < input.length; at += 1) {
        const char = input[at]!;
        if (this.mode === "string") {
          if (this.escape) {
            if (!/[\da-f]/iu.test(char)) throw new Error("Bad unicode escape");
            this.escape += char;
            if (this.escape.length === 5) { this.decoded(String.fromCharCode(parseInt(this.escape.slice(1), 16))); this.escape = ""; }
          } else if (this.escaped) {
            this.escaped = false;
            if (char === "u") this.escape = "u";
            else {
              const decoded = ({ '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[char];
              if (decoded === undefined) throw new Error("Bad escape");
              this.decoded(decoded);
            }
          } else if (char === "\\") this.escaped = true;
          else if (char === '"') {
            this.mode = "idle";
            if (this.key) {
              const parent = this.stack.at(-1)!;
              if (["type", "message", "role", "content", "text"].includes(this.value)) {
                if (parent.seen.has(this.value)) throw new Error("Duplicate message field");
                parent.seen.add(this.value);
              }
              parent.key = this.value; parent.state = "colon";
            } else {
              this.stringPiece();
              const path = this.path.join(".");
              if (this.path.length === 1 && path === "type") this.type = this.value;
              if (this.path.length === 2 && path === "message.role") this.role = this.value;
              if (this.path.length === 4 && this.path[0] === "message" && this.path[1] === "content" && this.path[3] === "type") this.blockType = this.value;
              if (this.path.length === 2 && path === "message.content") { this.emit({ kind: "block", visible: true }); }
              this.completeValue();
            }
          } else {
            if (char.charCodeAt(0) < 32) throw new Error("Control in string");
            this.decoded(char);
          }
          continue;
        }
        if (this.mode === "atom") {
          if (!/[ \t\r,}\]]/u.test(char)) {
            this.value += char;
            if (this.value.length > 128) throw new Error("Invalid scalar");
            continue;
          }
          if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/u.test(this.value)) throw new Error("Invalid scalar");
          this.mode = "idle"; this.completeValue();
          at -= 1; continue;
        }
        if (/[ \t\r]/u.test(char)) continue;
        const parent = this.stack.at(-1);
        if (parent?.state === "colon") {
          if (char !== ":") throw new Error("Missing colon");
          parent.state = "value"; continue;
        }
        if (char === "}" || char === "]") {
          if (!parent || parent.array !== (char === "]") || (parent.state !== "comma" && parent.state !== "first")) throw new Error("Bad close");
          this.stack.pop();
          if (parent.path.length === 3 && parent.path[0] === "message" && parent.path[1] === "content" && !parent.array) {
            this.emit({ kind: "block", visible: this.blockType === "text" }); this.blockType = "";
          }
          this.completeValue(); continue;
        }
        if (parent?.state === "comma") {
          if (char !== ",") throw new Error("Missing comma");
          parent.state = parent.array ? "value" : "key"; continue;
        }
        if (parent && !parent.array && (parent.state === "first" || parent.state === "key")) {
          if (char !== '"') throw new Error("Missing key");
          this.mode = "string"; this.key = true; this.value = ""; continue;
        }
        if (this.root) throw new Error("Trailing data");
        this.path = this.valuePath(); this.key = false; this.value = "";
        if (char === '"') { this.mode = "string"; continue; }
        if (char === "{" || char === "[") {
          if (this.stack.length >= 256) throw new Error("Too deeply nested");
          this.stack.push({ path: this.path, array: char === "[", state: "first", key: "", index: 0, seen: new Set() });
          continue;
        }
        this.mode = "atom"; this.value = char;
      }
      // Flush decoded text at input boundaries as well, keeping buffers small.
      if (this.mode === "string" && !this.key) this.stringPiece();
    } catch { this.invalid = true; }
  }

  finish(): void {
    this.feed(" ");
    const role = this.role === "user" || this.role === "assistant" ? this.role : undefined;
    this.emit({ kind: "message", ...(role ? { role } : {}), visible: !this.invalid && this.root && this.mode === "idle" && this.stack.length === 0 && this.type === "message" && Boolean(role) });
  }
}

/** Input chunks may split UTF-8, JSON escapes and any part of a giant string. */
export async function* piTextRecords(chunks: AsyncIterable<string>): AsyncGenerator<TextRecord> {
  let pending: TextRecord[] = [];
  let parser = new JsonLine((record) => pending.push(record));
  let hasLine = false;
  for await (const chunk of chunks) {
    let at = 0;
    for (;;) {
      const end = chunk.indexOf("\n", at);
      const part = chunk.slice(at, end === -1 ? undefined : end);
      if (part) { parser.feed(part); hasLine = true; }
      if (end !== -1) { parser.finish(); parser = new JsonLine((record) => pending.push(record)); hasLine = false; }
      for (const record of pending) yield record;
      pending = [];
      if (end === -1) break;
      at = end + 1;
    }
  }
  if (hasLine) { parser.finish(); for (const record of pending) yield record; }
}
