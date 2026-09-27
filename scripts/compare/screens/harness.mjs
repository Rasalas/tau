// Opens one app for the screen comparison (gap analysis §2.3) and gives screen
// scripts a small, app-neutral vocabulary: find, click, press, type, capture.
// Launch, seeding and the isolation checks are the benchmark's own (../run.mjs).
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APPS, assertOwnedRoot, realTmp, resetRunFromTemplate } from "../apps.mjs";
import { click, evaluate, insertText, waitFor } from "../cdp.mjs";
import { locate } from "../ui.mjs";
import { checkIsolation, seed, start } from "../run.mjs";
import { stopTree } from "../processes.mjs";
import { buildTurn } from "../turn-fixture.mjs";
import { keySpec, parseChord } from "../../tau-cdp.mjs";
import { MEASURE, TAB_ORDER } from "./measure.mjs";

export const VIEWPORT = { width: 1440, height: 900 };
const TAU_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const EDIT_COMMANDS = { "mod+a": ["selectAll"] };
const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** 30 threads, so the rail has enough rows to pin, snooze and settle some (screen 02). */
export const SCREEN_PLAN = { largeTurns: 100, smallThreads: 29, smallTurns: 4, switchThreads: false };

/**
 * A short, slow turn: slow enough to capture thinking, a running command and
 * the answer mid-stream; its answer has two fences and one table (screen 05).
 */
export const SCREEN_TURN = { answerBytes: 13_000, codeBlocks: 2, bigOutputBytes: 24_000, smallCommands: 3, outputChunkBytes: 2_048, textDeltaChars: 600, intervalMs: 250, thinkingChars: 1_200 };

/** A seeded profile is ready once the kits drew the rail and the title bar, and the composer is mounted. */
const READY = {
  tau: `document.querySelectorAll("article.thread-row").length >= 5 && !!document.querySelector(".region-title-bar button") && !!document.querySelector("textarea")`,
  t3: `!!document.querySelector("[data-testid=composer-editor]") && !!document.querySelector("[data-testid=sidebar-settled-header], [data-testid=sidebar-row-card]")`,
};

/**
 * Roots of their own, so a screen pass never shares a profile with a benchmark run.
 * `COMPARE_SCREENS_ROOT` (under /tmp) gives a parallel checkout its own pair;
 * `COMPARE_SCREENS_ROOT_TAG` does the same with a suffix on the default roots.
 */
export function screenRoot(id) {
  const tag = process.env.COMPARE_SCREENS_ROOT_TAG?.replace(/[^\w-]/gu, "");
  const prefix = process.env.COMPARE_SCREENS_ROOT ?? realTmp(`compare-screens${tag ? `-${tag}` : ""}`);
  return assertOwnedRoot(`${prefix}-${id}`, APPS[id]);
}

export function screenTurnFile(overrides = {}) {
  return JSON.stringify(buildTurn({ ...SCREEN_TURN, ...overrides }));
}

export async function seedScreens(id) {
  const root = screenRoot(id);
  mkdirSync(root, { recursive: true });
  const turnFile = screenTurnFile();
  writeFileSync(join(root, "turn.json"), turnFile);
  await seed(APPS[id], root, turnFile, SCREEN_PLAN);
}

/** A theme package from examples/, dropped into the isolated home's packages (a theme needs no grant). */
function installTheme(root, theme) {
  const source = join(TAU_ROOT, "examples", `theme-${theme}`);
  const target = join(APPS.tau.paths(root).run, "home", ".tau", "extensions", `theme-${theme}`);
  cpSync(source, target, { recursive: true });
}

/**
 * Launches `id` from a fresh copy of its seeded profile at 1440×900, DPR 2.
 * Every open and close checks that no process of the tree has a file open in
 * the user's own data.
 */
