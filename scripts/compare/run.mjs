// Tau against a reference app: launches both isolated,
// seeds the same Codex sessions through each onboarding, then measures start,
// a large thread's scroll and one replayed turn over CDP.
// Usage: node scripts/compare/run.mjs [--apps tau,reference] [--runs 5] [--warmup 1] [--seed] [--check] [--out <file>]
//        node scripts/compare/run.mjs --thread-switch [--apps tau,reference] [--runs 5] [--warmup 1] [--check]   (the switch launch alone)
//        node scripts/compare/run.mjs --large-thread [--runs 5] [--warmup 1] [--seed] [--check]   (Tau only)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadavg } from "node:os";
import { fileURLToPath } from "node:url";
import { APPS, assertOwnedRoot, freePort, resetRunFromTemplate, saveTemplate } from "./apps.mjs";
import { click, connect, evaluate, insertText, pressEnter, waitFor, waitForPage } from "./cdp.mjs";
import { openForbiddenFiles } from "./isolation.mjs";
import { FIND_SCROLLER, INSTALL_PROBE, PAINT_TIMINGS, START_BLANK_SAMPLER, STOP_BLANK_SAMPLER, STOP_RECORDING, startRecording } from "./page-probe.mjs";
import { descendants, processTable, stopTree, treeMemory } from "./processes.mjs";
import { writeCodexSessions, sessionPlan } from "./sessions-fixture.mjs";
import { aggregateRuns, frameStats, longTaskStats, round } from "./stats.mjs";
import { buildTurn, END_SENTINEL, FIRST_SENTINEL, summarizeTurn } from "./turn-fixture.mjs";
import {
  LARGE_THREAD_ROOT, LARGE_THREAD_TITLE, LARGE_THREAD_TURNS, LEAD_ROW, OLDER_PAGES_AT_TOP, SCROLL_UP_NOTCH_PX, SCROLL_UP_NOTCHES,
  TWO_PAGE_THREAD_TITLE, TWO_PAGE_THREAD_TURNS, largeThreadRows, newestTurnVisible, notchSettled, olderPageDrift, writePiThread,
} from "./large-thread.mjs";
import { armSwitchProbe, codexTargets, writeAgentPiThread, PI_SWITCH_THREADS, piTargets, STARTER_TITLE, summarizeSwitches, SWITCH_RESULT, threadSwitchRows, WARM_ROUNDS } from "./thread-switch.mjs";
import { clickWhenReady, locate } from "./ui.mjs";
import { machineClass } from "../machine-class.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WINDOW = { width: 1440, height: 900 };
const THREADS = sessionPlan().length;
const LARGE = /Large thread/u;
const TURN_THREAD = /Small thread 1/u;
const PROMPT = "Replay the recorded comparison turn.";
const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export function parseArgs(argv) {
  const options = { apps: ["tau", "reference"], runs: 5, warmup: 1, seed: false, check: false, out: undefined, idleMs: 5_000, scrollSteps: 60, largeThread: false, threadSwitch: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--apps") options.apps = next().split(",").filter(Boolean);
    else if (arg === "--runs") options.runs = Number(next());
    else if (arg === "--warmup") options.warmup = Number(next());
    else if (arg === "--seed") options.seed = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--out") options.out = next();
    else if (arg === "--idle-ms") options.idleMs = Number(next());
    else if (arg === "--large-thread") options.largeThread = true;
    else if (arg === "--thread-switch") options.threadSwitch = true;
    else throw new Error(`unknown flag ${arg} (known: --apps, --runs, --warmup, --seed, --check, --out, --idle-ms, --large-thread, --thread-switch)`);
  }
  // The reference app has no way to hold a Pi session; its importers also stop at 200 messages.
  if (options.largeThread) options.apps = ["tau"];
  for (const id of options.apps) if (!APPS[id]) throw new Error(`unknown app ${id} (known: ${Object.keys(APPS).join(", ")})`);
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error("--runs must be a positive integer");
  return options;
}

/** Launches one app, returns the page session and the moments that matter for start-up. */
export async function start(app, root, { onStage } = {}) {
  const port = await freePort();
  const spawnedAt = Date.now();
  const child = await app.launch(root, { port });
  const exited = new Promise((resolvePromise) => child.once("exit", (code, signal) => resolvePromise({ code, signal })));
  try {
    const page = await Promise.race([
      waitForPage(port, { accept: app.isAppPage, timeoutMs: 90_000, pollMs: 10 }),
      exited.then((status) => { throw new Error(`${app.label} exited during start: ${JSON.stringify(status)}`); }),
    ]);
    const session = await connect(page.webSocketDebuggerUrl);
    onStage?.("connected", Date.now() - spawnedAt);
    return { child, port, session, spawnedAt };
  } catch (error) {
    await stopTree([child.pid]);
    throw error;
  }
}

