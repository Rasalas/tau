// Tau ↔ T3 Code comparison (gap analysis §3.4): launches both apps isolated,
// seeds the same Codex sessions through each onboarding, then measures start,
// a large thread's scroll and one replayed turn over CDP.
// Usage: node scripts/compare/run.mjs [--apps tau,t3] [--runs 5] [--warmup 1] [--seed] [--check] [--out <file>]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const options = { apps: ["tau", "t3"], runs: 5, warmup: 1, seed: false, check: false, out: undefined, idleMs: 5_000, scrollSteps: 60 };
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
    else throw new Error(`unknown flag ${arg} (known: --apps, --runs, --warmup, --seed, --check, --out, --idle-ms)`);
  }
  for (const id of options.apps) if (!APPS[id]) throw new Error(`unknown app ${id} (known: ${Object.keys(APPS).join(", ")})`);
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error("--runs must be a positive integer");
  return options;
}

/** Launches one app, returns the page session and the moments that matter for start-up. */
async function start(app, root, { onStage }) {
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

/** WebSocket frames (decoded payload) plus HTTP bodies (encoded), since T3 also loads snapshots over HTTP. */
function wireCounter(session) {
  const counter = { reset() { Object.assign(this, { received: 0, receivedBytes: 0, sent: 0, sentBytes: 0, http: 0, httpBytes: 0 }); } };
  counter.reset();
  const size = (response) => (response.opcode === 2 ? Buffer.from(response.payloadData, "base64").length : Buffer.byteLength(response.payloadData));
  const httpRequests = new Set();
  session.on("Network.webSocketFrameReceived", ({ response }) => { counter.received += 1; counter.receivedBytes += size(response); });
  session.on("Network.webSocketFrameSent", ({ response }) => { counter.sent += 1; counter.sentBytes += size(response); });
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
    httpRequests: counter.http,
    httpKiB: round(counter.httpBytes / 1024),
  });
  return counter;
}

async function memory(session, pid) {
  const heap = await session.send("Runtime.getHeapUsage").catch(() => undefined);
  return { ...treeMemory([pid]), rendererHeapMiB: heap ? round(heap.usedSize / 1024 / 1024) : null };
}

function checkIsolation(pid, label) {
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
    const startup = { firstPaintMs: paintAt("first-paint"), firstContentfulPaintMs: paintAt("first-contentful-paint"), interactiveMs: ready.at - spawnedAt, pageTargetMs: stages.connected };
    await evaluate(session, INSTALL_PROBE);
    await setViewport(session);
    await session.send("Network.enable");
    const wire = wireCounter(session);
    await wait(options.idleMs);
    const idleMemory = await memory(session, child.pid);
    const processes = checkIsolation(child.pid, app.label);

    wire.reset();
    const openLargeMs = await openThread(app, session, LARGE);
    const openLargeWire = wire.snapshot();
    await wait(1_500);
    const scroll = await scrollThread(session, options.scrollSteps);

    const replay = await replayTurn(app, session, wire, turn);
    await wait(options.idleMs);
    const afterTurnMemory = await memory(session, child.pid);
    checkIsolation(child.pid, app.label);
    return { loadAtStart, startup, idleMemory, openLarge: { ms: openLargeMs, wire: openLargeWire }, scroll, replay, afterTurnMemory, processes };
  } finally {
    session.close();
    const stopped = await stopTree([child.pid]);
    if (stopped.stillAlive.length) console.error(`[compare] ${app.label}: still alive after stop: ${stopped.stillAlive.join(", ")}`);
  }
}

async function seed(app, root, turnFile) {
  rmSync(app.paths(root).run, { recursive: true, force: true });
  rmSync(app.paths(root).template, { recursive: true, force: true });
  const paths = app.prepare(root);
  writeFileSync(join(root, "turn.json"), turnFile);
  const written = writeCodexSessions(paths.sessionsHome, { cwd: paths.workspace });
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
  console.log(`[compare] ${app.label}: seeded ${written.length} threads into ${root}`);
}

/**
 * Tau's own transfer budget per replayed turn (budgets.json): the medians
 * must stay at or under it. Timing is not gated here; it depends on the machine.
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
    ["memory idle, whole tree (MiB)", "idleMemory.totalMiB"],
    ["memory idle, host/server process (MiB)", "idleMemory.byRoleMiB.backend"],
    ["renderer JS heap idle (MiB)", "idleMemory.rendererHeapMiB"],
    ["open 100-turn thread (ms)", "openLarge.ms"],
    ["open 100-turn thread: KiB over WebSocket / HTTP", "openLarge.wire.receivedKiB", "openLarge.wire.httpKiB"],
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
    ["load average (1 min) at run start", "loadAtStart"],
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const turn = buildTurn();
  const turnFile = JSON.stringify(turn);
  const roots = Object.fromEntries(options.apps.map((id) => [id, assertOwnedRoot(APPS[id].defaultRoot(), APPS[id])]));
  for (const id of options.apps) {
    const app = APPS[id];
    mkdirSync(roots[id], { recursive: true });
    writeFileSync(join(roots[id], "turn.json"), turnFile);
    if (options.seed) await seed(app, roots[id], turnFile);
  }
  const results = Object.fromEntries(options.apps.map((id) => [id, []]));
  // Apps alternate run by run, so drift in machine load hits both alike.
  for (let run = 0; run < options.warmup + options.runs; run += 1) {
    for (const id of run % 2 ? [...options.apps].reverse() : options.apps) {
      const warmup = run < options.warmup;
      const result = await measureRun(APPS[id], roots[id], options, turn);
      console.log(`[compare] ${APPS[id].label} ${warmup ? "warmup" : `run ${run - options.warmup + 1}/${options.runs}`}: ready ${result.startup.interactiveMs} ms, stream p95 ${result.replay.streamFrames.p95} ms, end ${result.replay.endVisibleMs} ms`);
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
    const budgets = JSON.parse(readFileSync(fileURLToPath(new URL("./budgets.json", import.meta.url)), "utf8")).tau;
    const failures = evaluateBudgets(report.aggregate.tau, budgets);
    if (failures.length) {
      console.error(`Transfer budget failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
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
