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

/**
 * Marks the query in the text the transcript has drawn, the message the find
 * stands on in a stronger colour, with the CSS Custom Highlight API: the DOM is not touched.
 * A match spanning two elements is not marked; the message is still found.
 */
export function highlightTranscript(root: HTMLElement, query: string, activeMessageId: string | undefined): void {
  const api = highlightApi();
  if (!api) return;
  const needle = query.trim().toLowerCase();
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
        for (const at of occurrences(node.nodeValue ?? "", needle)) {
          const range = row.ownerDocument.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + needle.length);
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
