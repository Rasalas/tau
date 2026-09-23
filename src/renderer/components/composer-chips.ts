import { CHIP_MARK, CHIP_SLOT, findChipTokens, type ChipToken } from "./composer-chip-token";

export { CHIP_MARK, CHIP_SLOT, findChipTokens, plainChipText, withoutChipTokens, type ChipToken } from "./composer-chip-token";

const OPEN = `${CHIP_MARK}${CHIP_SLOT}`;
const MAX_LABEL = 48;
/** A mention the way the send path expands it, once a space or the end closes it. */
const MENTION = /(^|\s)(@[\w./-]+)(?=\s|$)/gu;

export type MirrorSegment =
  | { kind: "text"; text: string }
  | { kind: "chip"; text: string; label: string }
  | { kind: "mention" | "skill"; text: string };

export function chipLabelText(label: string): string {
  const flat = label.replace(/[\u2063\r\n\t]+/gu, " ").replace(/\s+/gu, " ").trim() || "chip";
  return (flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 1)}…` : flat).replaceAll(" ", "\u00a0");
}

export function chipToken(label: string): string {
  return `${OPEN}${chipLabelText(label)}${CHIP_MARK}`;
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
  const limit = Math.min(previous.length, next.length);
  let common = 0;
  while (common < limit && previous[common] === next[common]) common += 1;
  // Where an edit sits is ambiguous when tokens share characters (deleting the
  // first of two chips): an alignment that leaves every token whole wins.
  const aligned = (prefix: number) => {
    let suffix = 0;
    while (suffix < limit - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
    const changedEnd = previous.length - suffix;
    const inserted = next.slice(prefix, next.length - suffix);
    const cut = tokens.filter((token) => token.start < changedEnd && prefix < token.end && !(token.start >= prefix && token.end <= changedEnd));
    const whole = cut.length === 0 && inserted.split(CHIP_MARK).length - 1 === findChipTokens(inserted).length * 2;
    return { prefix, suffix, changedEnd, inserted, cut, whole };
  };
  const raw = aligned(common);
  if (raw.cut.length === 0) return undefined;
  const snapped = tokenAround(tokens, common)?.start;
  if (snapped !== undefined && aligned(snapped).whole) return undefined;
  const cutStart = Math.min(raw.prefix, ...raw.cut.map((token) => token.start));
  const cutEnd = Math.max(raw.changedEnd, ...raw.cut.map((token) => token.end));
  const inserted = raw.inserted.replaceAll(CHIP_MARK, "");
  let tail = previous.slice(cutEnd);
  // The space the chip was inserted with goes with it, as `removeChipToken` does.
  if (!inserted && tail.startsWith(" ") && (cutStart === 0 || /\s/u.test(previous[cutStart - 1]!))) tail = tail.slice(1);
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
