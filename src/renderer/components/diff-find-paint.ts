import type { FindMatch } from "./diff-find";

/*
 * Draws find matches with the CSS Custom Highlight API: the rows keep their
 * markup, and a match is a Range over the text the row already has. Each
 * stream paints its own rows; the registry merges them into the two
 * highlights the stylesheet colours.
 */

const painted = new Map<symbol, { all: Range[]; active: Range[] }>();

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

function registry(): { highlights: HighlightRegistry; Highlight: new (...ranges: Range[]) => unknown } | undefined {
  const highlights = (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights;
  const Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return highlights && Highlight ? { highlights, Highlight } : undefined;
}

function publish(): void {
  const found = registry();
  if (!found) return;
  const all = [...painted.values()].flatMap((entry) => entry.all);
  const active = [...painted.values()].flatMap((entry) => entry.active);
  if (all.length > 0) found.highlights.set("diff-find", new found.Highlight(...all)); else found.highlights.delete("diff-find");
  if (active.length > 0) found.highlights.set("diff-find-active", new found.Highlight(...active)); else found.highlights.delete("diff-find-active");
}

/** The range for `start`–`end` characters of the text below `root`, or nothing when the text is shorter. */
export function rangeIn(root: Element, start: number, end: number): Range | undefined {
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  const range = root.ownerDocument.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start < offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += length;
  }
  return undefined;
}

/** Paints the matches of the rendered rows under `container`; `owner` is the stream, which clears its marks by painting nothing. */
export function paintMatches(owner: symbol, container: Element | null, byLine: ReadonlyMap<string, readonly FindMatch[]> | undefined, active: FindMatch | undefined): void {
  if (!registry()) return;
  const entry = { all: [] as Range[], active: [] as Range[] };
  if (container && byLine && byLine.size > 0) {
    for (const row of container.querySelectorAll("[data-find-id]")) {
      const id = row.getAttribute("data-find-id");
      const hits = id === null ? undefined : byLine.get(id);
      if (!hits) continue;
      for (const text of row.querySelectorAll(".diff-text")) {
        for (const hit of hits) {
          const range = rangeIn(text, hit.start, hit.end);
          if (!range) continue;
          entry.all.push(range);
          if (hit === active) entry.active.push(range);
        }
      }
    }
  }
  if (entry.all.length === 0 && !painted.has(owner)) return;
  if (entry.all.length === 0) painted.delete(owner); else painted.set(owner, entry);
  publish();
}

export function clearMatches(owner: symbol): void {
  if (painted.delete(owner)) publish();
}
