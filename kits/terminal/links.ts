/** URLs in terminal output, and where a click on one goes. */

export interface TerminalLinkMatch {
  url: string;
  /** Offsets in the searched text; `end` is exclusive. */
  start: number;
  end: number;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s"'`<>]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/u;

/** Drops punctuation a sentence put after the URL and closing brackets it never opened. */
function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING_PUNCTUATION, "");
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
    while (url.endsWith(close) && url.split(open).length < url.split(close).length) url = url.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
  }
  return url;
}

export function findTerminalLinks(text: string): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (!/^https?:\/\/[^/]/iu.test(url)) continue;
    matches.push({ url, start: match.index, end: match.index + url.length });
  }
  return matches;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"]);

export type TerminalLinkTarget =
  | { kind: "preview"; url: string }
  | { kind: "external"; url: string };

/**
 * A server on this machine opens in the Preview; anything else in the
 * browser. `0.0.0.0` is where a dev server listens, not where a browser may
 * go, so it is visited as `localhost`.
 */
export function classifyTerminalLink(text: string): TerminalLinkTarget | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const host = url.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host) && !host.endsWith(".localhost")) return { kind: "external", url: url.href };
  if (host === "0.0.0.0" || host === "[::]") url.hostname = "localhost";
  return { kind: "preview", url: url.href };
}

/** A buffer row as the link provider sees it; xterm's `IBufferLine` has this shape. */
export interface BufferRowLike {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

export interface WrappedLine {
  text: string;
  /** The 1-based buffer row each part of `text` came from, with its start offset in `text`. */
  rows: Array<{ row: number; start: number }>;
}

/**
 * The logical line a buffer row belongs to: a URL longer than the terminal is
 * wide wraps onto the next row, and must be found and clicked as one.
 */
export function wrappedLineAt(row: number, getRow: (index: number) => BufferRowLike | undefined): WrappedLine | undefined {
  let first = row;
  while (first > 1 && getRow(first - 1)?.isWrapped) first -= 1;
  if (!getRow(first - 1)) return undefined;
  const rows: WrappedLine["rows"] = [];
  let text = "";
  for (let current = first; ; current += 1) {
    const line = getRow(current - 1);
    if (!line) break;
    const continues = getRow(current)?.isWrapped === true;
    rows.push({ row: current, start: text.length });
    text += line.translateToString(!continues);
    if (!continues) break;
  }
  return { text, rows };
}

/** Where offset `index` of a wrapped line sits in the buffer: 1-based row and column. */
export function positionIn(line: WrappedLine, index: number): { x: number; y: number } {
  let at = line.rows[0]!;
  for (const row of line.rows) if (row.start <= index) at = row;
  return { x: index - at.start + 1, y: at.row };
}
