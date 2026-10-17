// Alternate two pinned Tau production checkouts on the same seeded scratch
// profile. Uses the full comparison's replay and probes; omits its idle,
// large-history scroll and thread-switch scenarios to keep each pair close.
// Run from a scratch checkout outside real app data, with no other harness
// using COMPARE_TAU_ROOT. Both sources must already have production builds.
// Usage: node replay-pairs.mjs <before checkout> <after checkout> <report.json>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { machineClass } from "../machine-class.mjs";
import { evaluate, waitFor } from "./cdp.mjs";
import { stopTree } from "./processes.mjs";
import { assertSeededPlan, checkIsolation, replayTurn, setViewport, start, wireCounter } from "./run.mjs";
import { sessionPlan } from "./sessions-fixture.mjs";
import { aggregateRuns, round } from "./stats.mjs";
import { buildTurn, END_SENTINEL, summarizeTurn } from "./turn-fixture.mjs";

const args = process.argv.slice(2);
if (args.length !== 3) throw new Error("Usage: node replay-pairs.mjs <before checkout> <after checkout> <report.json>");
const [beforeSource, afterSource, output] = args.map((path) => resolve(path));
const cases = {};
for (const [label, source] of [["before", beforeSource], ["after", afterSource]]) {
  const adapter = await import(pathToFileURL(resolve(source, "scripts/compare/apps.mjs")).href);
  const app = adapter.APPS.tau;
  const root = adapter.assertOwnedRoot(app.defaultRoot(), app);
  cases[label] = { app, root, reset: () => adapter.resetRunFromTemplate(app, root) };
}
assert.equal(cases.before.root, cases.after.root, "the same seeded path must back both versions");
const turn = buildTurn();
assertSeededPlan(cases.before.app, cases.before.root);
writeFileSync(join(cases.before.root, "turn.json"), JSON.stringify(turn));
const report = {
  schema: "tau-stream-pairs/1", status: "running", startedAt: new Date().toISOString(),
  harnessCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8" }).trim(),
  machine: machineClass(), apps: Object.fromEntries(Object.entries(cases).map(([label, { app }]) => [label, app.describe()])),
  viewport: { width: 1440, height: 900, deviceScaleFactor: 2 }, fixture: summarizeTurn(turn), sessionPlan: sessionPlan(),
  method: { pairs: 5, warmupPairs: 1, order: "before/after on odd pairs, after/before on even pairs", scenario: "Small thread 1; the full comparison's replayTurn", readyThreads: 7 },
  warmups: [], pairs: [],
};
mkdirSync(dirname(output), { recursive: true });
const save = () => writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);

async function measure(label, screenshot) {
  const { app, root, reset } = cases[label];
  reset();
  const startedAt = new Date().toISOString();
  const loadAtStart = round(loadavg()[0]);
  const run = await start(app, root);
  let result;
  let survivors = [];
  try {
    await waitFor(run.session, app.ready(7), { timeoutMs: 90_000 });
    await setViewport(run.session);
    // Keep resize and its React commit outside the replay, as the full
    // harness's idle window does. This wait is not a timing assertion.
    await new Promise((done) => setTimeout(done, 1_000));
    await run.session.send("Network.enable");
    checkIsolation(run.child.pid, label);
    const replay = await replayTurn(app, run.session, wireCounter(run.session), turn);
    const loadAtEnd = round(loadavg()[0]);
    checkIsolation(run.child.pid, label);
    if (screenshot) {
      const { data } = await run.session.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(screenshot, Buffer.from(data, "base64"));
    }
    // The current app must actually render a full final answer, beyond the
    // sentinel probe's first sight of the end marker.
    assert.equal(await evaluate(run.session, `document.body.textContent.includes(${JSON.stringify(END_SENTINEL)})`), true);
    result = { startedAt, finishedAt: new Date().toISOString(), loadAtStart, loadAtEnd, replay };
  } finally {
    run.session.close();
    const stopped = await stopTree([run.child.pid]);
    survivors = stopped.stillAlive;
    if (survivors.length) console.error(`${label}: processes survived cleanup: ${survivors.join(", ")}`);
  }
  assert.equal(survivors.length, 0, `${label}: cleanup must finish before the next launch`);
  return result;
}

for (const label of ["before", "after"]) {
  const result = await measure(label);
  report.warmups.push({ label, ...result });
  save();
  console.log(`[stream pairs] ${label} warmup: p95 ${result.replay.streamFrames.p95} ms`);
}
for (let index = 0; index < report.method.pairs; index += 1) {
  const order = index % 2 === 0 ? ["before", "after"] : ["after", "before"];
  const pair = { index: index + 1, order };
  for (const label of order) {
    const screenshot = index === report.method.pairs - 1 && label === "after" ? `${output.replace(/\.json$/u, "")}.png` : undefined;
    pair[label] = await measure(label, screenshot);
    console.log(`[stream pairs] ${index + 1}/5 ${label}: p95 ${pair[label].replay.streamFrames.p95} ms, load ${pair[label].loadAtStart}/${pair[label].loadAtEnd}`);
  }
  report.pairs.push(pair);
  save();
}
report.aggregate = Object.fromEntries(["before", "after"].map((label) => [label, aggregateRuns(report.pairs.map((pair) => pair[label]))]));
report.status = "complete";
report.finishedAt = new Date().toISOString();
save();
