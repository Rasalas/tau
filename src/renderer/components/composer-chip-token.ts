/**
 * Chips live in the draft's text as tokens: an invisible separator, two
 * figure spaces the chip's icon is drawn over, the label, and the separator
 * again. The textarea lays the token out as plain characters and the mirror
 * behind it draws the same characters as a chip, so both wrap alike. Figure
 * spaces and the label's no-break spaces keep a line from breaking inside it.
 * This part is what the send path needs; the rest (`composer-chips.ts`)
 * loads with the chip layer.
 */
export const CHIP_MARK = "\u2063";
/**
 * The text with every chip written as its label (what the model and the
 * history get), or with the chips left out (an answer's own words, when its
 * chips go along as files).
 */
export function plainChipText(text: string, withoutChips = false): string {
  return text.includes(CHIP_MARK)
    ? text.replace(/\u2063\u2007\u2007([^\u2063\n]*)\u2063( ?)/gu, (_token, label: string, space: string) => withoutChips ? "" : label.replaceAll("\u00a0", " ") + space).replaceAll(CHIP_MARK, "")
    : text;
}

