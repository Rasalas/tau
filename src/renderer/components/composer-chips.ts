/**
 * Chips live in the draft's text as tokens: an invisible separator, an em
 * space the chip's icon is drawn over, the label, and the separator again.
 * The textarea lays the token out as plain characters and the mirror behind
 * it draws the same characters as a chip, so both wrap alike.
 */
export const CHIP_MARK = "\u2063";
const ICON_SLOT = "\u2003";
const OPEN = `${CHIP_MARK}${ICON_SLOT}`;
const MAX_LABEL = 48;
const TOKEN = /\u2063\u2003([^\u2063\n]*)\u2063/gu;
/** A mention the way the send path expands it, once a space or the end closes it. */
const MENTION = /(^|\s)(@[\w./-]+)(?=\s|$)/gu;

export interface ChipToken {
  start: number;
  end: number;
  label: string;
}

export type MirrorSegment =
  | { kind: "text"; text: string }
  | { kind: "chip"; text: string; label: string }
  | { kind: "mention" | "skill"; text: string };

export function chipLabelText(label: string): string {
  const flat = label.replace(/[\u2063\r\n\t]+/gu, " ").replace(/\s+/gu, " ").trim() || "chip";
  return flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 1)}…` : flat;
}

export function chipToken(label: string): string {
  return `${OPEN}${label}${CHIP_MARK}`;
}

export function findChipTokens(text: string): ChipToken[] {
  if (!text.includes(CHIP_MARK)) return [];
  const tokens: ChipToken[] = [];
  for (const match of text.matchAll(TOKEN)) {
    tokens.push({ start: match.index, end: match.index + match[0].length, label: match[1]! });
  }
  return tokens;
}

/** The text with every chip written as its label: what the model and the history get. */
export function plainChipText(text: string): string {
  return text.includes(CHIP_MARK) ? text.replace(TOKEN, "$1").replaceAll(CHIP_MARK, "") : text;
}

/** A label no other chip of the draft reads: `a.ts`, `a.ts 2`, … */
export function uniqueChipLabel(label: string, taken: ReadonlySet<string>): string {
  const base = chipLabelText(label);
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = chipLabelText(`${base} ${index}`);
    if (!taken.has(candidate)) return candidate;
  }
}

/** Puts tokens at `at`, spaced from the words around them; answers the text and the caret after them. */
export function insertChipTokens(text: string, at: number, labels: readonly string[]): { text: string; caret: number } {
  const position = Math.max(0, Math.min(text.length, at));
  const before = text.slice(0, position);
  const after = text.slice(position);
  const lead = before && !/\s$/u.test(before) ? " " : "";
  const inserted = `${lead}${labels.map(chipToken).join(" ")} `;
  const tail = after.startsWith(" ") ? after.slice(1) : after;
  return { text: `${before}${inserted}${tail}`, caret: position + inserted.length };
}

export function removeChipToken(text: string, token: ChipToken): { text: string; caret: number } {
  // The space the token was inserted with goes with it.
  const end = text[token.end] === " " && (token.start === 0 || /\s/u.test(text[token.start - 1]!)) ? token.end + 1 : token.end;
  return { text: text.slice(0, token.start) + text.slice(end), caret: token.start };
}

/** The token a collapsed caret sits strictly inside, where no caret should rest. */
export function tokenAround(tokens: readonly ChipToken[], position: number): ChipToken | undefined {
  return tokens.find((token) => token.start < position && position < token.end);
}

/**
 * An edit that cut into a token (a Backspace that took its last mark, a word
 * deletion ending inside it) leaves a fragment; the whole chip goes instead.
 * Answers undefined when every token survived whole or went whole.
 */
export function repairChipTokens(previous: string, next: string): { text: string; caret: number } | undefined {
  const tokens = findChipTokens(previous);
  if (tokens.length === 0) return undefined;
  let prefix = 0;
  const limit = Math.min(previous.length, next.length);
  while (prefix < limit && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < limit - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
  const changedEnd = previous.length - suffix;
  let cutStart = prefix;
  let cutEnd = changedEnd;
  let damaged = false;
  for (const token of tokens) {
    // A pure insertion has `changedEnd === prefix`; it damages a token only strictly inside it.
    if (!(token.start < changedEnd && prefix < token.end)) continue;
    if (token.start >= prefix && token.end <= changedEnd) continue;
    damaged = true;
    cutStart = Math.min(cutStart, token.start);
    cutEnd = Math.max(cutEnd, token.end);
  }
  if (!damaged) return undefined;
  const inserted = next.slice(prefix, next.length - suffix).replaceAll(CHIP_MARK, "");
  const tail = previous.slice(cutEnd);
  return { text: previous.slice(0, cutStart) + inserted + tail, caret: cutStart + inserted.length };
}

/**
 * The runs the mirror draws: chips, mentions and the selected skill over
 * plain text. Empty when there is nothing to draw differently.
 */
export function mirrorSegments(text: string, skill?: { start: number; end: number }): MirrorSegment[] {
  const marks: Array<{ start: number; end: number; segment: MirrorSegment }> = [];
  for (const token of findChipTokens(text)) {
    marks.push({ start: token.start, end: token.end, segment: { kind: "chip", text: text.slice(token.start, token.end), label: token.label } });
  }
  if (text.includes("@")) {
    for (const match of text.matchAll(MENTION)) {
      const start = match.index + match[1]!.length;
      marks.push({ start, end: start + match[2]!.length, segment: { kind: "mention", text: match[2]! } });
    }
  }
  if (skill && skill.end > skill.start && skill.end <= text.length) {
    marks.push({ start: skill.start, end: skill.end, segment: { kind: "skill", text: text.slice(skill.start, skill.end) } });
  }
  if (marks.length === 0) return [];
  marks.sort((a, b) => a.start - b.start);
  const segments: MirrorSegment[] = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start < cursor) continue;
    if (mark.start > cursor) segments.push({ kind: "text", text: text.slice(cursor, mark.start) });
    segments.push(mark.segment);
    cursor = mark.end;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}
