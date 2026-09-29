// Drives an isolated Tau instance over Chrome DevTools Protocol: the same
// approach used ad hoc from /tmp before this script existed. See
// docs/agents/testing-the-app.md and .agents/skills/test-tau-app/SKILL.md.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INSTANCE_PATH = join(ROOT, ".tau-dev", "instance.json");

// Given to every page evaluation so `eval`, `click`, `type` and `wait-for`
// expressions can all use the same small vocabulary.
export const HELPERS = `
  const all = (sel) => [...document.querySelectorAll(sel)];
  const byText = (sel, re) => all(sel).find((el) => re.test(((el.getAttribute('aria-label') ?? '') + ' ' + el.textContent).trim()));
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  const setValue = (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const toasts = () => all('.toast-item').map((t) => ({ level: t.dataset.type ?? null, text: (t.querySelector('.toast-body')?.textContent ?? '').trim() }));
`;

// Collects a compact description of the workbench; see docs/agents/testing-the-app.md
// for the DOM conventions this leans on (thread-row, send-button, panel-rail…).
export const SNAPSHOT_EXPR = `(() => {
  const text = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const headings = all("h1, h2, h3").map(text).filter(Boolean);
  const buttons = all("button[aria-label]").map((el) => el.getAttribute("aria-label"));
  const threadRows = all(".thread-row").map((row) => ({
    title: text(row.querySelector(".thread-title")) || text(row),
    active: row.classList.contains("active"),
  }));
  const textarea = document.querySelector("textarea");
  const sendButton = document.querySelector(".send-button:not(.stop)");
  const composer = textarea ? {
    value: textarea.value,
    streaming: !!document.querySelector(".send-button.stop"),
    sendDisabled: !!sendButton?.disabled,
    sendBusy: sendButton?.getAttribute("aria-busy") === "true",
  } : null;
  const activePanels = all('.panel-rail button[aria-pressed="true"]').map((el) => el.getAttribute("aria-label"));
  return { headings, buttons, threadRows, toasts: toasts(), composer, activePanels };
})()`;

const KEY_TABLE = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  F6: { key: "F6", code: "F6", windowsVirtualKeyCode: 117 },
  " ": { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
};

/** Maps a `press` argument to CDP `Input.dispatchKeyEvent` params. A single character presses its own key. */
export function keySpec(name) {
  if (Object.hasOwn(KEY_TABLE, name)) return KEY_TABLE[name];
  if (name.length === 1) {
    return { key: name, code: `Key${name.toUpperCase()}`, windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0), text: name };
  }
  throw new Error(`press: unknown key ${JSON.stringify(name)} (known: ${Object.keys(KEY_TABLE).join(", ")}, or any single character)`);
}

// CDP Input.dispatchKeyEvent's `modifiers` bitmask.
const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

// Same spelling as the workbench's own chords (src/renderer/keybindings.ts):
// "mod" is the platform's primary modifier, resolved below.
const CHORD_MODIFIERS = {
  mod: "mod",
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  super: "meta",
};

const CHORD_KEY_ALIASES = {
  esc: "Escape",
  escape: "Escape",
  return: "Enter",
  enter: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  up: "ArrowUp",
  arrowup: "ArrowUp",
  down: "ArrowDown",
  arrowdown: "ArrowDown",
  left: "ArrowLeft",
  arrowleft: "ArrowLeft",
  right: "ArrowRight",
  arrowright: "ArrowRight",
  space: " ",
};

function resolveChordKeySpec(name) {
  const alias = CHORD_KEY_ALIASES[name];
  if (alias) return keySpec(alias);
  return keySpec(name.length === 1 ? name : name[0].toUpperCase() + name.slice(1));
}

/**
 * Parses a chord like `mod+shift+d` or `mod+k`, the same spelling the
 * workbench's own keybindings use: `mod` is the platform's primary modifier
 * (meta on macOS, ctrl elsewhere). Returns `undefined` for a bare key
 * (`press` handles that as a single keystroke, not a chord).
 */
export function parseChord(spec, { platform = process.platform } = {}) {
  const parts = spec.trim().toLowerCase().split("+").map((part) => part.trim());
  if (parts.length < 2 || parts.some((part) => !part)) return undefined;
  const modifiers = new Set();
  for (const part of parts.slice(0, -1)) {
    const modifier = CHORD_MODIFIERS[part];
    if (!modifier) throw new Error(`press: unknown modifier ${JSON.stringify(part)} in chord ${JSON.stringify(spec)}`);
    modifiers.add(modifier === "mod" ? (platform === "darwin" ? "meta" : "ctrl") : modifier);
  }
  const key = resolveChordKeySpec(parts.at(-1));
  let bits = 0;
  for (const modifier of modifiers) bits |= MODIFIER_BITS[modifier];
  return { key, modifiers: bits };
}

