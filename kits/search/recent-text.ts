import { createReadStream } from "node:fs";
import { piTextRecords } from "./pi-text-stream.js";
import { THREAD_TEXT_LIMIT, ThreadTextWindow, type ThreadText } from "./threads.js";

/** Keep ends separate when text was omitted, so no invented phrase spans the gap. */
class Ends {
  private head = "";
  private tail = "";
  private length = 0;
  add(text: string): void {
    this.length += text.length;
    this.head = (this.head + text).slice(0, THREAD_TEXT_LIMIT / 2);
    this.tail = (this.tail + text).slice(-THREAD_TEXT_LIMIT);
  }
  parts(): string[] {
    return this.length <= THREAD_TEXT_LIMIT ? [this.tail] : [this.head, this.tail.slice(-THREAD_TEXT_LIMIT / 2)];
  }
}

/** The pre-index beginning/end fallback, decoded without buffering a JSONL line. */
export async function recentPiText(path: string, cancelled: () => boolean): Promise<ThreadText[]> {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
  let block = new Ends();
  let message: Ends[] = [];
  const result = new ThreadTextWindow();
  try {
    for await (const record of piTextRecords(stream)) {
      if (cancelled()) return result.texts();
      if (record.kind === "text") block.add(record.text);
      else if (record.kind === "block") {
        if (record.visible) {
          message.push(block);
          // Coalesce complete blocks while respecting the newline between them.
          if (message.length > 1) {
            const combined = new Ends();
            for (const [at, part] of message.entries()) {
              if (at) combined.add("\n");
              const pieces = part.parts();
              combined.add(pieces.join("\n"));
            }
            message = [combined];
          }
        }
        block = new Ends();
      } else {
        if (record.visible && record.role) for (const part of message) for (const text of part.parts()) result.add({ role: record.role, text });
        message = [];
      }
    }
    return result.texts();
  } finally { stream.destroy(); }
}
