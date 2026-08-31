const MARK = /\p{Mark}/u;
export const LONG_MESSAGE_LINE_LIMIT = 8;
const FALLBACK_CODEPOINT_BUDGET_MULTIPLIER = 4;

type HangulJamo = "L" | "V" | "T" | "LV" | "LVT" | undefined;
export interface GraphemeCount {
  count: number;
  exhausted: boolean;
  examinedCodePoints: number;
}

function hangulJamoType(codePoint: number): HangulJamo {
  if (codePoint >= 0xac00 && codePoint <= 0xd7a3) return (codePoint - 0xac00) % 28 === 0 ? "LV" : "LVT";
  if ((codePoint >= 0x1100 && codePoint <= 0x115f) || (codePoint >= 0xa960 && codePoint <= 0xa97c)) return "L";
  if ((codePoint >= 0x1160 && codePoint <= 0x11a7) || (codePoint >= 0xd7b0 && codePoint <= 0xd7c6)) return "V";
  if ((codePoint >= 0x11a8 && codePoint <= 0x11ff) || (codePoint >= 0xd7cb && codePoint <= 0xd7fb)) return "T";
  return undefined;
}

export function fallbackGraphemeCount(text: string, limit: number): GraphemeCount {
  let count = 0;
  let joined = false;
  let regionalIndicators = 0;
  let previousHangul: HangulJamo;
  let hasBase = false;
  let scannedCodePoints = 0;
  const codePointBudget = (limit + 1) * FALLBACK_CODEPOINT_BUDGET_MULTIPLIER;
  for (const character of text) {
    // Check before reading the next code point so every path, including
    // combining marks and ZWJ extenders, is covered by the same hard bound.
    if (scannedCodePoints >= codePointBudget) return { count: limit + 1, exhausted: true, examinedCodePoints: scannedCodePoints };
    scannedCodePoints += 1;
    const codePoint = character.codePointAt(0)!;
    if (character === "\u200d") {
      // A leading ZWJ has no base to join to and therefore starts its own
      // grapheme. ZWJs following a base keep the next base in that cluster.
      if (hasBase) joined = true;
      else count += 1;
      continue;
    }
    const isExtender = MARK.test(character) || (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff);
    if (isExtender) {
      // UAX #29 keeps extenders with a preceding base. At the beginning of
      // text there is no base, so an extender is itself the initial cluster.
      if (!hasBase) count += 1;
      continue;
    }
    const hangul = hangulJamoType(codePoint);
    if (joined) {
      joined = false;
      previousHangul = hangul;
      hasBase = true;
      continue;
    }
    if (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) {
      regionalIndicators += 1;
      if (regionalIndicators % 2 === 1) count += 1;
    } else {
      regionalIndicators = 0;
      // UAX #29 GB6–GB8. Keep these explicit: precomposed LV/LVT syllables
      // participate in the same chains as their decomposed L/V/T forms.
      const continuesHangul = (previousHangul === "L" && (hangul === "L" || hangul === "V" || hangul === "LV" || hangul === "LVT"))
        || ((previousHangul === "LV" || previousHangul === "V") && (hangul === "V" || hangul === "T"))
        || ((previousHangul === "LVT" || previousHangul === "T") && hangul === "T");
      if (!continuesHangul) count += 1;
    }
    previousHangul = hangul;
    hasBase = true;
    if (count > limit) return { count, exhausted: false, examinedCodePoints: scannedCodePoints };
  }
  return { count, exhausted: false, examinedCodePoints: scannedCodePoints };
}

function visibleGraphemeCount(text: string, limit: number): number {
  const Segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
    ? (Intl as typeof Intl & {
      Segmenter: new (locales?: string | string[], options?: { granularity: "grapheme" }) => { segment(value: string): Iterable<unknown> };
    }).Segmenter
    : undefined;
  if (Segmenter) {
    let count = 0;
    for (const _segment of new Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
      count += 1;
      if (count > limit) return count;
    }
    return count;
  }
  const result = fallbackGraphemeCount(text, limit);
  // An exhausted scan is intentionally conservative. Returning the partial
  // count would make a pathological long cluster appear short and bypass
  // the compact-message threshold.
  return result.exhausted ? limit + 1 : result.count;
}

export const LONG_MESSAGE_GRAPHEME_LIMIT = 600;

export function isLongMessage(text: string): boolean {
  let lines = 1;
  for (const character of text) {
    if (character === "\n") {
      lines += 1;
      if (lines > LONG_MESSAGE_LINE_LIMIT) return true;
    }
  }
  return visibleGraphemeCount(text, LONG_MESSAGE_GRAPHEME_LIMIT) > LONG_MESSAGE_GRAPHEME_LIMIT;
}