/**
 * Both apps render the same viewport. Electron's DevTools has no Browser
 * window domain, so the page's metrics are overridden instead of the window.
 */
async function setViewport(session) {
  await session.send("Emulation.setDeviceMetricsOverride", { ...WINDOW, deviceScaleFactor: 2, mobile: false });
}

function sentKind(response) {
  if (response.opcode === 2) return "binary";
  try {
    const frame = JSON.parse(response.payloadData);
    const request = frame.request ?? frame;
    const [extensionId, command] = Array.isArray(request.params) ? request.params : [];
    const method = request.method === "host-extension" ? `host-extension ${extensionId ?? "?"}/${command ?? "?"}` : request.method;
    return [frame.type, method].filter(Boolean).join(" ") || "other";
  } catch {
    return "other";
  }
}

/** WebSocket frames (decoded payload) plus HTTP bodies (encoded), since the reference app also loads snapshots over HTTP. */
function wireCounter(session) {
  const counter = { reset() { Object.assign(this, { received: 0, receivedBytes: 0, sent: 0, sentBytes: 0, sentKinds: {}, http: 0, httpBytes: 0 }); } };
  counter.reset();
  const size = (response) => (response.opcode === 2 ? Buffer.from(response.payloadData, "base64").length : Buffer.byteLength(response.payloadData));
  const httpRequests = new Set();
  session.on("Network.webSocketFrameReceived", ({ response }) => { counter.received += 1; counter.receivedBytes += size(response); });
  session.on("Network.webSocketFrameSent", ({ response }) => {
    counter.sent += 1;
    counter.sentBytes += size(response);
    // Names what a client sends, so a budget overrun points at the call that caused it.
    const kind = sentKind(response);
    counter.sentKinds[kind] = (counter.sentKinds[kind] ?? 0) + 1;
  });
  session.on("Network.requestWillBeSent", ({ requestId, request }) => { if (/^https?:/u.test(request.url)) httpRequests.add(requestId); });
  session.on("Network.loadingFinished", ({ requestId, encodedDataLength }) => {
    if (!httpRequests.delete(requestId)) return;
    counter.http += 1;
    counter.httpBytes += encodedDataLength;
  });
  counter.snapshot = () => ({
    received: counter.received,
    receivedKiB: round(counter.receivedBytes / 1024),
    sent: counter.sent,
    sentKiB: round(counter.sentBytes / 1024),
    sentKinds: { ...counter.sentKinds },
    httpRequests: counter.http,
    httpKiB: round(counter.httpBytes / 1024),
  });
  return counter;
}

async function memory(session, pid) {
  const heap = await session.send("Runtime.getHeapUsage").catch(() => undefined);
  return { ...treeMemory([pid]), rendererHeapMiB: heap ? round(heap.usedSize / 1024 / 1024) : null };
}

export function checkIsolation(pid, label) {
  const pids = descendants(processTable(), [pid]).map((row) => row.pid);
  const forbidden = openForbiddenFiles(pids);
  if (forbidden.length) throw new Error(`${label} opened files in the user's own data:\n${forbidden.join("\n")}`);
  return pids.length;
}

async function openThread(app, session, pattern) {
  await app.revealThreads(session, { clickWhenReady, waitFor, expectedThreads: THREADS });
  const startedAt = Date.now();
  await clickWhenReady(session, app.selectors.threadRowClick, pattern);
  const { at } = await waitFor(session, `document.querySelectorAll(${JSON.stringify(app.selectors.messageRow)}).length > 0`, { timeoutMs: 30_000, pollMs: 10 });
  return at - startedAt;
}

/** Wheel through the large thread: up from the bottom, then back down, one notch per frame. */
async function scrollThread(session, steps) {
  const scroller = await evaluate(session, FIND_SCROLLER);
  if (!scroller) throw new Error("no scrollable transcript found");
  await evaluate(session, INSTALL_PROBE);
  await evaluate(session, startRecording([]));
  await evaluate(session, START_BLANK_SAMPLER);
  for (const direction of [-1, 1]) {
    for (let step = 0; step < steps; step += 1) {
      await session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: scroller.x, y: scroller.y, deltaX: 0, deltaY: direction * 240 });
      await wait(16);
    }
  }
  await wait(500);
  const blank = await evaluate(session, STOP_BLANK_SAMPLER);
  const recording = await evaluate(session, STOP_RECORDING);
  return {
    scrollHeightPx: scroller.scrollHeight,
    frames: frameStats(recording.frames),
    longTasks: longTaskStats(recording.longTasks.map((task) => task.duration)),
    blankSamples: blank.samples,
    blankRatio: blank.samples ? round(blank.blank / blank.samples, 3) : null,
  };
}