/** Splits `[port] <command> [...args]`; a leading all-digit token is the port. */
export function parseCli(argv) {
  const args = [...argv];
  let port;
  if (/^\d+$/u.test(args[0] ?? "")) port = Number(args.shift());
  const command = args.shift();
  if (!command) throw new Error("usage: tau-cdp.mjs [port] <command> [...args]");
  return { port, command, args };
}

/** Falls back to the port `dev-instance.mjs` last wrote, when the caller did not name one. */
export function resolvePort(port, { instancePath = INSTANCE_PATH, readFile = (path) => readFileSync(path, "utf8") } = {}) {
  if (port !== undefined) return port;
  let raw;
  try {
    raw = readFile(instancePath);
  } catch {
    throw new Error(`no port given and no instance file at ${instancePath} — start one with npm run dev:instance`);
  }
  const data = JSON.parse(raw);
  if (!data.port) throw new Error(`${instancePath} has no "port"`);
  return data.port;
}

/**
 * A port from `.tau-dev/instance.json` may have been taken over by another worktree's instance after this one
 * died; driving (or stopping) that one would act on someone else's test. The port must belong to a process
 * started from this worktree.
 */
export function assertOwnInstance(psOutput, port, root) {
  const needle = `--remote-debugging-port=${port}`;
  const line = psOutput.split("\n").filter((entry) => entry.includes(needle)).sort((a, b) => a.length - b.length)[0];
  if (!line) throw new Error(`no process on this machine is listening with ${needle} — this worktree's instance is gone; start one with npm run dev:instance`);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!line.includes(prefix)) throw new Error(`port ${port} from .tau-dev/instance.json belongs to another instance (${line.trim().slice(0, 160)}); this worktree's instance is gone — start one with npm run dev:instance`);
}

/** Picks the shortest `ps` line naming this port: Electron's helper processes inherit longer command lines. */
export function pidFromPsOutput(psOutput, port) {
  const needle = `--remote-debugging-port=${port}`;
  const lines = psOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(needle));
  if (lines.length === 0) return undefined;
  lines.sort((left, right) => left.length - right.length);
  const pid = Number(lines[0].split(/\s+/u)[0]);
  return Number.isNaN(pid) ? undefined : pid;
}

