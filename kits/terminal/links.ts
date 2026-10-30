/** URLs in terminal output, and where a click on one goes. */

export interface TerminalLinkMatch {
  url: string;
  /** Offsets in the searched text; `end` is exclusive. */
  start: number;
  end: number;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s"'`<>]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/u;

/** Drops punctuation a sentence put after the URL (or a compiler's `file:3:1:`) and closing brackets it never opened. */
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

export interface TerminalFileLinkMatch {
  /** The path without outer quotes, escaped quote delimiters or a trailing `:line:column`. */
  path: string;
  line?: number;
  column?: number;
  /** Offsets in the searched text, position included; `end` is exclusive. */
  start: number;
  end: number;
}

// Explicit paths (rooted, `~`, `./`, drive, UNC), or a bare `dir/file` made of plain name characters.
const FILE_PATTERN = /(?<![\p{L}\p{M}\p{N}_.~/\\-])(?:~[\\/]|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]+|(?<![\p{L}\p{M}\p{N}_.~/\\-])[\p{L}\p{M}\p{N}_.-]+(?:[\\/][\p{L}\p{M}\p{N}_.-]+)+(?::\d+){0,2}/gu;
const POSITION = /:(\d+)(?::(\d+))?$/u;
const EXPLICIT = /^(?:~[\\/]|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\\\)/u;
const EXTENSION = /\.[A-Za-z0-9_-]+$/u;

interface QuotedPath {
  start: number;
  end: number;
  raw?: string;
}

/** Read whole quoted tokens so an invalid quoted sentence cannot expose partial file links. */
function quotedPaths(text: string): QuotedPath[] {
  const spans: QuotedPath[] = [];
  for (let start = 0; start < text.length; start += 1) {
    const quote = text[start];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    // Apostrophes within words and shell escapes do not start a quoted path.
    if (start > 0 && /[\p{L}\p{M}\p{N}_\\]$/u.test(text.slice(0, start))) continue;
    let raw = "";
    let end = start + 1;
    for (; end < text.length && !/[\r\n]/u.test(text[end]!); end += 1) {
      const char = text[end]!;
      if (char === "\\" && text[end + 1] === "\\") {
        raw += "\\\\";
        end += 1;
      } else if (char === "\\" && text[end + 1] === quote) {
        raw += quote;
        end += 1;
      } else if (char === quote) break;
      else raw += char;
    }
    const closed = text[end] === quote;
    let after = closed ? end + 1 : end;
    if (closed) after += /^:\d+(?::\d+)?/u.exec(text.slice(after))?.[0].length ?? 0;
    // Keep both source offsets and decoded text: escaped quotes occupy extra terminal cells.
    spans.push({ start, end: after, ...(closed ? { raw: raw + text.slice(end + 1, after) } : {}) });
    start = after - 1;
  }
  return spans;
}

function fileLink(raw: string, start: number, end: number, quoted = false): TerminalFileLinkMatch | undefined {
  if (!raw || raw.startsWith("//") || /(?:^|\s)[a-z][a-z\d+.-]*:\/\//iu.test(raw)) return undefined;
  const position = POSITION.exec(raw);
  // A drive letter's colon is not a position.
  const hasPosition = position !== null && position.index > 1;
  const path = hasPosition ? raw.slice(0, position.index) : raw;
  if (!hasPosition && !EXPLICIT.test(path) && !EXTENSION.test(path)) return undefined;
  if (quoted && !EXPLICIT.test(path)) {
    // Quoting permits spaces and punctuation in names, but still needs a filename or dir/file syntax.
    if (!/^[^\s/\\][^\r\n<>]*$/u.test(path) || (!/[/\\]/u.test(path) && !EXTENSION.test(path))) return undefined;
  }
  const line = hasPosition ? Number(position[1]) : undefined;
  const column = hasPosition && position[2] !== undefined ? Number(position[2]) : undefined;
  return { path, ...(line ? { line } : {}), ...(column ? { column } : {}), start, end };
}

/**
 * File paths with `:line[:column]` inside or after quotes. Quoted paths may
 * contain spaces; unquoted prose keeps the stricter dir/file rules. Quoted
 * ranges cover their delimiters and any outside position, in the original text.
 * Spans overlapping `taken` (URLs) are skipped.
 */
export function findTerminalFileLinks(text: string, taken: ReadonlyArray<{ start: number; end: number }> = []): TerminalFileLinkMatch[] {
  const matches: TerminalFileLinkMatch[] = [];
  const quoted = quotedPaths(text);
  const overlaps = (start: number, end: number, spans: ReadonlyArray<{ start: number; end: number }>) => spans.some((other) => start < other.end && other.start < end);
  for (const span of quoted) {
    if (span.raw === undefined || overlaps(span.start, span.end, taken)) continue;
    const link = fileLink(span.raw, span.start, span.end, true);
    if (link) matches.push(link);
  }
  for (const match of text.matchAll(FILE_PATTERN)) {
    const raw = trimUrl(match[0]);
    const start = match.index;
    const end = start + raw.length;
    if (overlaps(start, end, taken) || overlaps(start, end, quoted)) continue;
    const link = fileLink(raw, start, end);
    if (link) matches.push(link);
  }
  return matches.sort((a, b) => a.start - b.start);
}

const WINDOWS_ROOT = /^(?:[A-Za-z]:[\\/]|\\\\)/u;

function homeOf(cwd: string): string | undefined {
  return /^(?:\/Users|\/home)\/[^/]+/u.exec(cwd)?.[0] ?? /^[A-Za-z]:[\\/]Users[\\/][^\\/]+/u.exec(cwd)?.[0];
}

/**
 * The absolute path (forward slashes) a printed path names when the shell is
 * in `cwd`; `undefined` where that cannot be known: a relative path with no
 * directory, `~` with no home to infer, a path that climbs above the root, or
 * a backslash path in a POSIX shell.
 */
export function resolveTerminalPath(path: string, cwd: string | undefined): string | undefined {
  const windows = WINDOWS_ROOT.test(path) || (cwd !== undefined && WINDOWS_ROOT.test(cwd));
  if (path.includes("\\") && !windows) return undefined;
  let joined = windows ? path.replace(/\\/gu, "/") : path;
  const base = cwd === undefined ? undefined : windows ? cwd.replace(/\\/gu, "/") : cwd;
  if (/^~\//u.test(joined)) {
    const home = cwd === undefined ? undefined : homeOf(base!);
    if (!home) return undefined;
    joined = `${home}${joined.slice(1)}`;
  } else if (!/^(?:\/|[A-Za-z]:\/)/u.test(joined)) {
    if (!base) return undefined;
    joined = `${base.replace(/\/+$/u, "")}/${joined}`;
  }
  const unc = joined.startsWith("//");
  const drive = /^[A-Za-z]:/u.exec(joined)?.[0] ?? "";
  const segments: string[] = [];
  for (const segment of joined.slice(drive.length).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (segments.pop() === undefined) return undefined;
  }
  return `${unc ? "/" : ""}${drive}/${segments.join("/")}`;
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
  readonly length?: number;
  getCell?(column: number): { getChars(): string; getWidth(): number } | undefined;
}

interface LineRow {
  row: number;
  start: number;
  /** UTF-16 offsets mapped to the cells xterm actually draws. */
  cells?: Array<{ offset: number; column: number; width: number }>;
}

export interface WrappedLine {
  text: string;
  /** The 1-based buffer row each part of `text` came from, with its start offset in `text`. */
  rows: LineRow[];
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
    const part = line.translateToString(!continues);
    const mappedRow: LineRow = { row: current, start: text.length };
    // ASCII rows already have one character per column; avoid reading their cells on hover.
    if (/[^\p{ASCII}]/u.test(part) && line.getCell && line.length !== undefined) {
      mappedRow.cells = [];
      let offset = 0;
      for (let column = 0; column < line.length && offset < part.length; column += 1) {
        const cell = line.getCell(column);
        if (!cell) break;
        const width = cell.getWidth();
        if (width === 0) continue;
        mappedRow.cells.push({ offset, column: column + 1, width });
        // Empty cells become spaces in translateToString; wide continuation cells emit nothing.
        offset += cell.getChars().length || 1;
      }
    }
    rows.push(mappedRow);
    text += part;
    if (!continues) break;
  }
  return { text, rows };
}

/** Where offset `index` of a wrapped line sits in the buffer: 1-based row and column. */
export function positionIn(line: WrappedLine, index: number, edge: "start" | "end" = "start"): { x: number; y: number } {
  let at = line.rows[0]!;
  for (const row of line.rows) if (row.start <= index) at = row;
  const offset = index - at.start;
  let cell: NonNullable<LineRow["cells"]>[number] | undefined;
  for (const candidate of at.cells ?? []) {
    if (candidate.offset > offset) break;
    cell = candidate;
  }
  return { x: cell ? cell.column + (edge === "end" ? cell.width - 1 : 0) : offset + 1, y: at.row };
}
