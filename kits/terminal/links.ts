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
  /** The path as printed, without a trailing `:line:column`. */
  path: string;
  line?: number;
  column?: number;
  /** Offsets in the searched text, position included; `end` is exclusive. */
  start: number;
  end: number;
}

// Explicit paths (rooted, `~`, `./`, drive, UNC), or a bare `dir/file` made of plain name characters.
const FILE_PATTERN = /(?<![\w.~/\\-])(?:~[\\/]|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]+|(?<![\w.~/\\-])[\w.-]+(?:[\\/][\w.-]+)+(?::\d+){0,2}/gu;
const POSITION = /:(\d+)(?::(\d+))?$/u;
const EXPLICIT = /^(?:~[\\/]|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\\\)/u;
const EXTENSION = /\.[A-Za-z0-9_-]+$/u;

/**
 * File paths in terminal output, with a trailing `:line[:column]` split off.
 * A bare `dir/name` needs an extension or a position, so `and/or` stays text.
 * Spans overlapping `taken` (URLs) are skipped.
 */
export function findTerminalFileLinks(text: string, taken: ReadonlyArray<{ start: number; end: number }> = []): TerminalFileLinkMatch[] {
  const matches: TerminalFileLinkMatch[] = [];
  for (const match of text.matchAll(FILE_PATTERN)) {
    const raw = trimUrl(match[0]);
    if (raw.length === 0 || raw.startsWith("//") || /^[a-z][a-z\d+.-]*:\/\//iu.test(raw)) continue;
    const start = match.index;
    const end = start + raw.length;
    if (taken.some((other) => start < other.end && other.start < end)) continue;
    const position = POSITION.exec(raw);
    // A drive letter's colon is not a position.
    const hasPosition = position !== null && position.index > 1;
    const path = hasPosition ? raw.slice(0, position.index) : raw;
    if (!hasPosition && !EXPLICIT.test(path) && !EXTENSION.test(path)) continue;
    const first = hasPosition ? Number(position[1]) : undefined;
    const second = hasPosition && position[2] !== undefined ? Number(position[2]) : undefined;
    // `file:12:3` is line 12, column 3; a lone number is the line.
    matches.push({ path, ...(first ? { line: first } : {}), ...(second ? { column: second } : {}), start, end });
  }
  return matches;
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
