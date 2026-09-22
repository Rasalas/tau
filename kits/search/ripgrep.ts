import { CONTENT_PER_FILE, LINE_PREVIEW, type ContentMatch, type ContentSearchInput } from "./protocol.js";

/** Hidden files are searched and `.git` never is; `.gitignore` decides the rest, in a Git checkout or not. */
export function ripgrepArgs(input: ContentSearchInput): string[] {
  return [
    "--json",
    "--hidden",
    "--no-require-git",
    "--glob", "!.git/",
    "--max-count", String(CONTENT_PER_FILE),
    "--max-filesize", "4M",
    input.caseSensitive ? "--case-sensitive" : "--ignore-case",
    ...(input.regex ? [] : ["--fixed-strings"]),
    ...(input.wholeWord ? ["--word-regexp"] : []),
    "--regexp", input.query,
    "--", ".",
  ];
}

export function ripgrepFileArgs(): string[] {
  return ["--files", "--hidden", "--no-require-git", "--glob", "!.git/", "--", "."];
}

/** `./src/a.ts` as ripgrep prints it, as the project names it. */
export function projectPath(path: string): string {
  return path.replace(/^\.\//u, "").replaceAll("\\", "/");
}

/**
 * The line as a result shows it: without its line break and its indentation,
 * and cut to a window around the first match when it is long. Ranges move with
 * the text; one that falls outside the window is dropped.
 */
export function excerpt(line: string, ranges: ReadonlyArray<[number, number]>, width = LINE_PREVIEW): { text: string; ranges: Array<[number, number]> } {
  const raw = line.replace(/\r?\n$/u, "");
  const indent = raw.length - raw.trimStart().length;
  const body = raw.trim();
  let from = 0;
  let to = body.length;
  if (body.length > width) {
    const anchor = ranges[0] ? ranges[0][0] - indent : 0;
    from = Math.max(0, Math.min(anchor - 40, body.length - width));
    to = from + width;
  }
  const before = from > 0 ? "…" : "";
  const text = `${before}${body.slice(from, to)}${to < body.length ? "…" : ""}`;
  const offset = indent + from - before.length;
  const moved = ranges
    .map(([start, end]): [number, number] => [start - offset, end - offset])
    .filter(([start, end]) => start >= before.length && end <= before.length + (to - from) && end > start);
  return { text, ranges: moved };
}

/** Byte offsets into a UTF-8 line, as string offsets into the same line. */
function stringOffsets(line: string, byteRanges: ReadonlyArray<[number, number]>): Array<[number, number]> {
  if (Buffer.byteLength(line) === line.length) return byteRanges.map(([start, end]) => [start, end]);
  const bytes = Buffer.from(line);
  const at = (offset: number) => bytes.subarray(0, offset).toString().length;
  return byteRanges.map(([start, end]) => [at(start), at(end)]);
}

interface RipgrepText { text?: string; bytes?: string }

function decoded(value: RipgrepText | undefined): string | undefined {
  if (!value) return undefined;
  if (typeof value.text === "string") return value.text;
  return typeof value.bytes === "string" ? Buffer.from(value.bytes, "base64").toString("utf8") : undefined;
}

/** One `--json` line as a match, or `undefined` for every other kind of message. */
export function parseRipgrepLine(raw: string): ContentMatch | undefined {
  if (!raw.startsWith('{"type":"match"')) return undefined;
  let message: { data?: { path?: RipgrepText; lines?: RipgrepText; line_number?: number; submatches?: Array<{ start?: number; end?: number }> } };
  try { message = JSON.parse(raw) as typeof message; } catch { return undefined; }
  const data = message.data;
  const path = decoded(data?.path);
  const line = decoded(data?.lines);
  if (!path || line === undefined || typeof data?.line_number !== "number") return undefined;
  const bytes = (data.submatches ?? [])
    .filter((entry) => typeof entry.start === "number" && typeof entry.end === "number")
    .map((entry): [number, number] => [entry.start!, entry.end!]);
  const cut = excerpt(line, stringOffsets(line, bytes));
  return { path: projectPath(path), line: data.line_number, text: cut.text, ranges: cut.ranges };
}

/** Why ripgrep refused a query, from what it wrote to stderr; its own first line is the useful one. */
export function ripgrepError(stderr: string): string {
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!stderr.includes("regex parse error")) return lines[0] ?? "ripgrep failed.";
  const detail = lines.find((line) => line.startsWith("error:"));
  return `Not a valid regular expression${detail ? `: ${detail.slice("error:".length).trim()}` : "."}`;
}
