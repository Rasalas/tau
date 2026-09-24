#!/usr/bin/env node
// A simulator of this worktree's own for the app, and nothing else:
//
//   node scripts/sim-device.mjs up [--force]      create, boot, install, launch; starts the sim.mjs bridge
//   node scripts/sim-device.mjs screenshot <file.png>
//   node scripts/sim-device.mjs down              shut down and delete that simulator, stop the bridge
//
// The device and the bridge are recorded in <repo>/.tau-dev/sim-device.json, and only
// they are ever shut down, deleted or stopped. `up` refuses while the machine is busy.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MOBILE = fileURLToPath(new URL("..", import.meta.url));
const DEV_DIR = join(MOBILE, "..", ".tau-dev");
const STATE_PATH = join(DEV_DIR, "sim-device.json");
const APP = join(MOBILE, ".build", "ios", "Build", "Products", "Debug-iphonesimulator", "App.app");
const BUNDLE_ID = "io.github.rasalas.tau";
/** The brief's limit: above this one-minute load, no simulator starts. */
export const MAX_LOAD = 40;

/** The newest available iOS runtime in `xcrun simctl list runtimes -j`. */
export function pickRuntime(list) {
  const runtimes = (list.runtimes ?? []).filter((runtime) => runtime.isAvailable && runtime.platform === "iOS");
  const version = (runtime) => runtime.version.split(".").map(Number);
  runtimes.sort((a, b) => {
    const [left, right] = [version(a), version(b)];
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const diff = (right[index] ?? 0) - (left[index] ?? 0);
      if (diff) return diff;
    }
    return 0;
  });
  if (!runtimes[0]) throw new Error("no iOS simulator runtime is installed (Xcode → Settings → Components)");
  return runtimes[0];
}

/** A plain iPhone the runtime supports, the highest-numbered one: "iPhone 17" over "iPhone 17 Pro" or "iPhone Air". */
export function pickDeviceType(runtime) {
  const phones = (runtime.supportedDeviceTypes ?? []).filter((type) => type.productFamily === "iPhone");
  const plain = phones.filter((type) => /^iPhone \d+$/u.test(type.name)).sort((a, b) => Number(b.name.slice(7)) - Number(a.name.slice(7)));
  const type = plain[0] ?? phones[0];
  if (!type) throw new Error(`${runtime.name} supports no iPhone`);
  return type;
}

export function loadAllows(load, max = MAX_LOAD) {
  return load < max;
}

function simctl(...args) {
  return execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8" }).trim();
}

function readState() {
  return existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : undefined;
}

function deviceExists(udid) {
  return simctl("list", "devices", "-j").includes(`"${udid}"`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function bridgeRuns(pid) {
  try {
    return alive(pid) && execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).includes(join(MOBILE, "scripts", "sim.mjs"));
  } catch {
    return false;
  }
}

async function up(force) {
  const previous = readState();
  if (previous && deviceExists(previous.udid)) throw new Error(`this worktree's simulator ${previous.udid} still exists; run down first`);
  const load = loadavg()[0];
  if (!force && !loadAllows(load)) throw new Error(`the machine's load is ${load.toFixed(0)} (limit ${MAX_LOAD}); wait, or pass --force`);
  if (!existsSync(APP)) throw new Error(`no simulator build at ${APP}; run: node scripts/native-build.mjs ios --dev`);
  const runtime = pickRuntime(JSON.parse(simctl("list", "runtimes", "-j")));
  const type = pickDeviceType(runtime);
  const name = `Tau test ${new Date().toISOString().slice(11, 19)}`;
  const udid = simctl("create", name, type.identifier, runtime.identifier);
  mkdirSync(DEV_DIR, { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify({ udid, name, runtime: runtime.name, type: type.name }, null, 2)}\n`);
  const log = openSync(join(DEV_DIR, "sim-bridge.log"), "a");
  const bridge = spawn(process.execPath, [join(MOBILE, "scripts", "sim.mjs"), "serve"], { detached: true, stdio: ["ignore", log, log] });
  bridge.unref();
  writeFileSync(STATE_PATH, `${JSON.stringify({ udid, name, runtime: runtime.name, type: type.name, bridgePid: bridge.pid }, null, 2)}\n`);
  // Headless: no Simulator window is needed to drive or capture it.
  simctl("boot", udid);
  simctl("bootstatus", udid, "-b");
  simctl("install", udid, APP);
  simctl("launch", udid, BUNDLE_ID);
  return { udid, name, runtime: runtime.name, type: type.name, bridgePid: bridge.pid, load: Number(load.toFixed(1)) };
}

function down() {
  const state = readState();
  if (!state) return { down: null };
  if (deviceExists(state.udid)) {
    try {
      simctl("shutdown", state.udid);
    } catch {
      // Already shut down.
    }
    simctl("delete", state.udid);
  }
  if (state.bridgePid && bridgeRuns(state.bridgePid)) process.kill(state.bridgePid, "SIGTERM");
  rmSync(STATE_PATH, { force: true });
  return { deleted: state.udid, bridgeStopped: state.bridgePid ?? null };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "up") return up(args.includes("--force"));
  if (command === "down") return down();
  if (command === "status") return readState() ?? { device: null };
  if (command === "screenshot") {
    const state = readState();
    if (!state) throw new Error("no simulator; run up first");
    // CoreSimulator writes the file itself and may not reach every volume (seen on an external disk); copy it over.
    const file = resolve(args[0]);
    const temporary = join(tmpdir(), `tau-sim-${process.pid}.png`);
    simctl("io", state.udid, "screenshot", temporary);
    copyFileSync(temporary, file);
    rmSync(temporary, { force: true });
    return { savedTo: file };
  }
  throw new Error("usage: sim-device.mjs up [--force] | status | screenshot <file.png> | down");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify(await main(), null, 1));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