async function replayTurn(app, session, wire, turn) {
  await openThread(app, session, TURN_THREAD);
  await wait(1_000);
  const composer = await waitFor(session, locate(app.selectors.composer, /.*/u));
  await click(session, composer.value.x, composer.value.y);
  await insertText(session, PROMPT);
  await wait(300);
  await evaluate(session, INSTALL_PROBE);
  await evaluate(session, startRecording([FIRST_SENTINEL, END_SENTINEL]));
  wire.reset();
  const submittedAt = Date.now();
  await pressEnter(session);
  await waitFor(session, `window.__compareProbe.seen[${JSON.stringify(END_SENTINEL)}] !== undefined`, { timeoutMs: turn.durationMs + 60_000, pollMs: 250 });
  // What the app still does after the last delta: final parse, highlighting, settling.
  await wait(2_000);
  const recording = await evaluate(session, STOP_RECORDING);
  const bytes = wire.snapshot();
  const seen = (sentinel) => recording.seen[sentinel] === undefined ? null : recording.timeOrigin + recording.seen[sentinel] - submittedAt;
  const endAt = recording.seen[END_SENTINEL];
  const streamFrames = recording.frames.filter((frame) => frame <= endAt);
  const afterEnd = recording.longTasks.filter((task) => task.start >= endAt);
  return {
    firstTextMs: round(seen(FIRST_SENTINEL)),
    endVisibleMs: round(seen(END_SENTINEL)),
    replayMs: turn.durationMs,
    streamFrames: frameStats(streamFrames),
    streamLongTasks: longTaskStats(recording.longTasks.filter((task) => task.start < endAt).map((task) => task.duration)),
    afterEndLongTasks: longTaskStats(afterEnd.map((task) => task.duration)),
    wire: bytes,
  };
}

async function measureRun(app, root, options, turn) {
  resetRunFromTemplate(app, root);
  // Recorded, not enforced: a busy machine is a caveat on the numbers, not a reason to stop.
  const loadAtStart = round(loadavg()[0]);
  const stages = {};
  const { child, session, spawnedAt } = await start(app, root, { onStage: (name, ms) => { stages[name] = ms; } });
  try {
    await session.send("Runtime.enable");
    await evaluate(session, INSTALL_PROBE).catch(() => undefined);
    const { value: paints } = await waitFor(session, `(() => { const t = ${PAINT_TIMINGS}; return t.paints.some((p) => p.name === "first-contentful-paint") ? t : null; })()`, { timeoutMs: 60_000, pollMs: 10 });
    const paintAt = (name) => {
      const entry = paints.paints.find((paint) => paint.name === name);
      return entry ? round(paints.timeOrigin + entry.startTime - spawnedAt) : null;
    };
    const ready = await waitFor(session, app.ready(THREADS), { timeoutMs: 90_000, pollMs: 10 });
    const firstPaintMs = paintAt("first-paint");
    const interactiveMs = ready.at - spawnedAt;
    const startup = {
      firstPaintMs,
      firstContentfulPaintMs: paintAt("first-contentful-paint"),
      interactiveMs,
      // What the app does once it shows: the launch before first paint is mostly Electron's own.
      paintToReadyMs: firstPaintMs === null ? null : round(interactiveMs - firstPaintMs),
      pageTargetMs: stages.connected,
    };
    await evaluate(session, INSTALL_PROBE);
    await setViewport(session);
    await session.send("Network.enable");
    const wire = wireCounter(session);
    await wait(options.idleMs);
    const idleMemory = await memory(session, child.pid);
    const processes = checkIsolation(child.pid, app.label);

    wire.reset();
    const openLargeMs = await openThread(app, session, LARGE);
    const historyStartedAt = Date.now();
    const historyPages = await app.loadHistory(session, { evaluate, waitFor });
    const openLargeWire = wire.snapshot();
    const history = { pages: historyPages, ms: Date.now() - historyStartedAt };
    await wait(1_500);
    const scroll = await scrollThread(session, options.scrollSteps);

    const replay = await replayTurn(app, session, wire, turn);
    await wait(options.idleMs);
    const afterTurnMemory = await memory(session, child.pid);
    checkIsolation(child.pid, app.label);
    return { loadAtStart, startup, idleMemory, openLarge: { ms: openLargeMs, history, wire: openLargeWire }, scroll, replay, afterTurnMemory, processes };
  } finally {
    session.close();
    const stopped = await stopTree([child.pid]);
    if (stopped.stillAlive.length) console.error(`[compare] ${app.label}: still alive after stop: ${stopped.stillAlive.join(", ")}`);
  }
}

