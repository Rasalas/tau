const MARK = /\p{Mark}/u;
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const LONG_MESSAGE_LINE_LIMIT = 8;
const LONG_MESSAGE_GRAPHEME_LIMIT = 600;
// Sixteen code points covers the largest normal emoji sequence in the product
// (including ZWJ components), with room for variation/modifier extenders.
// Preflight uses this fixed bound before any newline or Segmenter traversal.
const GRAPHEME_CODEPOINT_BUDGET = LONG_MESSAGE_GRAPHEME_LIMIT * 16 + 64;

type HangulJamo = "L" | "V" | "T" | "LV" | "LVT" | undefined;
interface GraphemeCount {
  count: number;
  exhausted: boolean;
  examinedCodePoints: number;
  lineCount: number;
}

function hangulJamoType(codePoint: number): HangulJamo {
  if (codePoint >= 0xac00 && codePoint <= 0xd7a3) return (codePoint - 0xac00) % 28 === 0 ? "LV" : "LVT";
  if ((codePoint >= 0x1100 && codePoint <= 0x115f) || (codePoint >= 0xa960 && codePoint <= 0xa97c)) return "L";
  if ((codePoint >= 0x1160 && codePoint <= 0x11a7) || (codePoint >= 0xd7b0 && codePoint <= 0xd7c6)) return "V";
  if ((codePoint >= 0x11a8 && codePoint <= 0x11ff) || (codePoint >= 0xd7cb && codePoint <= 0xd7fb)) return "T";
  return undefined;
}

function graphemeBudgetFor(limit: number): number {
  return limit <= LONG_MESSAGE_GRAPHEME_LIMIT ? GRAPHEME_CODEPOINT_BUDGET : (limit + 1) * 16 + 64;
}

export function fallbackGraphemeCount(text: string, limit: number): GraphemeCount {
  let count = 0;
  let lineCount = 1;
  let joined = false;
  let hasBase = false;
  let leadingExtenderCluster = false;
  let previousExtendedPictographic = false;
  let regionalIndicators = 0;
  let previousHangul: HangulJamo;
  let scannedCodePoints = 0;
  const codePointBudget = graphemeBudgetFor(limit);

  let codeUnitIndex = 0;
  while (codeUnitIndex < text.length && scannedCodePoints < codePointBudget) {
    const codePoint = text.codePointAt(codeUnitIndex)!;
    const character = String.fromCodePoint(codePoint);
    codeUnitIndex += character.length;
    scannedCodePoints += 1;
    if (character === "\n") {
      lineCount += 1;
      if (lineCount > LONG_MESSAGE_LINE_LIMIT) return { count, exhausted: false, examinedCodePoints: scannedCodePoints, lineCount };
    }
    if (character === "\u200d") {
      // ZWJ may only suppress a break for GB11's pictographic sequence;
      // prevent it from carrying Hangul (or another non-GB11) join forward.
      previousHangul = undefined;
      if (joined) {
        // A second ZWJ has no preceding EP Extend* opportunity to consume.
        joined = false;
        previousExtendedPictographic = false;
      }
      if (hasBase && previousExtendedPictographic) joined = true;
      else if (!hasBase && !leadingExtenderCluster) {
        count += 1;
        leadingExtenderCluster = true;
      }
      if (count > limit) return { count, exhausted: false, examinedCodePoints: scannedCodePoints, lineCount };
      continue;
    }
    const isExtender = MARK.test(character)
      || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
      || (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)
      || (codePoint >= 0xe0020 && codePoint <= 0xe007f);
    if (isExtender) {
      // An extender after ZWJ is still attached to the preceding cluster, but
      // it breaks GB11's EP Extend* ZWJ × EP opportunity.
      if (joined) {
        joined = false;
        previousExtendedPictographic = false;
      }
      if (!hasBase && !leadingExtenderCluster) {
        count += 1;
        leadingExtenderCluster = true;
      }
      if (count > limit) return { count, exhausted: false, examinedCodePoints: scannedCodePoints, lineCount };
      continue;
    }
    const hangul = hangulJamoType(codePoint);
    if (joined) {
      // GB11 only joins a ZWJ to the following Extended_Pictographic. A ZWJ
      // before an ordinary character must not swallow that character into the
      // previous cluster (for example, "👨‍a" has two visible graphemes).
      if (EXTENDED_PICTOGRAPHIC.test(character)) {
        joined = false;
        previousHangul = hangul;
        hasBase = true;
        leadingExtenderCluster = false;
        previousExtendedPictographic = true;
        continue;
      }
      joined = false;
      previousExtendedPictographic = false;
    }
    if (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) {
      regionalIndicators += 1;
      if (regionalIndicators % 2 === 1) count += 1;
    } else {
      regionalIndicators = 0;
      const continuesHangul = (previousHangul === "L" && (hangul === "L" || hangul === "V" || hangul === "LV" || hangul === "LVT"))
        || ((previousHangul === "LV" || previousHangul === "V") && (hangul === "V" || hangul === "T"))
        || ((previousHangul === "LVT" || previousHangul === "T") && hangul === "T");
      if (!continuesHangul) count += 1;
    }
    previousHangul = hangul;
    hasBase = true;
    leadingExtenderCluster = false;
    previousExtendedPictographic = EXTENDED_PICTOGRAPHIC.test(character);
    if (count > limit) return { count, exhausted: false, examinedCodePoints: scannedCodePoints, lineCount };
  }
  if (codeUnitIndex < text.length) return { count: limit + 1, exhausted: true, examinedCodePoints: scannedCodePoints, lineCount };
  return { count, exhausted: false, examinedCodePoints: scannedCodePoints, lineCount };
}

function withinGraphemeBudget(text: string): boolean {
  let examinedCodePoints = 0;
  let codeUnitIndex = 0;
  while (codeUnitIndex < text.length && examinedCodePoints < GRAPHEME_CODEPOINT_BUDGET) {
    const codePoint = text.codePointAt(codeUnitIndex)!;
    codeUnitIndex += codePoint > 0xffff ? 2 : 1;
    examinedCodePoints += 1;
  }
  return codeUnitIndex >= text.length;
}

function segmenterFor(): (new (locales?: string | string[], options?: { granularity: "grapheme" }) => { segment(value: string): Iterable<{ segment: string }> }) | undefined {
  if (typeof Intl === "undefined" || !("Segmenter" in Intl)) return undefined;
  return (Intl as typeof Intl & {
    Segmenter: new (locales?: string | string[], options?: { granularity: "grapheme" }) => { segment(value: string): Iterable<{ segment: string }> };
  }).Segmenter;
}

function segmentWithIntl(text: string, limit: number): GraphemeCount {
  const Segmenter = segmenterFor();
  if (!Segmenter) return fallbackGraphemeCount(text, limit);
  let count = 0;
  let lineCount = 1;
  for (const part of new Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    count += 1;
    for (const character of part.segment) if (character === "\n") lineCount += 1;
    if (count > limit || lineCount > LONG_MESSAGE_LINE_LIMIT) return { count, exhausted: false, examinedCodePoints: 0, lineCount };
  }
  return { count, exhausted: false, examinedCodePoints: 0, lineCount };
}

export function isLongMessage(text: string): boolean {
  if (!withinGraphemeBudget(text)) return true;
  const result = segmentWithIntl(text, LONG_MESSAGE_GRAPHEME_LIMIT);
  return result.exhausted || result.count > LONG_MESSAGE_GRAPHEME_LIMIT || result.lineCount > LONG_MESSAGE_LINE_LIMIT;
}
