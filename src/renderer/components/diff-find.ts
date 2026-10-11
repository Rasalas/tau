import type { UiDiffLine, UiFileDiff } from "../../shared/workspace-kit-types";

export interface FindQuery {
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export const EMPTY_QUERY: FindQuery = { text: "", caseSensitive: false, wholeWord: false, regex: false };

/** One hit in the text of a diff line; `id` is `lineId` of that line. */
export interface FindMatch {
  path: string;
  id: string;
  start: number;
  end: number;
}

export interface FindResult {
  matches: FindMatch[];
  /** The pattern did not compile. */
  invalid?: boolean;
  /** Stopped at `MAX_MATCHES`. */
  capped?: boolean;
}

export const MAX_MATCHES = 5000;

/** A line is told apart by its kind and numbers, so a diff that is read again, or expanded, keeps its ids. */
export const lineId = (path: string, line: UiDiffLine): string => `${line.kind}:${line.oldLine ?? ""}:${line.newLine ?? ""}:${path}`;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export function compileQuery(query: FindQuery): RegExp | "invalid" | undefined {
  if (query.text === "") return undefined;
  const source = query.regex ? query.text : escapeRegex(query.text);
  const bounded = query.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source;
  try {
    return new RegExp(bounded, `gu${query.caseSensitive ? "" : "i"}`);
  } catch {
    return "invalid";
  }
}

/** Every hit in every line of the given diffs, in the order the lines are drawn; a line the split view draws twice counts once. */
export function findInDiffs(diffs: readonly UiFileDiff[], query: FindQuery): FindResult {
  const pattern = compileQuery(query);
  if (!pattern) return { matches: [] };
  if (pattern === "invalid") return { matches: [], invalid: true };
  const matches: FindMatch[] = [];
  for (const diff of diffs) {
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        pattern.lastIndex = 0;
        for (let hit = pattern.exec(line.text); hit; hit = pattern.exec(line.text)) {
          if (hit[0] === "") {
            pattern.lastIndex += 1;
            continue;
          }
          matches.push({ path: diff.path, id: lineId(diff.path, line), start: hit.index, end: hit.index + hit[0].length });
          if (matches.length >= MAX_MATCHES) return { matches, capped: true };
        }
      }
    }
  }
  return { matches };
}

export function groupByLine(matches: readonly FindMatch[]): ReadonlyMap<string, readonly FindMatch[]> {
  const groups = new Map<string, FindMatch[]>();
  for (const match of matches) {
    const group = groups.get(match.id);
    if (group) group.push(match);
    else groups.set(match.id, [match]);
  }
  return groups;
}

/** What a diff surface hands its streams while a find is open. */
export interface DiffFind {
  byLine: ReadonlyMap<string, readonly FindMatch[]>;
  /** The match the reader is on; its stream scrolls to it. */
  active?: FindMatch;
  /** Changes when the reader asks for the active match again, so a stream scrolls back to it. */
  seek: number;
}