/** Switches to `target` from the rail and reports what the page probe saw. */
async function switchTo(app, session, target) {
  await evaluate(session, armSwitchProbe({ text: target.text, composer: app.selectors.composer, messageRow: app.selectors.messageRow }));
  await clickWhenReady(session, app.selectors.threadRowClick, target.row);
  const result = await evaluate(session, SWITCH_RESULT);
  if (result.timedOut) {
    const shows = await evaluate(session, `(() => {
      const rows = [...document.querySelectorAll(${JSON.stringify(app.selectors.messageRow)})];
      const row = rows.find((candidate) => candidate.textContent.includes(${JSON.stringify(target.text)}));
      const rect = row?.getBoundingClientRect();
      return { last: rows.slice(-2).map((entry) => entry.textContent.slice(0, 120)), rect: rect && { top: rect.top, bottom: rect.bottom, height: rect.height }, visible: row?.checkVisibility({ opacityProperty: true, visibilityProperty: true }), composer: Boolean(document.querySelector(${JSON.stringify(app.selectors.composer)})), innerHeight };
    })()`).catch((error) => error.message);
    throw new Error(`${app.label}: switching to "${target.title}" did not settle (${JSON.stringify(result)}); the page shows ${JSON.stringify(shows)}`);
  }
  return result;
}

/**
 * A launch of its own, so no earlier step has opened a thread: after the idle
 * wait it opens a starter thread, then switches to every target once (cold)
 * and WARM_ROUNDS times more (warm).
 */
async function measureThreadSwitchRun(app, root, options) {
  resetRunFromTemplate(app, root);
  const loadAtStart = round(loadavg()[0]);
  const targets = [...codexTargets()];
  if (app.id === "tau") {
    const { workspace } = app.paths(root);
    const sessionDir = app.env(root).PI_CODING_AGENT_SESSION_DIR;
    // Tau opens the newest Pi thread at start-up: this one, so the measured ones stay cold.
    await writePiThread(ROOT, { sessionDir, cwd: workspace, title: "Pi start-up thread", turns: 2, tag: "switch", modifiedAt: new Date() });
    for (const [index, thread] of PI_SWITCH_THREADS.entries()) {
      await writeAgentPiThread(ROOT, { sessionDir, cwd: workspace, title: thread.title, turns: thread.turns, endsAt: Date.now() - (12 + index) * 3_600_000 });
    }
    targets.push(...piTargets());
  }
  return withApp(app, root, async (session) => {
    await waitFor(session, app.ready(THREADS), { timeoutMs: 90_000, pollMs: 10 });
    await app.revealThreads(session, { clickWhenReady, waitFor, expectedThreads: THREADS });
    await evaluate(session, INSTALL_PROBE);
    await setViewport(session);
    await wait(options.idleMs);
    const starter = new RegExp(STARTER_TITLE, "u");
    await clickWhenReady(session, app.selectors.threadRowClick, starter);
    await waitFor(session, `[...document.querySelectorAll(${JSON.stringify(app.selectors.messageRow)})].length > 0`, { timeoutMs: 30_000 });
    await wait(1_000);
    const switches = [];
    for (let roundIndex = 0; roundIndex <= WARM_ROUNDS; roundIndex += 1) {
      for (const target of targets) {
        const result = await switchTo(app, session, target);
        switches.push({ round: roundIndex, kind: target.kind, size: target.size, result });
        await wait(300);
      }
    }
    return { loadAtStart, threadSwitch: summarizeSwitches(switches), switches };
  });
}

function switchLine(summary, temperature) {
  return ["short", "medium", "long"].map((size) => summary.codex?.[size]?.[temperature]?.visibleMs ?? "–").join("/") + " ms";
}

