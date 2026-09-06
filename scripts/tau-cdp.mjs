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
const HELPERS = `
  const all = (sel) => [...document.querySelectorAll(sel)];
  const byText = (sel, re) => all(sel).find((el) => re.test(((el.getAttribute('aria-label') ?? '') + ' ' + el.textContent).trim()));
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  const setValue = (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const toasts = () => all('.toast').map((t) => ({ level: t.dataset.level ?? null, text: (t.querySelector('span')?.textContent ?? t.textContent ?? '').trim() }));
`;

// Collects a compact description of the workbench; see docs/agents/testing-the-app.md
// for the DOM conventions this leans on (thread-row, send-button, panel-rail…).
const SNAPSHOT_EXPR = `(() => {
  const text = (el) => (el.textContent ?? "").replace(/\\s+/g, " ").trim();
  const headings = all("h1, h2, h3").map(text).filter(Boolean);
  const buttons = all("button[aria-label]").map((el) => el.getAttribute("aria-label"));
  const threadRows = all(".thread-row").map((row) => ({
    title: text(row.querySelector(".thread-title")) || text(row),
    active: row.classList.contains("active"),
  }));
  const textarea = document.querySelector("textarea");
  const sendButton = document.querySelector(".send-button");
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

async function dispatchClick(session, x, y) {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await session.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
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
    if (args.length !== 1) throw new Error("usage: click <expr>");
    const point = await evaluate(session, `(() => { const el = (${args[0]}); return el ? rect(el) : null; })()`);
    if (!point) throw new Error(`click: expression did not resolve to an element: ${args[0]}`);
    await dispatchClick(session, point.x, point.y);
    return { clicked: args[0], at: point };
  }
  if (command === "type") {
    if (args.length !== 2) throw new Error("usage: type <expr> <text>");
    const [expr, text] = args;
    const ok = await evaluate(session, `(() => { const el = (${expr}); if (!el) return false; el.focus(); setValue(el, ${JSON.stringify(text)}); return true; })()`);
    if (!ok) throw new Error(`type: expression did not resolve to an element: ${expr}`);
    return { typed: text, into: expr };
  }
  if (command === "press") {
    if (args.length !== 1) throw new Error("usage: press <key>");
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
  throw new Error(`unknown command ${JSON.stringify(command)} (known: eval, click, type, press, wait-for, screenshot, snapshot, toasts, pid)`);
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
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  if (parsed.command === "pid") {
    try {
      // /json/version proves the port is actually a live devtools endpoint before ps is trusted.
      await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const psOutput = execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" });
      const pid = pidFromPsOutput(psOutput, port);
      if (!pid) throw new Error(`no process on this machine is listening with --remote-debugging-port=${port}`);
      console.log(pid);
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
