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
/** Wheel notches up through rows the virtualizer has not measured yet, and the size of one. */
export const SCROLL_UP_NOTCHES = 60;
export const SCROLL_UP_NOTCH_PX = 240;

async function sessionManager(tauRoot) {
  const url = pathToFileURL(join(tauRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href;
  return (await import(url)).SessionManager;
}

/**
 * Writes one Pi session into the profile's own session store. `tag` is new
 * each run, so the window cannot show the newest turn from a cache of an
 * earlier run; `modifiedAt` decides whether Pi starts in it.
 */
export async function writePiThread(tauRoot, { sessionDir, cwd, title, turns, tag, modifiedAt, endsAt = Date.now() }) {
  const SessionManager = await sessionManager(tauRoot);
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendSessionInfo(title);
  // The rail orders by the newest message, so `endsAt` places the thread in it.
  const at = endsAt - turns * 60_000;
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
 * Resolves in the page once an older page has landed: after the reader jumped
 * to the top of the loaded rows (`jump`), or after a wheel notch the caller
 * sends. Where nothing loads on its own it wheels up once more at the top. Samples,
 * every frame until a second after the label went away, how far the row that
 * led the viewport just before the page landed has moved in the window; a
 * frame without that row counts as the viewport's height.
 */
export const olderPageDrift = ({ jump }) => `new Promise((resolvePromise, rejectPromise) => {
  const scroller = document.getElementById("thread-transcript");
  if (!scroller || !document.querySelector("[data-older-turns]")) { rejectPromise(new Error("no transcript or no older turns")); return; }
  const viewportTop = () => scroller.getBoundingClientRect().top;
  const rows = () => [...scroller.querySelectorAll("[data-message-id]")];
  // In the window, so anything that moves the scroller itself counts too.
  const offset = (row) => row.getBoundingClientRect().top;
  const find = (id) => rows().find((row) => row.dataset.messageId === id);
  const startedAt = performance.now();
  let triggeredAt = startedAt;
  let reference;
  let landed = false;
  let nudged = false;
  let loading = false;
  let loadedAt;
  let driftPx = 0;
  let lostFrames = 0;
  let frames = 0;
  const tick = () => {
    frames += 1;
    const pending = Boolean(document.querySelector('[data-older-turns="loading"]'));
    loading ||= pending;
    if (!landed && reference) {
      // A page can land within one frame, label and all: the reference row's index tells.
      const previous = find(reference.id);
      landed = !previous || Number(previous.dataset.index) > reference.index;
    }
    if (landed && !pending && loadedAt === undefined) loadedAt = performance.now();
    if (!landed) {
      const lead = rows().find((row) => row.getBoundingClientRect().bottom > viewportTop());
      if (lead) reference = { id: lead.dataset.messageId, index: Number(lead.dataset.index), offset: offset(lead) };
      if (!loading && !nudged && frames > 10 && scroller.scrollTop <= 0) {
        scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
        nudged = true;
        triggeredAt = performance.now();
      }
    }
    if (landed && reference) {
      const row = find(reference.id);
      if (!row) lostFrames += 1;
      driftPx = Math.max(driftPx, row ? Math.abs(offset(row) - reference.offset) : scroller.clientHeight);
    }
    if (loadedAt !== undefined && performance.now() - loadedAt > 1000) {
      resolvePromise({ driftPx, lostFrames, frames, loadingMs: loadedAt - triggeredAt, nudged });
      return;
    }
    if (performance.now() - startedAt > 30000) { rejectPromise(new Error("older page did not load within 30 s")); return; }
    requestAnimationFrame(tick);
  };
  if (${jump}) scroller.scrollTop = 0;
  requestAnimationFrame(tick);
})`;

/** In the page: the row that leads the transcript's viewport, in window coordinates. */
export const LEAD_ROW = `(() => {
  const scroller = document.getElementById("thread-transcript");
  const box = scroller.getBoundingClientRect();
  const lead = [...scroller.querySelectorAll("[data-message-id]")].find((row) => row.getBoundingClientRect().bottom > box.top);
  return {
    id: lead?.dataset.messageId,
    top: lead?.getBoundingClientRect().top,
    scrollTop: scroller.scrollTop,
    height: scroller.clientHeight,
    hasOlder: Boolean(document.querySelector("[data-older-turns]")),
    x: box.left + box.width / 2,
    y: box.top + box.height / 2,
  };
})()`;

/**
 * In the page, after one wheel notch: resolves once scrollTop has held for six
 * frames and no older page is loading. Every frame, the row that led before the
 * notch has to sit between where it was and where the notch takes it.
 */
export function notchSettled(id, top, expected) {
  return `new Promise((resolvePromise, rejectPromise) => {
  const scroller = document.getElementById("thread-transcript");
  const low = ${top} - 0.5;
  const high = ${top} + ${expected} + 0.5;
  const startedAt = performance.now();
  let last = scroller.scrollTop;
  let still = 0;
  let frames = 0;
  let outsidePx = 0;
  let lostFrames = 0;
  let loadingSeen = false;
  const tick = () => {
    frames += 1;
    const row = [...scroller.querySelectorAll("[data-message-id]")].find((candidate) => candidate.dataset.messageId === ${JSON.stringify(id)});
    if (!row) lostFrames += 1;
    else {
      const current = row.getBoundingClientRect().top;
      outsidePx = Math.max(outsidePx, low - current, current - high);
    }
    const loading = Boolean(document.querySelector('[data-older-turns="loading"]'));
    loadingSeen ||= loading;
    still = scroller.scrollTop === last ? still + 1 : 0;
    last = scroller.scrollTop;
    if (frames >= 6 && still >= 6 && !loading) {
      resolvePromise({ top: row?.getBoundingClientRect().top, outsidePx, lostFrames, loadingSeen, scrollTop: last });
      return;
    }
    if (performance.now() - startedAt > 30000) { rejectPromise(new Error("the transcript did not settle within 30 s")); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})`;
}

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
    ["scrolling up through unmeasured rows: drift (px)", "open.scrollUpDriftPx"],
    ["scrolling up: notches that reached the top with older turns left", "open.scrollUpTopHits"],
    ["scrolling up: older pages loaded on the way", "open.scrollUpPages"],
    ["open: KiB over WebSocket", "open.wire.receivedKiB"],
    ["load average (1 min) at run start", "loadAtStart"],
  ];
}
