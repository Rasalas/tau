/**
 * Chips live in the draft's text as tokens: an invisible separator, two
 * figure spaces the chip's icon is drawn over, the label, and the separator
 * again. The textarea lays the token out as plain characters and the mirror
 * behind it draws the same characters as a chip, so both wrap alike. Figure
 * spaces and the label's no-break spaces keep a line from breaking inside it.
 * This part is what the send path needs; the rest loads with the chip layer.
 */
export const CHIP_MARK = "\u2063";
export const CHIP_SLOT = "\u2007\u2007";
const TOKEN = /\u2063\u2007\u2007([^\u2063\n]*)\u2063/gu;

export interface ChipToken {
  start: number;
  end: number;
  label: string;
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
  return text.includes(CHIP_MARK) ? text.replace(TOKEN, (_token, label: string) => label.replaceAll("\u00a0", " ")).replaceAll(CHIP_MARK, "") : text;
}

/** The text without its chips: an answer's own words, when the chips go along as files. */
export function withoutChipTokens(text: string): string {
  return text.includes(CHIP_MARK) ? text.replace(/\u2063\u2007\u2007[^\u2063\n]*\u2063 ?/gu, "").replaceAll(CHIP_MARK, "") : text;
}

