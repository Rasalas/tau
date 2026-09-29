#!/usr/bin/env node
// Product screenshots from an isolated Tau on sample data: npm run screenshots -- --out <dir>.
// See scripts/screenshots/README.md.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, evaluate, waitForPage } from "../compare/cdp.mjs";
import { writeFixture } from "./fixture.mjs";
import { selectShots } from "./shots.mjs";
import { assertEnvUnder } from "../compare/isolation.mjs";
import { freePort, realTmp } from "../compare/apps.mjs";
import { startFakeModelServer } from "../fake-model-server.mjs";
import { stopProcess } from "../tau-cdp.mjs";
import { DEVICES, chromeArgs, emulationSteps, findChromium, hostCall, pickPairingUrl, sameCode } from "../tau-mobile-cdp.mjs";

const TAU_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const MARKER = ".tau-screenshots";
export const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 2 };
const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export function parseArgs(argv) {
  const options = { out: undefined, only: [], theme: "light", build: false, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--out") options.out = resolve(value());
    else if (arg === "--only") options.only.push(...value().split(",").map((name) => name.trim()).filter(Boolean));
    else if (arg === "--theme") options.theme = value();
    else if (arg === "--build") options.build = true;
    else if (arg === "--keep") options.keep = true;
    else throw new Error(`unknown flag ${JSON.stringify(arg)} (known: --out <dir>, --only <shot,...>, --theme light|dark, --build, --keep)`);
  }
  if (!options.out) throw new Error("--out <dir> is required");
  if (options.theme !== "light" && options.theme !== "dark") throw new Error("--theme is light or dark");
  return options;
}

/** The instance's whole environment, built from nothing: every data path under `root`, HOME included. */
export function instanceEnv(fixture) {
  const { root, home } = fixture;
  const env = {
    USER: process.env.USER ?? "sample",
    LOGNAME: process.env.USER ?? "sample",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "en_US.UTF-8",
    HOME: home,
    CFFIXED_USER_HOME: home,
    SHELL: "/bin/zsh",
    ZDOTDIR: fixture.zdotdir,
    PATH: `${fixture.bin}:${SYSTEM_PATH}`,
    TAU_USER_DATA: fixture.userData,
    TAU_WORKSPACE: fixture.projects.shop,
    TAU_CONFIG_FILE: fixture.configFile,
    TAU_WORKTREES_DIR: fixture.worktrees,
    TAU_THEMES_DIR: join(root, "themes"),
    TAU_EXTENSION_GRANTS_FILE: join(root, "extension-grants.json"),
    TAU_HOST_TOKEN_FILE: join(root, "host-token"),
    TAU_SERVICE_UNIT_DIR: join(root, "service-units"),
    TAU_SERVICE_CONTROL: join(TAU_ROOT, "scripts", "fake-service-manager.mjs"),
    TAU_IMPORT_ROOTS: join(root, "import-roots"),
    TAU_OPENCODE_HOME: join(home, ".opencode"),
    TAU_CURSOR_HOME: join(home, ".cursor"),
    TAU_GROK_HOME: join(home, ".grok"),
    PI_CODING_AGENT_SESSION_DIR: fixture.sessions,
    PI_CODING_AGENT_DIR: fixture.agentDir,
    CODEX_HOME: fixture.codexHome,
    CLAUDE_CONFIG_DIR: fixture.sdkHome,
    TAU_CODEX_COMMAND: fixture.codexCommand,
    TAU_CLAUDE_CODE_COMMAND: join(TAU_ROOT, "kits", "claude-code", "fixtures", "stub-cli.mjs"),
    STUB_CLI_MODELS: JSON.stringify(fixture.sdkModels),
    STUB_CLI_USAGE: fixture.sdkUsage,
    TAU_CURSOR_COMMAND: join(TAU_ROOT, "kits", "cursor", "fixtures", "fake-cursor-agent.mjs"),
    TAU_GROK_COMMAND: join(TAU_ROOT, "kits", "grok", "fixtures", "fake-grok.mjs"),
    TAU_ANTIGRAVITY_ACP_COMMAND: join(root, "bin", "no-antigravity"),
    TAU_MACHINE_NAME: "MacBook Pro",
    TAU_BONJOUR_SERVICE_TYPE: "_tau-test._tcp",
    TAU_NO_NATIVE_DIALOGS: "1",
    TAU_NO_FOCUS: "1",
    TAU_NO_RUNTIME_UPDATES: "1",
    TAU_RUNTIME_UPDATE_COMMAND: JSON.stringify({ "*": "echo 'Tau screenshots: this update was not run.'" }),
  };
  assertEnvUnder(env, ["HOME", "CFFIXED_USER_HOME", "ZDOTDIR", "TAU_USER_DATA", "TAU_WORKSPACE", "TAU_CONFIG_FILE", "TAU_WORKTREES_DIR", "TAU_THEMES_DIR", "TAU_HOST_TOKEN_FILE", "TAU_IMPORT_ROOTS", "PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_DIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TAU_CODEX_COMMAND"], root);
  return env;
}

