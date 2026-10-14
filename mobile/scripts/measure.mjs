#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { parseOptions, parseStartOutput, parseWebView, selectTargets, summarize, markdown } from "./measure-results.mjs";
import { defaultTargets, seedFixtures } from "./measure-fixtures.mjs";
import { expression, listState, backToList, openThread } from "./measure-probes.mjs";
import { readTestHost, testHostDir } from "../../scripts/tau-test-host.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PACKAGE = "de.tbuck.tau";
const APK = join(ROOT, "mobile/android/app/build/outputs/apk/debug/app-debug.apk");
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const run = (command, args) => execFileSync(command, args, { cwd: ROOT, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }).trim();

async function evaluate(options, expr, timeoutMs = options.timeoutMs) {
  const response = await fetch(`http://127.0.0.1:${options.bridgePort}/eval`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ expr, timeoutMs }), signal: AbortSignal.timeout(timeoutMs + 2_000),
  });
  if (!response.ok) throw new Error(`Bridge HTTP ${response.status}`);
  const reply = await response.json();
  if (reply.error) throw new Error(reply.error);
  return reply.result;
}

async function waitForList(options, hostId, previousOrigin) {
  const deadline = performance.now() + options.timeoutMs;
  while (performance.now() < deadline) {
    // A force-stop disconnects the old bridge; wait for the new page's socket.
    const state = await evaluate(options, expression(listState), 2_000).catch(() => null);
    if (state?.ready && state.origin !== previousOrigin && state.hostId === hostId && Number.isFinite(state.listPaintMs)) return state;
    await wait(100);
  }
  throw new Error("No usable list with a new WebView origin on the isolated host; check pairing, bridge and Dev-APK");
}

function instanceHost(options) {
  if (options.testHost) {
    readTestHost(options.testHost);
    return readFileSync(join(testHostDir(options.testHost), "userdata/host-id"), "utf8").trim();
  }
  const instance = JSON.parse(readFileSync(join(ROOT, ".tau-dev/instance.json"), "utf8"));
  const owned = join(ROOT, ".tau-dev") + "/";
  if (!instance.userData?.startsWith(owned) || !instance.sessionsDir?.startsWith(owned) || !instance.agentDir?.startsWith(owned)) throw new Error("Use this worktree's isolated instance with isolated sessions and agent directory");
  process.kill(instance.pid, 0);
  if (!instance.hostPid) throw new Error("The isolated host is not ready");
  process.kill(instance.hostPid, 0);
  return readFileSync(join(instance.userData, "host-id"), "utf8").trim();
}