/** One launch of `app` from its template; `work` gets the page session and the spawn time. */
async function withApp(app, root, work) {
  const { child, session, spawnedAt } = await start(app, root, {});
  try {
    await session.send("Runtime.enable");
    const result = await work(session, spawnedAt);
    checkIsolation(child.pid, app.label);
    return result;
  } finally {
    session.close();
    const stopped = await stopTree([child.pid]);
    if (stopped.stillAlive.length) console.error(`[compare] ${app.label}: still alive after stop: ${stopped.stillAlive.join(", ")}`);
  }
}

/** Resolves in the page when one older page, asked for with a wheel at the top, has finished loading. */
const LOAD_ONE_OLDER_PAGE = `new Promise((resolvePromise, rejectPromise) => {
  const scroller = document.getElementById("thread-transcript");
  if (!scroller || !document.querySelector("[data-older-turns]")) { rejectPromise(new Error("no older turns")); return; }
  const startedAt = performance.now();
  let loading = false;
  const check = () => {
    if (document.querySelector('[data-older-turns="loading"]')) loading = true;
    else if (loading) { observer.disconnect(); resolvePromise(performance.now() - startedAt); }
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-older-turns"] });
  scroller.scrollTop = 0;
  scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
  check();
  setTimeout(() => { observer.disconnect(); rejectPromise(new Error("older page did not load within 30 s")); }, 30_000);
})`;

/** One wheel notch up over the transcript: the reader's own input, so the tail stops following. */
async function wheelUp(session, deltaY) {
  const { x, y } = await evaluate(session, LEAD_ROW);
  await session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: -deltaY });
}

/** Jumps to the top of the loaded rows, which loads an older page, and reports how far the leading row moved. */
async function olderPageAtTop(session) {
  return evaluate(session, olderPageDrift({ jump: true }));
}

/** One notch up in a thread whose older page is within reach, and how far the leading row moved when it landed. */
async function olderPageOnTheWay(session) {
  const probe = evaluate(session, olderPageDrift({ jump: false }));
  await wait(50);
  await wheelUp(session, SCROLL_UP_NOTCH_PX);
  return probe;
}

/**
 * Wheels up notch by notch from wherever the reader is. Each notch has to move
 * the row that led the viewport by exactly the notch (less where the rows run
 * out), in every frame until the transcript rests, older page or not. Rows
 * the virtualizer measures on the way and pages that land in between must not
 * show. Stops at the thread's first row.
 */
async function scrollUpDrift(session, notches) {
  const result = { driftPx: 0, lostNotches: 0, topHits: 0, pages: 0, notches: 0 };
  for (let notch = 0; notch < notches; notch += 1) {
    const before = await evaluate(session, LEAD_ROW);
    if (before.scrollTop <= 0) {
      if (!before.hasOlder) break;
      // Older turns are left, but nothing loaded them before the reader got here.
      result.topHits += 1;
      if (result.topHits >= 3) break;
    }
    const expected = Math.min(SCROLL_UP_NOTCH_PX, before.scrollTop);
    await session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: before.x, y: before.y, deltaX: 0, deltaY: -SCROLL_UP_NOTCH_PX });
    const after = await evaluate(session, notchSettled(before.id, before.top, expected));
    result.notches += 1;
    if (after.loadingSeen) result.pages += 1;
    if (after.top === undefined) {
      result.lostNotches += 1;
      result.driftPx = Math.max(result.driftPx, before.height);
      continue;
    }
    result.driftPx = Math.max(result.driftPx, Math.abs(after.top - before.top - expected), after.outsidePx);
  }
  return result;
}

/**
 * The large Pi thread, twice per run: opened from the rail while a short
 * thread is the workspace's newest, then active at start-up as its newest.
 * Each launch starts from the seeded profile with a thread written for it.
 */
