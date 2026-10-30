import { findWordTokens, foldFindWords, type TranscriptFindMode } from "../../workbench/transcript-find";

const ALL = "transcript-find";
const ACTIVE = "transcript-find-active";
/** Ranges one pass draws at most; a one-letter query in a long thread would otherwise paint thousands. */
const RANGE_LIMIT = 1_500;

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}
type HighlightConstructor = new (...ranges: Range[]) => unknown;

function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightConstructor } | undefined {
  const registry = (globalThis.CSS as { highlights?: HighlightRegistry } | undefined)?.highlights;
  const Highlight = (globalThis as { Highlight?: HighlightConstructor }).Highlight;
  return registry && Highlight ? { registry, Highlight } : undefined;
}

/** Where `needle` stands in `text`, ignoring case; `needle` is already lower case. */
export function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  if (!needle) return found;
  const lower = text.toLowerCase();
  // Lower-casing can change a string's length (some scripts); the offsets would then point elsewhere.
  if (lower.length !== text.length) return found;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) found.push(at);
  return found;
}

/** Folded token offsets still name the original UTF-16 text, including an expanding İ. */
function wordRanges(text: string, tokens: readonly string[]): Array<[number, number]> {
  const folded = foldFindWords(text);
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const char of text) {
    for (let unit = 0; unit < foldFindWords(char).length; unit++) {
      starts.push(offset);
      ends.push(offset + char.length);
    }
    offset += char.length;
  }
  const ranges: Array<[number, number]> = [];
  for (const token of tokens) {
    for (let at = folded.indexOf(token); at >= 0; at = folded.indexOf(token, at + token.length)) {
      ranges.push([starts[at]!, ends[at + token.length - 1]!]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && previous[1] > range[0]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

/**
 * Marks the query in the text the transcript has drawn, the message the find
 * stands on in a stronger colour, with the CSS Custom Highlight API: the DOM is not touched.
 * A match spanning two elements is not marked; the message is still found.
 */
export function highlightTranscript(root: HTMLElement, query: string, activeMessageId: string | undefined, mode?: TranscriptFindMode): void {
  const api = highlightApi();
  if (!api) return;
  const needle = query.trim().toLowerCase();
  const tokens = mode === "all-words" ? findWordTokens(query) : undefined;
  const all: Range[] = [];
  const active: Range[] = [];
  if (needle) {
    for (const row of root.querySelectorAll<HTMLElement>("[data-message-id]")) {
      const target = row.dataset.messageId === activeMessageId ? active : all;
      const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (all.length + active.length >= RANGE_LIMIT) break;
        const parent = node.parentElement;
        if (!parent || parent.closest("script, style, svg")) continue;
        const text = node.nodeValue ?? "";
        const ranges = tokens ? wordRanges(text, tokens) : occurrences(text, needle).map(at => [at, at + needle.length] as const);
        for (const [start, end] of ranges) {
          if (all.length + active.length >= RANGE_LIMIT) break;
          const range = row.ownerDocument.createRange();
          range.setStart(node, start);
          range.setEnd(node, end);
          target.push(range);
        }
      }
    }
  }
  if (all.length + active.length === 0) {
    clearTranscriptHighlights();
    return;
  }
  api.registry.set(ALL, new api.Highlight(...all));
  api.registry.set(ACTIVE, new api.Highlight(...active));
}

export function clearTranscriptHighlights(): void {
  const api = highlightApi();
  api?.registry.delete(ALL);
  api?.registry.delete(ACTIVE);
}
