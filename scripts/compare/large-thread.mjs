// Tau alone: a Pi thread of 20,000 session entries in the window, with every
// kit loaded. T3 cannot take part; its importers keep 200 messages at most.
// Per run, two launches from the seeded profile: one opens the thread from
// the rail, one starts with it as the workspace's newest session.
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { realTmp } from "./apps.mjs";

export const LARGE_THREAD_TITLE = "Large Pi thread";
// Beside COMPARE_TAU_ROOT, so a checkout that sets it keeps this profile to itself too.
export const LARGE_THREAD_ROOT = () => process.env.COMPARE_TAU_ROOT
  ? `${process.env.COMPARE_TAU_ROOT}-large-thread`
  : realTmp("tau-harness-large-thread");
/** Four entries a turn: prompt, tool call, tool result, answer. */
export const LARGE_THREAD_TURNS = 5_000;
/** One page more than a thread opens with (10 turns), for the short-thread case. */
export const TWO_PAGE_THREAD_TITLE = "Two-page Pi thread";
export const TWO_PAGE_THREAD_TURNS = 15;
/** Older pages loaded with the reader at the top of the large thread, one after another. */
export const OLDER_PAGES_AT_TOP = 3;

async function sessionManager(tauRoot) {
  const url = pathToFileURL(join(tauRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href;
  return (await import(url)).SessionManager;
}

/**
 * Writes one Pi session into the profile's own session store. `tag` is new
 * each run, so the window cannot show the newest turn from a cache of an
 * earlier run; `modifiedAt` decides whether Pi starts in it.
 */
export async function writePiThread(tauRoot, { sessionDir, cwd, title, turns, tag, modifiedAt }) {
  const SessionManager = await sessionManager(tauRoot);
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendSessionInfo(title);
  const at = Date.now() - turns * 60_000;
  const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (content, offset) => ({ role: "assistant", content, api: "openai-responses", provider: "openai", model: "gpt-5.6-luna", usage, stopReason: "stop", timestamp: at + offset * 15_000 });
  for (let turn = 0; turn < turns; turn += 1) {
    const offset = turn * 4;
    const callId = `call-${turn}`;
    manager.appendMessage({ role: "user", content: [{ type: "text", text: `Question ${turn}: what does file ${turn} contain? ${tag}` }], timestamp: at + offset * 15_000 });
    manager.appendMessage(assistant([{ type: "toolCall", id: callId, name: "bash", arguments: { command: `cat file-${turn}.txt` } }], offset + 1));
    manager.appendMessage({ role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: `line ${turn}\n`.repeat(8) }], isError: false, timestamp: at + (offset + 2) * 15_000 });
    manager.appendMessage(assistant([{ type: "text", text: `File ${turn} holds eight lines that each name the turn.` }], offset + 3));
  }
  const path = manager.getSessionFile();
  utimesSync(path, modifiedAt, modifiedAt);
  return { path, entries: manager.getEntries().length };
}

/** True once a transcript row shows the thread's newest prompt of this run. */
export function newestTurnVisible(messageRow, turns, tag) {
  return `[...document.querySelectorAll(${JSON.stringify(messageRow)})].some((row) => row.textContent.includes(${JSON.stringify(`Question ${turns - 1}:`)}) && row.textContent.includes(${JSON.stringify(tag)}))`;
}

/**
 * Resolves in the page after one "Load older turns" click. Samples, every
 * frame until a second after the label went away, how far the row that led
 * the viewport before the click has moved; a frame without that row counts
 * as the viewport's height.
 */
export const OLDER_PAGE_DRIFT = `new Promise((resolvePromise, rejectPromise) => {
  const scroller = document.getElementById("thread-transcript");
  const button = document.querySelector('[aria-label="Load older turns"]');
  if (!scroller || !button) { rejectPromise(new Error("no transcript or no Load older turns button")); return; }
  const viewportTop = () => scroller.getBoundingClientRect().top;
  const rows = () => [...scroller.querySelectorAll("[data-message-id]")];
  const lead = rows().find((row) => row.getBoundingClientRect().bottom > viewportTop());
  if (!lead) { rejectPromise(new Error("no transcript row in the viewport")); return; }
  const id = lead.dataset.messageId;
  const offset = (row) => row.getBoundingClientRect().top - viewportTop();
  const before = offset(lead);
  const startedAt = performance.now();
  let loading = false;
  let loadedAt;
  let driftPx = 0;
  let lostFrames = 0;
  let frames = 0;
  const tick = () => {
    const row = rows().find((candidate) => candidate.dataset.messageId === id);
    frames += 1;
    if (!row) lostFrames += 1;
    driftPx = Math.max(driftPx, row ? Math.abs(offset(row) - before) : scroller.clientHeight);
    if (document.querySelector('[aria-label="Loading older turns"]')) loading = true;
    else if (loading && loadedAt === undefined) loadedAt = performance.now();
    if (loadedAt !== undefined && performance.now() - loadedAt > 1000) {
      resolvePromise({ driftPx, lostFrames, frames, loadingMs: loadedAt - startedAt });
      return;
    }
    if (performance.now() - startedAt > 30000) { rejectPromise(new Error("older page did not load within 30 s")); return; }
    requestAnimationFrame(tick);
  };
  button.click();
  requestAnimationFrame(tick);
})`;

/** The table's rows: label and the aggregate path it reads. */
export function largeThreadRows() {
  return [
    ["spawn → rail and composer ready, thread active (ms)", "startup.interactiveMs"],
    ["spawn → newest turn visible, thread active (ms)", "startup.newestTurnMs"],
    ["click → newest turn visible (ms)", "open.newestTurnMs"],
    ["load one older page (ms)", "open.olderPageMs"],
    ["older page at the top: \"Loading…\" shown (ms)", "open.olderPageAtTopMs"],
    ["older page at the top: drift of the leading row (px)", "open.olderPageDriftPx"],
    ["older page at the top: frames without the leading row", "open.olderPageLostFrames"],
    ["two-page thread, older page at the top: drift (px)", "open.twoPageDriftPx"],
    ["open: KiB over WebSocket", "open.wire.receivedKiB"],
    ["load average (1 min) at run start", "loadAtStart"],
  ];
}
