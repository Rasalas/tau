/**
 * The file picker's fuzzy scorer: the query's characters in order, anywhere in
 * the path, scored so that a run of consecutive characters, the start of a
 * word or a path segment and the file name beat the same letters scattered
 * over directories. Spaces in the query are ignored.
 */
export interface FuzzyMatch {
  score: number;
  /** Offsets into the target the query matched, ascending. */
  positions: number[];
}

const MATCH = 16;
const CONSECUTIVE = 18;
const IN_FILE_NAME = 6;
const EXACT_CASE = 1;
const GAP_START = 3;

function isLower(char: string): boolean {
  return char.toLowerCase() === char && char.toUpperCase() !== char;
}

function isUpper(char: string): boolean {
  return char.toUpperCase() === char && char.toLowerCase() !== char;
}

function boundaryBonus(target: string, index: number): number {
  if (index === 0) return 12;
  const previous = target[index - 1]!;
  if (previous === "/") return 12;
  if (previous === "_" || previous === "-" || previous === "." || previous === " ") return 8;
  return isLower(previous) && isUpper(target[index]!) ? 8 : 0;
}

export function fuzzyMatch(query: string, target: string): FuzzyMatch | undefined {
  const needle = query.replace(/\s+/gu, "");
  const n = needle.length;
  const m = target.length;
  if (n === 0) return { score: 0, positions: [] };
  if (n > m) return undefined;
  const lowerNeedle = needle.toLowerCase();
  const lowerTarget = target.toLowerCase();

  let found = 0;
  for (let j = 0; j < m && found < n; j += 1) if (lowerTarget[j] === lowerNeedle[found]) found += 1;
  if (found < n) return undefined;

  const fileName = target.lastIndexOf("/") + 1;
  const scores = new Float64Array(n * m).fill(Number.NEGATIVE_INFINITY);
  const from = new Int32Array(n * m).fill(-1);
  for (let i = 0; i < n; i += 1) {
    // Best `score[i-1][k] + k` over every k < j - 1, so a gap costs one point per skipped character.
    let gapBest = Number.NEGATIVE_INFINITY;
    let gapFrom = -1;
    for (let j = i; j < m; j += 1) {
      if (i > 0 && j >= 2) {
        const previous = scores[(i - 1) * m + j - 2]!;
        if (previous + (j - 2) > gapBest) { gapBest = previous + (j - 2); gapFrom = j - 2; }
      }
      if (lowerTarget[j] !== lowerNeedle[i]) continue;
      const char = MATCH + boundaryBonus(target, j) + (j >= fileName ? IN_FILE_NAME : 0) + (target[j] === needle[i] ? EXACT_CASE : 0);
      const at = i * m + j;
      if (i === 0) {
        scores[at] = char - Math.min(j, 20) * 0.1;
        continue;
      }
      const adjacent = scores[at - m - 1]!;
      const joined = adjacent + char + CONSECUTIVE;
      const gapped = gapBest - (j - 1) - GAP_START + char;
      if (joined >= gapped && adjacent > Number.NEGATIVE_INFINITY) {
        scores[at] = joined;
        from[at] = j - 1;
      } else if (gapFrom >= 0) {
        scores[at] = gapped;
        from[at] = gapFrom;
      }
    }
  }

  let end = -1;
  let best = Number.NEGATIVE_INFINITY;
  for (let j = n - 1; j < m; j += 1) {
    const score = scores[(n - 1) * m + j]!;
    if (score > best) { best = score; end = j; }
  }
  if (end < 0) return undefined;
  const positions = new Array<number>(n);
  for (let i = n - 1, j = end; i >= 0; i -= 1) {
    positions[i] = j;
    j = from[i * m + j]!;
  }
  // A shorter path is the likelier one when the letters tie.
  return { score: best - m * 0.05, positions };
}

/** The best `limit` matches, highest score first, then the shorter path, then by name. */
export function rankFuzzy(paths: readonly string[], query: string, limit: number): Array<{ path: string; positions: number[] }> {
  if (!query.replace(/\s+/gu, "")) {
    return [...paths]
      .sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length || (a < b ? -1 : 1))
      .slice(0, limit)
      .map((path) => ({ path, positions: [] }));
  }
  const matches: Array<{ path: string; positions: number[]; score: number }> = [];
  for (const path of paths) {
    const match = fuzzyMatch(query, path);
    if (match) matches.push({ path, ...match });
  }
  return matches
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1))
    .slice(0, limit)
    .map(({ path, positions }) => ({ path, positions }));
}
