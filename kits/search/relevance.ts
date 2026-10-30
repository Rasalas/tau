/** Literal matches stay searchable; word boundaries decide their order. */
const LETTER_OR_NUMBER_START = /^[\p{L}\p{N}\p{M}]/u;
const LOWER_END = /\p{Ll}$/u;
const UPPER_END = /\p{Lu}$/u;
const UPPER_START = /^\p{Lu}/u;
const DIGIT_END = /\p{N}$/u;
const DIGIT_START = /^\p{N}/u;
const CJK_START = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function wordStart(text: string, at: number): boolean {
  if (at === 0) return true;
  const before = text.slice(Math.max(0, at - 2), at);
  const after = text.slice(at, at + 4);
  return !/[\p{L}\p{N}\p{M}]$/u.test(before)
    || (LOWER_END.test(before) && UPPER_START.test(after))
    || (UPPER_END.test(before) && /^\p{Lu}\p{Ll}/u.test(after))
    || DIGIT_END.test(before) !== DIGIT_START.test(after)
    || CJK_START.test(after);
}

/** Locale-independent scalar lowercase. No accent or compatibility folding.
 * Both sigma forms use σ in every position, so chunk boundaries cannot change a match.
 */
export function foldSearchText(text: string): string {
  return text.replace(/[Σς]/gu, "σ").toLowerCase();
}

/** Offsets always name original UTF-16 characters, even when İ expands. */
export function tokenMatch(text: string, token: string, before = text.length + 1, from = 0): { rank: number; at: number; length: number } | undefined {
  if (!token) return undefined;
  const lower = foldSearchText(text);
  let offsets: number[] | undefined;
  if (lower.length !== text.length) {
    offsets = [];
    let at = 0;
    for (const char of text) {
      const folded = foldSearchText(char);
      for (let unit = 0; unit < folded.length; unit += 1) offsets.push(at);
      at += char.length;
    }
    offsets.push(text.length);
  }
  let best: { rank: number; at: number; length: number } | undefined;
  for (let at = lower.indexOf(token); at !== -1; at = lower.indexOf(token, at + 1)) {
    const startAt = offsets?.[at] ?? at;
    if (startAt >= before) break;
    if (startAt < from) continue;
    const foldedEnd = at + token.length;
    const end = offsets ? (offsets[foldedEnd] === offsets[foldedEnd - 1] ? (offsets[foldedEnd] ?? text.length) + 1 : offsets[foldedEnd]!) : foldedEnd;
    const start = !LETTER_OR_NUMBER_START.test(token) || wordStart(text, startAt);
    const whole = end === text.length || !LETTER_OR_NUMBER_START.test(text.slice(end, end + 2)) || wordStart(text, end);
    const rank = start ? whole ? 3 : 2 : 1;
    if (rank > (best?.rank ?? 0)) best = { rank, at: startAt, length: end - startAt };
    if (rank === 3) break;
  }
  return best;
}

/** 3: whole word, 2: word prefix, 1: substring, 0: absent. No fuzzy filtering. */
export function tokenRank(text: string, token: string): number {
  return tokenMatch(text, token)?.rank ?? 0;
}

/** A snippet points at the occurrence that earned the match, rather than an earlier substring. */
export function textMatch(text: string, tokens: readonly string[], phrase = tokens.join(" ")): { quality: number; at: number; length: number } | undefined {
  if (!tokens.length) return undefined;
  const matches = tokens.map((token) => tokenMatch(text, token));
  if (matches.some((match) => !match)) return undefined;
  const quality = Math.min(...matches.map((match) => match!.rank));
  const whole = tokens.length === 1 ? matches[0] : tokenMatch(text, phrase);
  const phraseMatch = whole && whole.rank >= quality ? whole : undefined;
  return { quality: quality * 10 + Number(Boolean(phraseMatch)), at: phraseMatch?.at ?? matches[0]!.at, length: phraseMatch?.length ?? matches[0]!.length };
}

/** Title, branch and project remain jointly searchable, in that priority order. */
export function threadRank(tokens: readonly string[], title: string, branch = "", project = ""): number {
  if (!tokens.length) return 0;
  if (foldSearchText(title).trim().split(/\s+/u).join(" ") === tokens.join(" ")) return 100;
  const fields = [title, branch, project];
  const matches = tokens.map((token) => fields.map((field) => tokenRank(field, token)));
  const quality = Math.min(...matches.map((ranks) => Math.max(...ranks)));
  if (!quality) return 0;
  // A token's strongest field wins; titles win within one quality, then branches.
  const fieldWeight = matches.reduce((sum, ranks) => {
    const best = Math.max(...ranks);
    return sum + 3 - ranks.indexOf(best);
  }, 0) / tokens.length;
  return quality * 10 + fieldWeight;
}