/** The run folder, emptied; refuses a folder it did not make or one a live run still holds. */
function prepareRoot(root) {
  if (existsSync(root)) {
    if (!existsSync(join(root, MARKER))) throw new Error(`${root} exists and is not a screenshots run folder; refusing to empty it`);
    const holder = Number(readFileSync(join(root, MARKER), "utf8"));
    if (holder && holder !== process.pid && alive(holder)) throw new Error(`another screenshots run (pid ${holder}) uses ${root}`);
    rmSync(root, { recursive: true, force: true });
  }
  mkdirSync(join(root, "logs"), { recursive: true });
  writeFileSync(join(root, MARKER), String(process.pid));
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function commandOf(pid) {
  try { return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { return ""; }
}

/** Every process below `pid`, with its command line then, so a pid reused later is never signalled. */
export function descendants(pid, table = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })) {
  const rows = table.split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/u)).filter(Boolean).map(([, child, parent, command]) => ({ pid: Number(child), parent: Number(parent), command }));
  const found = [];
  for (let queue = [pid]; queue.length;) {
    const parent = queue.shift();
    for (const row of rows) if (row.parent === parent) { found.push(row); queue.push(row.pid); }
  }
  return found;
}

async function waitForQuietMachine(limit = 40) {
  for (let checks = 0; loadavg()[0] > limit; checks += 1) {
    if (checks >= 40) throw new Error(`load average stayed above ${limit} for 10 minutes`);
    console.log(`[screenshots] load ${loadavg()[0].toFixed(1)} > ${limit}; waiting`);
    await wait(15_000);
  }
}

function ensureBuild(force) {
  if (!force && existsSync(join(TAU_ROOT, "dist-electron", "main", "index.js")) && existsSync(join(TAU_ROOT, "dist-web"))) return;
  console.log("[screenshots] building (npm run build)…");
  execFileSync(process.execPath, [join(TAU_ROOT, "scripts", "build.mjs")], { cwd: TAU_ROOT, stdio: "inherit" });
}

/** What a shot drives: real mouse and key events, element rects, a PNG of the page or a part of it. */
function driver(session, viewport) {
  const rect = async (expr) => {
    const box = await evaluate(session, `(() => { const el = (${expr}); if (!el) return null; el.scrollIntoView({ block: "nearest", inline: "nearest" }); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    if (!box || !box.width) throw new Error(`no element for ${expr}`);
    return box;
  };
  const mouse = async (type, x, y) => session.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 });
  const ctx = {
    viewport,
    evaluate: (expr) => evaluate(session, expr),
    async waitFor(expr, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(session, expr).catch(() => false)) return;
        await wait(100);
      }
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${expr.slice(0, 160)}`);
    },
    async waitForElement(expr, timeoutMs) { await ctx.waitFor(`!!(${expr})`, timeoutMs); },
    rect,
    async click(expr) {
      await ctx.waitForElement(expr);
      const box = await rect(expr);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await mouse("mouseMoved", x, y);
      await mouse("mousePressed", x, y);
      await mouse("mouseReleased", x, y);
      await wait(400);
    },
    async hover(expr) {
      await ctx.waitForElement(expr);
      const box = await rect(expr);
      await mouse("mouseMoved", box.x - 30, box.y + box.height / 2);
      await mouse("mouseMoved", box.x + box.width / 2, box.y + box.height / 2);
      await wait(900);
    },
    /** The mouse on an empty spot, so no hover state or tooltip is in the picture. */
    async rest() {
      await mouse("mouseMoved", viewport.width - 4, viewport.height - 4);
      await wait(700);
    },
    async screenshot(clip) {
      await wait(300);
      const { data } = await session.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      return Buffer.from(data, "base64");
    },
  };
  return ctx;
}

/** The desktop window back where every shot starts: the thread list, no page or dialog open. */
async function resetDesktop(session, theme) {
  await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await evaluate(session, `(() => { const back = [...document.querySelectorAll("button")].find((b) => /^Back to thread/.test(b.textContent.trim())); back?.click(); document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return true; })()`);
  await wait(500);
}