async function measureLargeThreadRun(app, root, options) {
  const loadAtStart = round(loadavg()[0]);
  const { run, workspace } = app.paths(root);
  const sessionDir = app.env(root).PI_CODING_AGENT_SESSION_DIR;
  const tag = () => `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const write = (fields) => writePiThread(ROOT, { sessionDir, cwd: workspace, title: LARGE_THREAD_TITLE, turns: LARGE_THREAD_TURNS, ...fields });

  resetRunFromTemplate(app, root);
  const openTag = tag();
  const { entries } = await write({ tag: openTag, modifiedAt: new Date(Date.now() - 3_600_000) });
  await write({ title: TWO_PAGE_THREAD_TITLE, turns: TWO_PAGE_THREAD_TURNS, tag: openTag, modifiedAt: new Date(Date.now() - 7_200_000) });
  await write({ title: "Short Pi thread", turns: 2, tag: openTag, modifiedAt: new Date() });
  const open = await withApp(app, root, async (session) => {
    await waitFor(session, app.ready(THREADS), { timeoutMs: 90_000, pollMs: 10 });
    await session.send("Network.enable");
    const wire = wireCounter(session);
    await wait(options.idleMs);
    wire.reset();
    const startedAt = Date.now();
    await clickWhenReady(session, app.selectors.threadRowClick, new RegExp(LARGE_THREAD_TITLE, "u"));
    const shown = await waitFor(session, newestTurnVisible(app.selectors.messageRow, LARGE_THREAD_TURNS, openTag), { timeoutMs: 120_000, pollMs: 10 });
    const openWire = wire.snapshot();
    await wait(1_000);
    const olderPageMs = await evaluate(session, LOAD_ONE_OLDER_PAGE);
    await wait(500);
    const scrollUp = await scrollUpDrift(session, SCROLL_UP_NOTCHES);
    const atTop = [];
    for (let page = 0; page < OLDER_PAGES_AT_TOP; page += 1) atTop.push(await olderPageAtTop(session));
    await clickWhenReady(session, app.selectors.threadRowClick, new RegExp(TWO_PAGE_THREAD_TITLE, "u"));
    await waitFor(session, newestTurnVisible(app.selectors.messageRow, TWO_PAGE_THREAD_TURNS, openTag), { timeoutMs: 30_000, pollMs: 10 });
    await wait(1_000);
    const twoPage = await olderPageOnTheWay(session);
    return {
      newestTurnMs: shown.at - startedAt,
      olderPageMs: round(olderPageMs),
      // The worst of the loads at the top: a jump in any of them is a jump.
      olderPageAtTopMs: round(Math.max(...atTop.map((load) => load.loadingMs))),
      olderPageDriftPx: round(Math.max(...atTop.map((load) => load.driftPx))),
      olderPageLostFrames: Math.max(...atTop.map((load) => load.lostFrames)),
      twoPageDriftPx: round(twoPage.driftPx),
      scrollUpDriftPx: round(scrollUp.driftPx),
      scrollUpTopHits: scrollUp.topHits,
      scrollUpPages: scrollUp.pages,
      scrollUpNotches: scrollUp.notches,
      wire: openWire,
    };
  });

  resetRunFromTemplate(app, root);
  const startTag = tag();
  await write({ tag: startTag, modifiedAt: new Date(Date.now() + 60_000) });
  const startup = await withApp(app, root, async (session, spawnedAt) => {
    const ready = await waitFor(session, app.ready(THREADS), { timeoutMs: 90_000, pollMs: 10 });
    const shown = await waitFor(session, newestTurnVisible(app.selectors.messageRow, LARGE_THREAD_TURNS, startTag), { timeoutMs: 120_000, pollMs: 10 });
    return { interactiveMs: ready.at - spawnedAt, newestTurnMs: shown.at - spawnedAt };
  });
  if (!existsSync(run)) throw new Error(`${app.label}: the run directory vanished`);
  return { loadAtStart, entries, open, startup };
}

/** Imports the session fixture through the app's onboarding and saves the profile as the template. `plan` sizes the fixture. */
export async function seed(app, root, turnFile, plan = {}) {
  rmSync(app.paths(root).run, { recursive: true, force: true });
  rmSync(app.paths(root).template, { recursive: true, force: true });
  const paths = app.prepare(root);
  writeFileSync(join(root, "turn.json"), turnFile);
  const written = writeCodexSessions(paths.sessionsHome, { cwd: paths.workspace, ...plan });
  const { child, session } = await start(app, root, {});
  try {
    await app.seed(session, { clickWhenReady, waitFor, evaluate, expectedThreads: written.length });
    checkIsolation(child.pid, app.label);
    // Let both apps persist what the import wrote before the profile is copied.
    await wait(3_000);
  } finally {
    session.close();
    await stopTree([child.pid]);
  }
  saveTemplate(app, root);
  writeFileSync(join(root, "fixture.json"), `${JSON.stringify(sessionPlan(plan))}\n`);
  console.log(`[compare] ${app.label}: seeded ${written.length} threads into ${root}`);
}

/** A template seeded from another session plan lacks threads this run clicks. */
export function assertSeededPlan(app, root) {
  const file = join(root, "fixture.json");
  const seeded = existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
  if (seeded !== JSON.stringify(sessionPlan())) throw new Error(`${app.label}: ${root} was seeded with another session fixture; run once with --seed`);
}

/**
 * Tau's own budgets (budgets.json): transfer per replayed turn and the host's
 * idle footprint (macOS). The medians must stay at or under them. Timing is
 * not gated here; it depends on the machine.
 */
export function evaluateBudgets(aggregate, budgets) {
  const failures = [];
  for (const [path, limit] of Object.entries(budgets)) {
    const value = aggregate?.[path]?.median;
    if (value === undefined) failures.push(`${path} was not measured`);
    else if (value > limit) failures.push(`${path} median ${value} > budget ${limit}`);
  }
  return failures;
}

export function markdownTable(report) {
  const apps = Object.keys(report.results);
  const rows = [
    ["first paint (ms)", "startup.firstPaintMs"],
    ["rail + composer ready (ms)", "startup.interactiveMs"],
    ["first paint → rail + composer ready (ms)", "startup.paintToReadyMs"],
    ["memory idle, whole tree (MiB)", "idleMemory.totalMiB"],
    ["memory idle, host/server process (MiB)", "idleMemory.byRoleMiB.backend"],
    ["footprint idle, whole tree (MiB, macOS)", "idleMemory.footprintMiB"],
    ["footprint idle, host/server process (MiB, macOS)", "idleMemory.footprintByRoleMiB.backend"],
    ["renderer JS heap idle (MiB)", "idleMemory.rendererHeapMiB"],
    ["open 100-turn thread: first rows visible (ms)", "openLarge.ms"],
    ["load the rest of its history (pages · ms)", "openLarge.history.pages", "openLarge.history.ms"],
    ["open + full history: KiB over WebSocket · HTTP", "openLarge.wire.receivedKiB", "openLarge.wire.httpKiB"],
    ["scroll frame p95 (ms)", "scroll.frames.p95"],
    ["scroll frame p99 (ms)", "scroll.frames.p99"],
    ["scroll frames > 33 ms", "scroll.frames.dropped"],
    ["scroll blank-sample ratio", "scroll.blankRatio"],
    ["turn: first text visible (ms)", "replay.firstTextMs"],
    ["turn: end visible (ms, replay lasts " + (report.turn.durationMs) + ")", "replay.endVisibleMs"],
    ["stream frame p95 (ms)", "replay.streamFrames.p95"],
    ["stream frame p99 (ms)", "replay.streamFrames.p99"],
    ["stream long tasks (count)", "replay.streamLongTasks.count"],
    ["stream long tasks (total ms)", "replay.streamLongTasks.totalMs"],
    ["long tasks after the last delta (ms)", "replay.afterEndLongTasks.totalMs"],
    ["turn: messages received", "replay.wire.received"],
    ["turn: KiB received over WebSocket (decoded) / HTTP", "replay.wire.receivedKiB", "replay.wire.httpKiB"],
    ["turn: messages sent", "replay.wire.sent"],
    ["memory after turn, whole tree (MiB)", "afterTurnMemory.totalMiB"],
    ["renderer JS heap after turn (MiB)", "afterTurnMemory.rendererHeapMiB"],
    ...threadSwitchRows(),
    ["load average (1 min) at run start", "loadAtStart"],
    ["load average (1 min) at the switch launch", "switchLoadAtStart"],
  ];
  const one = (id, path) => {
    const value = report.aggregate[id]?.[path];
    return value ? `${value.median} / ${value.p95}` : "–";
  };
  const cell = (id, ...paths) => paths.map((path) => one(id, path)).join(" · ");
  const header = `| metric (median / p95) | ${apps.map((id) => report.apps[id].app).join(" | ")} |`;
  const lines = [header, `| --- |${apps.map(() => " ---: |").join("")}`];
  for (const [label, ...paths] of rows) lines.push(`| ${label} | ${apps.map((id) => cell(id, ...paths)).join(" | ")} |`);
  return lines.join("\n");
}

/** `--large-thread`: Tau's own table and gate (`tauLargeThread` in budgets.json). */
async function mainLargeThread(options) {
  const app = APPS.tau;
  const root = assertOwnedRoot(LARGE_THREAD_ROOT(), app);
  const turn = buildTurn();
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "turn.json"), JSON.stringify(turn));
  if (options.seed) await seed(app, root, JSON.stringify(turn));
  const results = [];
  for (let run = 0; run < options.warmup + options.runs; run += 1) {
    const warmup = run < options.warmup;
    const result = await measureLargeThreadRun(app, root, options);
    console.log(`[compare] large thread ${warmup ? "warmup" : `run ${run - options.warmup + 1}/${options.runs}`}: open ${result.open.newestTurnMs} ms, start-up ${result.startup.newestTurnMs} ms`);
    if (!warmup) results.push(result);
  }
  const aggregate = aggregateRuns(results);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    machine: machineClass(),
    app: app.describe(),
    window: WINDOW,
    fixture: { title: LARGE_THREAD_TITLE, turns: LARGE_THREAD_TURNS, entries: results[0]?.entries },
    options,
    aggregate,
    results,
  };
  const out = options.out ?? join(ROOT, "reports", `compare-large-thread-${report.generatedAt.replaceAll(/[:.]/gu, "-")}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const lines = ["| metric (median / p95) | Tau |", "| --- | ---: |"];
  for (const [label, path] of largeThreadRows()) lines.push(`| ${label} | ${aggregate[path] ? `${aggregate[path].median} / ${aggregate[path].p95}` : "–"} |`);
  console.log(`\n${lines.join("\n")}\n\nReport: ${out}`);
  if (options.check) {
    const budgets = JSON.parse(readFileSync(fileURLToPath(new URL("./budgets.json", import.meta.url)), "utf8")).tauLargeThread;
    const failures = evaluateBudgets(aggregate, budgets);
    if (failures.length) {
      console.error(`Large-thread budget failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
      process.exitCode = 1;
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.largeThread) return mainLargeThread(options);
  const turn = buildTurn();
  const turnFile = JSON.stringify(turn);
  const roots = Object.fromEntries(options.apps.map((id) => [id, assertOwnedRoot(APPS[id].defaultRoot(), APPS[id])]));
  for (const id of options.apps) {
    const app = APPS[id];
    mkdirSync(roots[id], { recursive: true });
    writeFileSync(join(roots[id], "turn.json"), turnFile);
    if (options.seed) await seed(app, roots[id], turnFile);
    else assertSeededPlan(app, roots[id]);
  }
  const results = Object.fromEntries(options.apps.map((id) => [id, []]));
  // Apps alternate run by run, so drift in machine load hits both alike.
  for (let run = 0; run < options.warmup + options.runs; run += 1) {
    for (const id of run % 2 ? [...options.apps].reverse() : options.apps) {
      const warmup = run < options.warmup;
      const label = `${APPS[id].label} ${warmup ? "warmup" : `run ${run - options.warmup + 1}/${options.runs}`}`;
      const result = options.threadSwitch ? { loadAtStart: round(loadavg()[0]) } : await measureRun(APPS[id], roots[id], options, turn);
      if (!options.threadSwitch) console.log(`[compare] ${label}: ready ${result.startup.interactiveMs} ms, stream p95 ${result.replay.streamFrames.p95} ms, end ${result.replay.endVisibleMs} ms`);
      const switched = await measureThreadSwitchRun(APPS[id], roots[id], options);
      result.threadSwitch = switched.threadSwitch;
      result.switches = switched.switches;
      result.switchLoadAtStart = switched.loadAtStart;
      console.log(`[compare] ${label}: switch cold ${switchLine(switched.threadSwitch, "cold")}, warm ${switchLine(switched.threadSwitch, "warm")} (load ${switched.loadAtStart})`);
      if (!warmup) results[id].push(result);
    }
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    machine: machineClass(),
    apps: Object.fromEntries(options.apps.map((id) => [id, APPS[id].describe()])),
    window: WINDOW,
    turn: { ...summarizeTurn(turn), parameters: turn.parameters },
    fixture: sessionPlan(),
    options,
    aggregate: Object.fromEntries(options.apps.map((id) => [id, aggregateRuns(results[id])])),
    results,
  };
  const out = options.out ?? join(ROOT, "reports", `compare-${report.generatedAt.replaceAll(/[:.]/gu, "-")}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${markdownTable(report)}\n\nReport: ${out}`);
  if (options.check) {
    if (!report.aggregate.tau) throw new Error("--check needs --apps to include tau");
    const budgets = JSON.parse(readFileSync(fileURLToPath(new URL("./budgets.json", import.meta.url)), "utf8"));
    const failures = [
      ...(options.threadSwitch ? [] : evaluateBudgets(report.aggregate.tau, budgets.tau)),
      ...evaluateBudgets(report.aggregate.tau, budgets.tauThreadSwitch ?? {}),
    ];
    if (failures.length) {
      console.error(`Budget failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
      process.exitCode = 1;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[compare] ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
