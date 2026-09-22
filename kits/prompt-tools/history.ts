/**
 * Prompt recall: ↑ in an empty composer walks back through the thread's own
 * prompts and then the project's other threads, ↓ walks forward, and past the
 * newest (or on Escape) the composer is empty again.
 */

// Composer Context sends its chips ahead of the text, a blank line apart;
// recall is the text the user typed, not the context of another turn.
const CONTEXT_BLOCKS: readonly RegExp[] = [
  /^<file path="[^"]*"[^>\n]*\/>/u,
  /^<file path="[^"]*"[^>\n]*>\n[\s\S]*?\n<\/file>/u,
  /^From [^\n]*:\n(?:>[^\n]*(?:\n|$))+/u,
  /^Pull request \[#\d+\]\([^)\s]*\): [^\n]*/u,
  /^The user attached [^\n]*? It is at [^\n]*; read it from there\./u,
];
const SKILL_ENVELOPE = /^<skill name="([^"]+)"[^>\n]*>\n[\s\S]*?\n<\/skill>[ \t]*(?:\n+|$)/u;

/** The part of a sent message worth typing again; empty when there is none. */
export function recallablePrompt(text: string): string {
  let rest = text.trim();
  const skill = SKILL_ENVELOPE.exec(rest);
  if (skill) rest = `/skill:${skill[1]} ${rest.slice(skill[0].length)}`.trim();
  for (;;) {
    const block = CONTEXT_BLOCKS.map((pattern) => pattern.exec(rest)).find((match) => match !== null);
    if (!block) return rest;
    rest = rest.slice(block[0].length).trimStart();
  }
}

/** Newest first, each prompt once, where it was sent last. */
export function buildHistory(...sources: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const source of sources) {
    for (const raw of source) {
      const prompt = recallablePrompt(raw);
      if (!prompt || seen.has(prompt)) continue;
      seen.add(prompt);
      entries.push(prompt);
    }
  }
  return entries;
}

/** Where recall stands: the entry put into the composer, and the text it put there. */
export interface HistoryPosition {
  index: number;
  recalled: string;
}

export type HistoryDirection = "back" | "forward" | "clear";

/**
 * One step, or `undefined` when the key is not recall's to take: an edited
 * recall ends browsing, and ↑ starts it only from an empty composer. At the
 * oldest entry ↑ stays put; past the newest ↓ empties the composer.
 */
export function stepHistory(
  direction: HistoryDirection,
  entries: readonly string[],
  position: HistoryPosition | undefined,
  text: string,
): { position?: HistoryPosition; text: string } | undefined {
  // The list may have grown since the last step; find the recalled entry again.
  const active = position?.recalled !== text ? -1
    : entries[position.index] === text ? position.index : entries.indexOf(text);
  if (direction === "back") {
    if (active < 0 && text !== "") return undefined;
    const next = entries[active + 1];
    if (next === undefined) return active < 0 ? undefined : { position: { index: active, recalled: text }, text };
    return { position: { index: active + 1, recalled: next }, text: next };
  }
  if (active < 0) return undefined;
  if (direction === "clear" || active === 0) return { text: "" };
  const newer = entries[active - 1]!;
  return { position: { index: active - 1, recalled: newer }, text: newer };
}