async function startPhone(root, theme, host) {
  const profile = join(root, "phone-profile");
  mkdirSync(profile, { recursive: true });
  const port = await freePort();
  const log = openSync(join(root, "logs", "phone.log"), "a");
  const chrome = spawn(findChromium(), chromeArgs({ port, profile, device: "iphone" }), { stdio: ["ignore", log, log] });
  const page = await waitForPage(port, { timeoutMs: 30_000 });
  const session = await connect(page.webSocketDebuggerUrl);
  for (const [method, params] of emulationSteps("iphone", theme)) await session.send(method, params).catch((error) => { if (method !== "Emulation.setSafeAreaInsetsOverride") throw error; });
  const label = "iPhone";
  const created = await hostCall({ ...host, method: "connections-create-link", params: [{ label, access: "full" }] });
  await session.send("Page.navigate", { url: pickPairingUrl(created.urls) });
  let request;
  let shown;
  for (const deadline = Date.now() + 30_000; Date.now() < deadline && !(request && shown);) {
    await wait(300);
    request = (await hostCall({ ...host, method: "connections-list" })).requests.find((entry) => entry.link?.label === label);
    shown = await evaluate(session, `document.querySelector(".token-gate-code")?.textContent ?? null`).catch(() => null);
  }
  if (!request || !sameCode(shown, request.verification)) throw new Error(`pairing failed: the phone shows ${shown}, the host ${request?.verification}`);
  await hostCall({ ...host, method: "connections-approve", params: [request.id, {}] });
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    if (await evaluate(session, `!!document.body.dataset.profile && !document.querySelector(".token-gate")`).catch(() => false)) break;
    await wait(300);
  }
  return { chrome, session, viewport: DEVICES.iphone };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const shots = selectShots(options.only);
  const root = process.env.TAU_SCREENSHOTS_ROOT ? resolve(process.env.TAU_SCREENSHOTS_ROOT) : realTmp("tau-screenshots");
  await waitForQuietMachine();
  ensureBuild(options.build);
  prepareRoot(root);
  mkdirSync(options.out, { recursive: true });

  const fake = await startFakeModelServer();
  const fixture = writeFixture({ root, baseUrl: fake.baseUrl, tauRoot: TAU_ROOT });
  const env = instanceEnv(fixture);
  const port = await freePort();
  const { default: electronBinary } = await import(join(TAU_ROOT, "node_modules", "electron", "index.js"));
  const log = openSync(join(root, "logs", "app.log"), "a");
  const app = spawn(electronBinary, [".", `--remote-debugging-port=${port}`, "--use-mock-keychain"], { cwd: TAU_ROOT, env, stdio: ["ignore", log, log] });
  console.log(`[screenshots] app pid=${app.pid} cdp=${port} root=${root}`);
  let phone;
  const failures = [];

  const stopAll = async () => {
    const started = [...(app.pid ? descendants(app.pid) : []), ...(phone?.chrome.pid ? descendants(phone.chrome.pid) : [])];
    if (phone?.chrome.pid && alive(phone.chrome.pid)) await stopProcess(phone.chrome.pid);
    // The host runs as its own process; host.json names it, and only this checkout's is signalled.
    let host;
    try { host = JSON.parse(readFileSync(join(fixture.userData, "host.json"), "utf8")).pid; } catch { host = undefined; }
    if (host && alive(host) && commandOf(host).includes(join(TAU_ROOT, "dist-electron"))) await stopProcess(host);
    if (app.pid && alive(app.pid)) await stopProcess(app.pid);
    // What the app started and left behind (the host's shells and stubs), as it was before the stop.
    for (const child of started) if (alive(child.pid) && commandOf(child.pid) === child.command) await stopProcess(child.pid).catch(() => undefined);
    await fake.close();
    writeFileSync(join(root, MARKER), "");
  };

  try {
    const page = await waitForPage(port, { accept: (target) => /\/dist\/index\.html/u.test(target.url), timeoutMs: 90_000 });
    const session = await connect(page.webSocketDebuggerUrl);
    await session.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, mobile: false });
    // The app follows the system's appearance; the shots follow --theme.
    await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: options.theme }] });
    const desktop = driver(session, VIEWPORT);
    await desktop.waitFor(`document.querySelectorAll("article.thread-row").length >= 9`, 90_000);
    await wait(2_000);
    for (const shot of shots) {
      try {
        let png;
        if (shot.device === "desktop") {
          await resetDesktop(session, options.theme);
          png = await shot.run(desktop);
        } else {
          if (!phone) {
            const descriptor = JSON.parse(readFileSync(join(fixture.userData, "host.json"), "utf8"));
            phone = await startPhone(root, options.theme, { url: descriptor.url, token: readFileSync(env.TAU_HOST_TOKEN_FILE, "utf8").trim() });
          }
          png = await shot.run(driver(phone.session, phone.viewport));
        }
        const file = join(options.out, `${shot.name}.png`);
        writeFileSync(file, png);
        console.log(`[screenshots] ${shot.name}: ${file}`);
      } catch (error) {
        failures.push(shot.name);
        console.error(`[screenshots] ${shot.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    failures.push("(startup)");
    console.error(`[screenshots] ${error instanceof Error ? error.message : String(error)}; log: ${join(root, "logs", "app.log")}`);
  } finally {
    if (options.keep) {
      console.log(`[screenshots] --keep: app cdp port ${port}; stop the run with kill ${process.pid}`);
      for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void stopAll().finally(() => process.exit(process.exitCode ?? 0)); });
    } else {
      await stopAll();
    }
  }
  if (failures.length) {
    console.error(`[screenshots] failed: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
  if (options.keep) await new Promise(() => {});
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[screenshots] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
