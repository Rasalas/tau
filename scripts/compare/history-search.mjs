import { click, evaluate, insertText, waitFor } from "./cdp.mjs";
import { clickWhenReady, locate } from "./ui.mjs";

const TITLE = "Long thread: switch fixture";
const QUERY = "Follow-up 2: look at the next part of long thread";
const MESSAGE = `${QUERY}: switch fixture.`;
const HIT = /Long thread: switch fixture, You said: Follow-up 2: look at the next part of long thread: switch fixture\./u;
const TARGET_OPEN = `document.querySelector(".thread-crumb-title")?.textContent.includes(${JSON.stringify(TITLE)})`;

/** Measure the search only when the matching message is actually on screen. */
export async function measureHistorySearch(session) {
  if (await evaluate(session, TARGET_OPEN)) {
    throw new Error("History search must start outside the target thread");
  }
  await clickWhenReady(session, "button.rail-search", /^Search$/u);
  await waitFor(session, `document.activeElement?.matches('[aria-label="Search threads, files and commands"]')`);
  const typed = Date.now();
  await insertText(session, QUERY);
  const hit = await waitFor(session, locate('[role="option"]', HIT));
  const selected = Date.now();
  await click(session, hit.value.x, hit.value.y);
  const reveal = await waitFor(session, `(() => {
    if (!(${TARGET_OPEN})) return null;
    const log = document.querySelector("#thread-transcript");
    const viewport = log?.getBoundingClientRect();
    if (!viewport) return null;
    for (const range of CSS.highlights.get("transcript-find-active") ?? []) {
      const row = range.startContainer.parentElement?.closest("[data-message-id]");
      if (!row || !log.contains(row) || !row.textContent.includes(${JSON.stringify(MESSAGE)})) continue;
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 && rect.top >= viewport.top && rect.bottom <= viewport.bottom) return row.dataset.messageId;
    }
    return null;
  })()`);
  return { resultMs: hit.at - typed, revealMs: reveal.at - selected, totalMs: reveal.at - typed, messageId: reveal.value };
}