/** Renders the structured page description `SNAPSHOT_EXPR` collects into a compact text outline. */
export function formatSnapshot(data, { maxLength = 4000 } = {}) {
  const lines = [];
  const list = (label, items) => {
    if (!items || items.length === 0) {
      lines.push(`${label}: (none)`);
      return;
    }
    lines.push(`${label}:`);
    for (const item of items) lines.push(`  - ${item}`);
  };
  list("Headings", data.headings);
  list("Buttons", data.buttons);
  if (data.threadRows?.length) {
    lines.push("Threads:");
    for (const row of data.threadRows) lines.push(`  ${row.active ? "*" : "-"} ${row.title}`);
  } else {
    lines.push("Threads: (none)");
  }
  if (data.toasts?.length) {
    lines.push("Toasts:");
    for (const toast of data.toasts) lines.push(`  - [${toast.level ?? "info"}] ${toast.text}`);
  } else {
    lines.push("Toasts: (none)");
  }
  lines.push(
    data.composer
      ? `Composer: value=${JSON.stringify(data.composer.value)} streaming=${data.composer.streaming} sendDisabled=${data.composer.sendDisabled} sendBusy=${data.composer.sendBusy}`
      : "Composer: (not mounted)",
  );
  list("Active panels", data.activePanels);
  const text = lines.join("\n");
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n… (truncated)` : text;
}

async function findPage(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  // The preview kit's browser view is a page target too; the workbench is the
  // one loading Tau's own document (built or from the dev server).
  const pages = targets.filter((target) => target.type === "page" && !target.url.startsWith("devtools"));
  const page = pages.find((target) => /\/dist\/index\.html|localhost:5173/u.test(target.url)) ?? pages[0];
  if (!page) throw new Error(`no page target on port ${port} (targets: ${targets.map((target) => target.type).join(", ") || "none"})`);
  return page;
}

/** One CDP connection: request/response by id, exactly like the throwaway /tmp script this replaces. */
async function connect(port) {
  const page = await findPage(port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolvePromise, rejectPromise) => {
    ws.addEventListener("open", () => resolvePromise());
    ws.addEventListener("error", () => rejectPromise(new Error(`cannot open a CDP socket on port ${port}`)));
  });
  let id = 0;
  const waiting = new Map();
  ws.addEventListener("message", (message) => {
    const frame = JSON.parse(message.data);
    if (frame.id && waiting.has(frame.id)) {
      waiting.get(frame.id)(frame);
      waiting.delete(frame.id);
    }
  });
  const send = (method, params = {}) => new Promise((resolvePromise) => {
    const messageId = ++id;
    waiting.set(messageId, resolvePromise);
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });
  return { send, close: () => ws.close() };
}

async function evaluate(session, expression, { awaitPromise = true } = {}) {
  const response = await session.send("Runtime.evaluate", {
    expression: `(async () => { ${HELPERS}\n return (${expression}); })()`,
    awaitPromise,
    returnByValue: true,
  });
  if (response.result?.exceptionDetails) {
    const detail = response.result.exceptionDetails;
    throw new Error(detail.exception?.description ?? detail.text ?? JSON.stringify(detail));
  }
  return response.result?.result?.value;
}

async function dispatchClick(session, x, y, button = "left") {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await session.send("Input.dispatchMouseEvent", { type, x, y, button, clickCount: 1 });
  }
}

const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** Marks a command result as pre-formatted text (`snapshot`) rather than a value to JSON-print. */
const RAW_TEXT = Symbol("rawText");
function rawText(text) {
  return { [RAW_TEXT]: true, text };
}

async function runCommand(session, command, args) {
  if (command === "eval") {
    if (args.length !== 1) throw new Error("usage: eval <expr>");
    return evaluate(session, args[0]);
  }
  if (command === "click") {
    if (args.length !== 1 && args.length !== 3) throw new Error("usage: click <expr> [x y as fractions of the element]");
    // A point inside the element (a spot in a picture), or its center.
    const at = args.length === 3 ? [Number(args[1]), Number(args[2])] : undefined;
    if (at && at.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error("click: x and y are fractions from 0 to 1");
    const point = await evaluate(session, `(() => { const el = (${args[0]}); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); ${at ? `const r = el.getBoundingClientRect(); return { x: r.x + r.width * ${at[0]}, y: r.y + r.height * ${at[1]} };` : "return rect(el);"} })()`);
    if (!point) throw new Error(`click: expression did not resolve to an element: ${args[0]}`);
    await dispatchClick(session, point.x, point.y);
    return { clicked: args[0], at: point };
  }
  if (command === "hover" || command === "rightclick") {
    if (args.length !== 1) throw new Error(`usage: ${command} <expr>`);
    const point = await evaluate(session, `(() => { const el = (${args[0]}); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); return rect(el); })()`);
    if (!point) throw new Error(`${command}: expression did not resolve to an element: ${args[0]}`);
    // A hover is only the move; a right-click opens whatever context menu the page asks for.
    if (command === "hover") await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    else await dispatchClick(session, point.x, point.y, "right");
    return { [command === "hover" ? "hovered" : "rightClicked"]: args[0], at: point };
  }
  if (command === "type") {
    if (args.length !== 2) throw new Error("usage: type <expr> <text>");
    const [expr, text] = args;
    const ok = await evaluate(session, `(() => { const el = (${expr}); if (!el) return false; el.focus(); setValue(el, ${JSON.stringify(text)}); return true; })()`);
    if (!ok) throw new Error(`type: expression did not resolve to an element: ${expr}`);
    return { typed: text, into: expr };
  }
  if (command === "press") {
    if (args.length !== 1) throw new Error("usage: press <key> (or a chord: mod+shift+d, mod+k)");
    const chord = parseChord(args[0]);
    if (chord) {
      // A held modifier suppresses the browser's own "char"/textInput event
      // for a real chord, so only rawKeyDown/keyUp are dispatched here.
      await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: chord.modifiers, ...chord.key });
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: chord.modifiers, ...chord.key });
      return { pressed: args[0] };
    }
    const spec = keySpec(args[0]);
    await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...spec });
    if (spec.text) await session.send("Input.dispatchKeyEvent", { type: "char", ...spec });
    await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...spec });
    return { pressed: args[0] };
  }
  if (command === "wait-for") {
    if (args.length < 1 || args.length > 2) throw new Error("usage: wait-for <expr> [timeoutMs]");
    const [expr, timeoutArg] = args;
    const timeoutMs = timeoutArg ? Number(timeoutArg) : 15_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await evaluate(session, expr);
      if (value) return value;
      if (Date.now() >= deadline) throw new Error(`wait-for: timed out after ${timeoutMs}ms waiting for ${expr}`);
      await wait(200);
    }
  }
  if (command === "screenshot") {
    if (args.length !== 1) throw new Error("usage: screenshot <file.png>");
    const response = await session.send("Page.captureScreenshot", { format: "png" });
    if (!response.result?.data) throw new Error("screenshot: Page.captureScreenshot returned no data");
    writeFileSync(args[0], Buffer.from(response.result.data, "base64"));
    return { savedTo: args[0] };
  }
  if (command === "snapshot") {
    const data = await evaluate(session, SNAPSHOT_EXPR);
    return rawText(formatSnapshot(data));
  }
  if (command === "toasts") {
    return evaluate(session, "toasts()");
  }
  throw new Error(`unknown command ${JSON.stringify(command)} (known: eval, click, hover, rightclick, type, press, wait-for, screenshot, snapshot, toasts, pid, stop)`);
}

/**
 * SIGTERM, then SIGKILL if the process is still alive after a short grace
 * period. Electron's main process does not reliably quit on SIGTERM alone
 * (observed on macOS: it can sit for 10+ seconds without exiting, with no
 * signal handler of its own to blame — src/main/index.ts installs none), so
 * a bare `kill <pid>` is not a dependable way to stop an instance.
 */
export async function stopProcess(pid, {
  kill = (targetPid, signal) => process.kill(targetPid, signal),
  isAlive = (targetPid) => { try { process.kill(targetPid, 0); return true; } catch { return false; } },
  wait: waitFn = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
  graceMs = 2000,
  pollMs = 100,
} = {}) {
  kill(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && isAlive(pid)) await waitFn(pollMs);
  if (!isAlive(pid)) return { pid, escalated: false };
  kill(pid, "SIGKILL");
  return { pid, escalated: true };
}

/**
 * The host of this instance, as `dev-instance.mjs` recorded it. Only a pid
 * that belongs to the instance file is ever signalled — never one found by
 * name, which would be somebody else's Tau.
 */
export function instanceHostPid(instance, { readFile = (path) => readFileSync(path, "utf8") } = {}) {
  // host.json is rewritten on every restart, so it wins over the pid the
  // instance file recorded when the window started.
  if (typeof instance?.userData === "string") {
    try {
      const descriptor = JSON.parse(readFile(join(instance.userData, "host.json")));
      if (typeof descriptor.pid === "number") return descriptor.pid;
    } catch {
      // No descriptor: the host stopped, or never wrote one.
    }
  }
  return typeof instance?.hostPid === "number" ? instance.hostPid : undefined;
}

function processRuns(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readInstanceFile() {
  try {
    return JSON.parse(readFileSync(INSTANCE_PATH, "utf8"));
  } catch {
    return undefined;
  }
}

/** /json/version proves the port is actually a live devtools endpoint before ps is trusted. */
async function findLivePid(port) {
  await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const psOutput = execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" });
  const pid = pidFromPsOutput(psOutput, port);
  if (!pid) throw new Error(`no process on this machine is listening with --remote-debugging-port=${port}`);
  return pid;
}

async function main() {
  let parsed;
  try {
    parsed = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  let port;
  try {
    port = resolvePort(parsed.port, { instancePath: INSTANCE_PATH, readFile: (path) => readFileSync(path, "utf8") });
    if (parsed.port === undefined) assertOwnInstance(execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" }), port, ROOT);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  if (parsed.command === "pid") {
    try {
      console.log(await findLivePid(port));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
    return;
  }

  if (parsed.command === "stop") {
    try {
      const pid = await findLivePid(port);
      const result = await stopProcess(pid);
      console.log(result.escalated ? `${pid} (SIGTERM was ignored; sent SIGKILL)` : `${pid}`);
      // The host outlives the window by design, so stopping an instance means
      // stopping both — its own host, named by its own instance file.
      const hostPid = instanceHostPid(readInstanceFile());
      if (hostPid !== undefined && processRuns(hostPid)) {
        const hostResult = await stopProcess(hostPid);
        console.log(hostResult.escalated ? `host ${hostPid} (SIGTERM was ignored; sent SIGKILL)` : `host ${hostPid}`);
      } else if (hostPid !== undefined) {
        console.log(`host ${hostPid} had already stopped`);
      }
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
    return;
  }

  let session;
  try {
    session = await connect(port);
    const result = await runCommand(session, parsed.command, parsed.args);
    if (result && typeof result === "object" && result[RAW_TEXT]) {
      console.log(result.text);
    } else {
      console.log(JSON.stringify(result, null, 1));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    session?.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
