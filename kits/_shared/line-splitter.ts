/**
 * Splits a byte stream into lines. An unfinished line's chunks are kept as
 * they came and joined once its newline arrives, so only new bytes are
 * searched. At most `max` bytes of one are held: a longer one is dropped up to
 * its newline, with one `onOverflow`.
 */
export function lineSplitter(max: number, onLine: (line: string) => void, onOverflow?: () => void): (chunk: Buffer) => void {
  let parts: Buffer[] = [];
  let held = 0;
  let skipping = false;
  return (chunk) => {
    let start = 0;
    for (let newline = chunk.indexOf(10); newline >= 0; newline = chunk.indexOf(10, start)) {
      const tail = chunk.subarray(start, newline);
      start = newline + 1;
      if (skipping) { skipping = false; continue; }
      const line = parts.length ? Buffer.concat([...parts, tail]) : tail;
      parts = []; held = 0;
      onLine(line.toString("utf8").replace(/\r$/u, ""));
    }
    if (skipping || start === chunk.length) return;
    held += chunk.length - start;
    if (held > max) { skipping = true; parts = []; held = 0; onOverflow?.(); return; }
    parts.push(Buffer.from(chunk.subarray(start)));
  };
}