async function measure(options) {
  const adb = (...args) => run("adb", ["-s", options.serial, ...args]);
  if (adb("get-state") !== "device" || adb("shell", "getprop", "ro.kernel.qemu") !== "1") throw new Error("The selected target is not a running Android emulator");
  const avd = adb("emu", "avd", "name").split(/\r?\n/u)[0];
  if (avd !== options.avd) throw new Error(`Expected AVD ${options.avd}, got ${avd}`);
  const installed = adb("shell", "dumpsys", "package", PACKAGE);
  const app = { version: /versionName=(\S+)/u.exec(installed)?.[1], build: /versionCode=(\d+)/u.exec(installed)?.[1] };
  if (!app.version || !app.build || !/\bDEBUGGABLE\b/u.test(installed)) throw new Error("Install the development debug APK first");
  if (!existsSync(APK)) throw new Error("Build the Dev-APK in this worktree first");
  app.apkSha256 = createHash("sha256").update(readFileSync(APK)).digest("hex");
  const installedApk = adb("shell", "pm", "path", PACKAGE).split(/\r?\n/u).find((line) => line.endsWith("/base.apk"))?.slice(8);
  if (!installedApk || adb("shell", "sha256sum", installedApk).split(/\s+/u)[0] !== app.apkSha256) throw new Error("Installed APK differs from this worktree's build; reinstall it");
  const hostId = instanceHost(options);
  await evaluate(options, expression(backToList, options.timeoutMs));
  const initial = await waitForList(options, hostId);
  const targetsFile = options.targets ?? join(ROOT, ".tau-dev/mobile-measure/targets.json");
  if (options.targets && !existsSync(targetsFile)) throw new Error("The --targets file does not exist");
  const targets = existsSync(targetsFile) ? JSON.parse(readFileSync(targetsFile, "utf8")) : defaultTargets();
  const { selected, skipped } = selectTargets(targets, initial.titles);
  const report = {
    schema: 1, date: new Date().toISOString(), runs: options.runs, warmup: options.warmup,
    commit: run("git", ["rev-parse", "HEAD"]), dirty: Boolean(run("git", ["status", "--porcelain", "--untracked-files=normal"])),
    app, device: { serial: options.serial, avd, api: adb("shell", "getprop", "ro.build.version.sdk"), image: adb("shell", "getprop", "ro.build.fingerprint"), android: adb("shell", "getprop", "ro.build.version.release"), model: adb("shell", "getprop", "ro.product.model"), webview: parseWebView(adb("shell", "dumpsys", "webviewupdate")), emulator: run("emulator", ["-version"]).split(/\r?\n/u)[0] },
    load: { before: run("uptime", []), beforeAverages: loadavg() },
    targets: selected, skipped, samples: [],
  };
  let origin = initial.origin;
  for (let round = 0; round < options.runs + options.warmup; round += 1) {
    for (const target of selected) {
      adb("shell", "am", "force-stop", PACKAGE);
      const start = performance.now();
      const totalMs = parseStartOutput(adb("shell", "am", "start", "-W", "-n", `${PACKAGE}/.MainActivity`));
      const state = await waitForList(options, hostId, origin);
      const observedMs = performance.now() - start;
      origin = state.origin;
      const cold = await evaluate(options, expression(openThread, target, options.timeoutMs));
      if (cold.origin !== origin) throw new Error("WebView reloaded while opening the cold thread");
      await evaluate(options, expression(backToList, options.timeoutMs));
      const warm = await evaluate(options, expression(openThread, target, options.timeoutMs));
      if (warm.origin !== origin) throw new Error("WebView reloaded while opening the warm thread");
      await evaluate(options, expression(backToList, options.timeoutMs));
      report.samples.push({ round, warmup: round < options.warmup, size: target.size, launch: { totalMs, listPaintMs: state.listPaintMs, observedMs, timeOrigin: origin }, coldMs: cold.ms, warmMs: warm.ms });
      console.log(`[measure] ${round < options.warmup ? "warm-up" : "measured"} round ${round + 1} ${target.size}: start ${totalMs} ms, list ${state.listPaintMs.toFixed(1)} ms, cold ${cold.ms.toFixed(1)} ms, warm ${warm.ms.toFixed(1)} ms`);
    }
  }
  report.load.after = run("uptime", []);
  report.load.afterAverages = loadavg();
  report.summary = summarize(report.samples);
  const date = report.date.replaceAll(":", "-").replace(/\.\d+Z$/u, "Z");
  const jsonPath = join(ROOT, "reports", `mobile-${date}.json`);
  const markdownPath = join(ROOT, "docs/performance", `mobile-emulator-${date}.md`);
  for (const path of [jsonPath, markdownPath]) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  writeFileSync(markdownPath, markdown(report), { flag: "wx" });
  console.log(JSON.stringify({ json: jsonPath, markdown: markdownPath }, null, 2));
}

async function main(args) {
  if (args[0] === "--help") {
    console.log("Usage: node mobile/scripts/measure.mjs [--runs 5] [--warmup 1] [--serial emulator-5554] [--avd tau_play_review] [--bridge-port 9477] [--timeout-ms 30000] [--targets file.json] [--test-host name]\n       node mobile/scripts/measure.mjs seed [--test-host name]\nRunbook: docs/mobile-emulator-measurement.md");
    return;
  }
  if (args[0] === "seed") {
    if (args.length !== 1 && !(args.length === 3 && args[1] === "--test-host")) throw new Error("Usage: measure.mjs seed [--test-host name]");
    console.log(JSON.stringify(await seedFixtures(ROOT, args[2]), null, 2));
    return;
  }
  await measure(parseOptions(args));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(`[measure] ${error.message}`); process.exitCode = 1; });
}