export async function openApp(id, { theme, fresh = false, beforeLaunch, afterClose, turn } = {}) {
  const app = APPS[id];
  const root = screenRoot(id);
  let sessionsHome;
  if (fresh) {
    // No seeded profile: the first-run state (screen 11).
    rmSync(app.paths(root).run, { recursive: true, force: true });
    ({ sessionsHome } = app.prepare(root));
  } else {
    resetRunFromTemplate(app, root);
  }
  writeFileSync(join(root, "turn.json"), screenTurnFile(turn));
  if (theme) {
    if (id !== "tau") throw new Error("--theme applies to Tau only");
    installTheme(root, theme);
  }
  // A screen that needs files on disk (a diff) writes them before the app first reads the workspace.
  await beforeLaunch?.({ app, root, workspace: app.paths(root).workspace, sessionsHome });
  let started;
  try {
    started = await start(app, root);
  } catch (error) {
    await afterClose?.({ app, root });
    throw error;
  }
  const { child, session, port } = started;
  await session.send("Runtime.enable");
  await session.send("Page.enable");
  await session.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 2, mobile: false });
  const ctx = makeContext(app, session);
  try {
    if (!fresh) await ctx.waitFor(READY[id], { timeoutMs: 90_000 });
  } catch (error) {
    session.close();
    await stopTree([child.pid]);
    await afterClose?.({ app, root });
    throw error;
  }
  // Kits and lazy panels settle after the first rows; a moment keeps captures stable.
  await wait(1_500);
  ctx.pid = child.pid;
  ctx.port = port;
  ctx.root = root;
  ctx.close = async () => {
    try { checkIsolation(child.pid, app.label); } finally {
      session.close();
      const stopped = await stopTree([child.pid]);
      if (stopped.stillAlive.length) console.error(`[screens] ${app.label}: still alive after stop: ${stopped.stillAlive.join(", ")}`);
      await afterClose?.({ app, root });
    }
  };
  ctx.checkIsolation = () => checkIsolation(child.pid, app.label);
  return ctx;
}

export function makeContext(app, session) {
  const ctx = {
    app,
    id: app.id,
    session,
    wait,
    eval: (expression) => evaluate(session, expression),
    waitFor: (expression, options) => waitFor(session, expression, options),
    /** Clicks the first visible `selector` whose text or aria-label matches `pattern`. */
    async click(selector, pattern = /.*/u, { timeoutMs = 15_000, button = "left" } = {}) {
      const { value } = await waitFor(session, locate(selector, pattern), { timeoutMs });
      if (button === "left") await click(session, value.x, value.y);
      else await mouse(session, value.x, value.y, button);
      return value.label;
    },
    /** Clicks the smallest visible `selector` whose text matches: the row itself, not a container that starts with it. */
    async clickText(selector, pattern, { timeoutMs = 15_000 } = {}) {
      const { value } = await waitFor(session, `(() => {
        const pattern = new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)});
        const hits = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && pattern.test(el.textContent.trim());
        }).sort((a, b) => a.textContent.length - b.textContent.length);
        if (!hits.length) return null;
        const rect = hits[0].getBoundingClientRect();
        return { x: rect.left + Math.min(rect.width / 2, 60), y: rect.top + rect.height / 2 };
      })()`, { timeoutMs });
      await click(session, value.x, value.y);
    },
    async rightClick(selector, pattern = /.*/u, options) {
      return ctx.click(selector, pattern, { ...options, button: "right" });
    },
    async hover(selector, pattern = /.*/u, { timeoutMs = 15_000 } = {}) {
      const { value } = await waitFor(session, locate(selector, pattern), { timeoutMs });
      await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: value.x, y: value.y });
      return value.label;
    },
    async moveMouse(x, y) {
      await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    },
    /** A key or a chord, spelled like the workbench's keybindings (`mod+k`, `Escape`). */
    async press(spec) {
      const chord = parseChord(spec);
      if (chord) {
        // Editing chords reach a field only as editor commands; the key event alone selects nothing.
        const commands = EDIT_COMMANDS[spec.toLowerCase()];
        await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: chord.modifiers, ...chord.key, ...(commands ? { commands } : {}) });
        await session.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: chord.modifiers, ...chord.key });
        return;
      }
      const key = keySpec(spec);
      await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
      if (key.text) await session.send("Input.dispatchKeyEvent", { type: "char", ...key });
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    },
    /** Down and up without the `char` event, so a field the keydown opens does not receive the key too. */
    async keyDownUp(spec) {
      const key = keySpec(spec);
      await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    },
    type: (text) => insertText(session, text),
    async clearField() {
      await ctx.press("mod+a");
      await ctx.press("Backspace");
    },
    async scheme(value) {
      await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }, { name: "prefers-reduced-motion", value: "no-preference" }] });
      await wait(250);
    },
    /** Narrows or restores the emulated window, for layouts that change with width. */
    async viewport(width = VIEWPORT.width, height = VIEWPORT.height) {
      await session.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
      await wait(400);
    },
    async screenshot(path) {
      const { data } = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(path, Buffer.from(data, "base64"));
    },
    measure: (probes) => evaluate(session, `(${MEASURE})(${JSON.stringify(probes)})`),
    /** Presses Tab `count` times from wherever focus is and records what each press lands on. */
    async tabOrder(count = 8) {
      const stops = [];
      for (let index = 0; index < count; index += 1) {
        await ctx.press("Tab");
        await wait(60);
        stops.push(await evaluate(session, TAB_ORDER));
      }
      return stops;
    },
  };
  return ctx;
}

async function mouse(session, x, y, button) {
  await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 });
  await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
}
