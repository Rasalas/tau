// Screen-by-screen UI comparison of Tau and the reference app.
// Each screen script brings both apps into the same state and calls `shot`,
// which captures the page in dark and light and measures the named elements.
// Usage: node scripts/compare/screens/run.mjs [--seed] [--apps tau,reference] [--screens 02,05]
//          [--out <dir>] [--theme zinc] [--tag <suffix>] [--schemes dark,light]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APPS } from "../apps.mjs";
import { openApp, seedScreens } from "./harness.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCREENS_DIR = fileURLToPath(new URL("./", import.meta.url));
const WINDOWS_SWIFT = join(SCREENS_DIR, "windows.swift");

export function parseArgs(argv) {
  const options = { apps: ["tau", "reference"], screens: undefined, seed: false, out: join(ROOT, ".scratch", "compare-shots"), theme: undefined, tag: undefined, schemes: ["dark", "light"] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--apps") options.apps = next().split(",").filter(Boolean);
    else if (arg === "--screens") options.screens = next().split(",").filter(Boolean);
    else if (arg === "--seed") options.seed = true;
    else if (arg === "--out") options.out = next();
    else if (arg === "--theme") options.theme = next();
    else if (arg === "--tag") options.tag = next();
    else if (arg === "--schemes") options.schemes = next().split(",").filter(Boolean);
    else throw new Error(`unknown flag ${arg} (known: --apps, --screens, --seed, --out, --theme, --tag, --schemes)`);
  }
  for (const id of options.apps) if (!APPS[id]) throw new Error(`unknown app ${id} (known: ${Object.keys(APPS).join(", ")})`);
  if (options.theme && options.apps.some((id) => id !== "tau")) throw new Error("--theme restyles Tau only; pass --apps tau");
  for (const scheme of options.schemes) if (!["dark", "light"].includes(scheme)) throw new Error(`unknown scheme ${scheme}`);
  return options;
}

/** `02-rail` + state `menu` + app `tau` + tag → `02-rail-menu-tau-zinc-dark.png`. */
export function shotName({ screen, state, app, tag, scheme }) {
  return `${[screen, state, app, tag, scheme].filter(Boolean).join("-")}.png`;
}

export async function loadScreens(filter) {
  const files = readdirSync(SCREENS_DIR).filter((file) => /^\d\d-[\w-]+\.mjs$/u.test(file)).sort();
  const screens = [];
  for (const file of files) {
    const screen = (await import(join(SCREENS_DIR, file))).default;
    if (!filter || filter.some((wanted) => screen.id === wanted || screen.id.startsWith(`${wanted}-`))) screens.push(screen);
  }
  return screens;
}

function popupWindows(pid) {
  const lines = execFileSync("swift", [WINDOWS_SWIFT, String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line)).filter((window) => window.layer > 0 && window.width > 20 && window.height > 20);
}

/** Captures the windows the app's main process has open above its own (a native menu), never the desktop. */
async function captureNativeWindows(pid, path, { timeoutMs = 6_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let popups = popupWindows(pid);
  while (!popups.length && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    popups = popupWindows(pid);
  }
  return popups.map((window, index) => {
    const file = popups.length > 1 ? path.replace(/\.png$/u, `-${index + 1}.png`) : path;
    execFileSync("screencapture", ["-x", "-o", "-l", String(window.id), file]);
    return { file, width: window.width, height: window.height };
  });
}

async function runScreen(screen, id, options, record) {
  const script = screen[id];
  if (!script) {
    record.skipped = screen.skip?.[id] ?? "no script for this app";
    return;
  }
  const ctx = await openApp(id, { fresh: Boolean(screen.fresh), theme: options.theme, beforeLaunch: screen.beforeLaunch, afterClose: screen.afterClose, turn: screen.turn });
  try {
    await ctx.scheme(options.schemes[0]);
    const shot = async (state, { probes = {}, tabs = 0, settleMs = 400 } = {}) => {
      const entry = { state: state ?? null, files: {}, measure: {} };
      for (const scheme of options.schemes) {
        await ctx.scheme(scheme);
        await ctx.wait(settleMs);
        const file = shotName({ screen: screen.id, state, app: id, tag: options.tag, scheme });
        await ctx.screenshot(join(options.out, file));
        entry.files[scheme] = file;
        entry.measure[scheme] = await ctx.measure(probes[id] ?? probes);
      }
      if (tabs) entry.tabOrder = await ctx.tabOrder(tabs);
      record.states.push(entry);
      console.log(`[screens] ${screen.id}${state ? ` ${state}` : ""} ${id}: ${Object.values(entry.files).join(", ")}`);
      return entry;
    };
    const nativeShot = async (state) => {
      const file = join(options.out, shotName({ screen: screen.id, state, app: id, tag: options.tag, scheme: "native" }));
      const captured = await captureNativeWindows(ctx.pid, file);
      record.states.push({ state, native: captured.map((entry) => entry.file.slice(options.out.length + 1)) });
      console.log(`[screens] ${screen.id} ${state} ${id}: ${captured.length} native window(s)`);
      return captured;
    };
    const note = (key, value) => { record.notes[key] = value; };
    await script(ctx, { shot, nativeShot, note });
  } finally {
    await ctx.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.out, { recursive: true });
  if (options.seed) for (const id of options.apps) await seedScreens(id);
  const screens = await loadScreens(options.screens);
  const reportFile = join(options.out, `measurements${options.tag ? `-${options.tag}` : ""}.json`);
  const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, "utf8")) : { screens: {} };
  report.apps = Object.fromEntries(options.apps.map((id) => [id, APPS[id].describe()]));
  let failures = 0;
  for (const screen of screens) {
    report.screens[screen.id] ??= { title: screen.title, apps: {} };
    for (const id of options.apps) {
      const record = { at: new Date().toISOString(), states: [], notes: {} };
      try {
        await runScreen(screen, id, options, record);
      } catch (error) {
        failures += 1;
        record.error = String(error.stack ?? error.message).slice(0, 2_000);
        console.error(`[screens] ${screen.id} ${id} failed: ${error.message}`);
      }
      report.screens[screen.id].apps[id] = record;
      writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    }
  }
  console.log(`[screens] ${screens.length} screen(s), ${failures} failure(s); measurements in ${reportFile}`);
  if (failures) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[screens] ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
