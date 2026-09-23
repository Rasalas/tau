// How each app is prepared, launched isolated and addressed in the DOM.
// Every data path of both apps is derived from one root per app; see
// isolation.mjs for the checks and docs/PERFORMANCE.md for the reasoning.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertEnvUnder } from "./isolation.mjs";

const TAU_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url));
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export function freePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

/** `/tmp` is a symlink on macOS; both apps compare real paths. */
export function realTmp(name) {
  return join(realpathSync("/tmp"), name);
}

function gitInit(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  writeFileSync(join(dir, "README.md"), "# Comparison workspace\n\nScratch repository for the Tau and T3 Code comparison harness.\n");
  execFileSync("git", ["-C", dir, "add", "README.md"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=Compare Harness", "-c", "user.email=compare@example.invalid", "commit", "-q", "-m", "chore: init"]);
}

/** A `codex` on the app's PATH that runs the replay with this harness's own Node. */
function writeCodexShim(root) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "codex");
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CODEX)} "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

/** Environment shared by both apps: nothing inherited but locale, user and temp dir. */
function baseEnv({ root, run }) {
  const home = join(run, "home");
  return {
    USER: process.env.USER ?? "",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    HOME: home,
    // Foundation (and so Chromium's own paths) reads this instead of HOME.
    CFFIXED_USER_HOME: home,
    SHELL: "/bin/zsh",
    // An empty ZDOTDIR keeps the login shell both apps run from reading real dotfiles.
    ZDOTDIR: join(run, "zdotdir"),
    PATH: `${join(root, "bin")}:${SYSTEM_PATH}`,
    COMPARE_TURN_FILE: join(root, "turn.json"),
    COMPARE_FAKE_CODEX_LOG: join(run, "logs", "fake-codex.jsonl"),
  };
}

function prepareRunDirs(run) {
  for (const dir of ["home", "zdotdir", "logs"]) mkdirSync(join(run, dir), { recursive: true });
}

function electronVersion(packageDir) {
  try { return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version; } catch { return "unknown"; }
}

function gitHead(dir) {
  try { return execFileSync("git", ["-C", dir, "rev-parse", "--short=10", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "unknown"; }
}

export const tau = {
  id: "tau",
  label: "Tau",
  // COMPARE_TAU_ROOT lets parallel checkouts keep their own profiles.
  defaultRoot: () => process.env.COMPARE_TAU_ROOT || realTmp("tau-harness-home"),
  sourceDir: TAU_ROOT,
  describe() {
    return {
      app: "Tau",
      commit: gitHead(TAU_ROOT),
      version: JSON.parse(readFileSync(join(TAU_ROOT, "package.json"), "utf8")).version,
      electron: electronVersion(join(TAU_ROOT, "node_modules", "electron")),
      build: "npm run build (production bundles, unpackaged Electron)",
    };
  },
  paths(root) {
    const run = join(root, "run");
    return { root, run, template: join(root, "template"), workspace: join(run, "workspace"), importSessions: join(run, "import-roots", "codex") };
  },
  /** Data dirs of a fresh profile; `sessionsHome` receives the Codex fixture. */
  prepare(root) {
    const paths = this.paths(root);
    prepareRunDirs(paths.run);
    writeCodexShim(root);
    gitInit(paths.workspace);
    writeFileSync(join(paths.run, "tau-config.json"), "{}\n");
    return { ...paths, sessionsHome: paths.importSessions };
  },
  env(root) {
    const { run, workspace } = this.paths(root);
    const env = {
      ...baseEnv({ root, run }),
      TAU_USER_DATA: join(run, "userdata"),
      TAU_WORKSPACE: workspace,
      TAU_CONFIG_FILE: join(run, "tau-config.json"),
      TAU_WORKTREES_DIR: join(run, "worktrees"),
      TAU_THEMES_DIR: join(run, "themes"),
      TAU_HOST_TOKEN_FILE: join(run, "host-token"),
      CODEX_HOME: join(run, "home", ".codex"),
      TAU_IMPORT_ROOTS: join(run, "import-roots"),
      PI_CODING_AGENT_SESSION_DIR: join(run, "pi-sessions"),
      PI_CODING_AGENT_DIR: join(run, "home", ".pi", "agent"),
      TAU_CODEX_COMMAND: join(root, "bin", "codex"),
    };
    assertEnvUnder(env, ["HOME", "CFFIXED_USER_HOME", "TAU_USER_DATA", "TAU_WORKSPACE", "TAU_CONFIG_FILE", "TAU_WORKTREES_DIR", "TAU_THEMES_DIR", "TAU_HOST_TOKEN_FILE", "CODEX_HOME", "TAU_IMPORT_ROOTS", "PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_DIR", "TAU_CODEX_COMMAND", "ZDOTDIR"], root);
    return env;
  },
  async launch(root, { port, logName = "app.log" }) {
    const { run } = this.paths(root);
    const { default: electronBinary } = await import(join(TAU_ROOT, "node_modules", "electron", "index.js"));
    const log = openSync(join(run, "logs", logName), "a");
    const child = spawn(electronBinary, [".", `--remote-debugging-port=${port}`, "--use-mock-keychain"], { cwd: TAU_ROOT, env: this.env(root), stdio: ["ignore", log, log] });
    return child;
  },
  isAppPage: (target) => /\/dist\/index\.html/u.test(target.url),
  ready: (threads) => `!!document.querySelector("textarea") && document.querySelectorAll("article.thread-row").length >= ${threads}`,
  async revealThreads() {},
  /**
   * A thread opens with its newest 10 turns; older ones come 20 at a time
   * through "Load older turns". Clicked until gone so the scroll covers the
   * whole thread, as it does in T3, which sends all of it at once.
   */
  async loadHistory(session, { evaluate, waitFor }) {
    let pages = 0;
    for (; pages < 50; pages += 1) {
      const clicked = await evaluate(session, `(() => { const b = document.querySelector('[aria-label="Load older turns"]'); if (!b) return false; b.click(); return true; })()`);
      if (!clicked) break;
      await waitFor(session, `!document.querySelector('[aria-label="Loading older turns"]')`, { timeoutMs: 30_000, pollMs: 20 });
    }
    return pages;
  },
  selectors: {
    threadRow: "article.thread-row",
    threadRowClick: "article.thread-row button.thread-main",
    composer: "textarea",
    messageRow: "#thread-transcript [data-message-id]",
    running: "button.send-button.stop",
  },
  /** Onboarding: Continue → add the workspace project → import every conversation. */
  async seed(session, { clickWhenReady, waitFor, expectedThreads }) {
    const dialog = "section.onboarding-dialog button";
    const step = `(() => { const labels = [...document.querySelectorAll(${JSON.stringify(dialog)})].map((b) => b.textContent.trim()); `
      + `return labels.some((l) => /^Import \\d+ conversations?/.test(l)) ? "import" : labels.includes("Do not add projects") ? "projects" : labels.some((l) => /^Continue/.test(l)) ? "agents" : null; })()`;
    for (let guard = 0; guard < 5; guard += 1) {
      const { value } = await waitFor(session, step, { timeoutMs: 60_000 });
      if (value === "import") break;
      // The workspace is a project already, so "Add 0 projects" stays disabled and the skip button moves on.
      if (value === "projects") await clickWhenReady(session, dialog, /^(Add [1-9]\d* projects?|Do not add projects)/u);
      else await clickWhenReady(session, dialog, /^Continue/u);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    await clickWhenReady(session, dialog, /^Select all$/u, { timeoutMs: 3_000 }).catch(() => undefined);
    await clickWhenReady(session, dialog, new RegExp(`^Import ${expectedThreads} conversations`, "u"), { timeoutMs: 60_000 });
    await waitFor(session, `document.querySelectorAll("article.thread-row").length >= ${expectedThreads}`, { timeoutMs: 120_000 });
  },
};

export const t3 = {
  id: "t3",
  label: "T3 Code",
  defaultRoot: () => realTmp("t3-harness-home"),
  sourceDir: realTmp("t3-harness"),
  describe() {
    const desktop = join(this.sourceDir, "apps", "desktop");
    return {
      app: "T3 Code",
      commit: gitHead(this.sourceDir),
      version: JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")).version,
      electron: electronVersion(join(desktop, "node_modules", "electron")),
      build: "vp run build:desktop (production bundles, unpackaged Electron, no launcher bundle)",
    };
  },
  paths(root) {
    const run = join(root, "run");
    return { root, run, template: join(root, "template"), workspace: join(run, "workspace"), t3Home: join(run, "home", ".t3") };
  },
  prepare(root) {
    const paths = this.paths(root);
    prepareRunDirs(paths.run);
    const shim = writeCodexShim(root);
    gitInit(paths.workspace);
    const stateDir = join(paths.t3Home, "userdata");
    mkdirSync(stateDir, { recursive: true });
    // Codex runs the replay; every other provider stays off, and no update or manifest fetch runs.
    writeFileSync(join(stateDir, "settings.json"), `${JSON.stringify({
      enableProviderUpdateChecks: false,
      providers: {
        codex: { binaryPath: shim, homePath: join(paths.run, "home", ".codex") },
        claudeAgent: { enabled: false },
      },
    }, null, 2)}\n`);
    return { ...paths, sessionsHome: join(paths.run, "home", ".codex") };
  },
  env(root, { backendPort }) {
    const { run, t3Home } = this.paths(root);
    const env = {
      ...baseEnv({ root, run }),
      T3CODE_HOME: t3Home,
      T3CODE_PORT: String(backendPort),
      T3CODE_TELEMETRY_ENABLED: "false",
      T3CODE_DISABLE_AUTO_UPDATE: "1",
      CODEX_HOME: join(run, "home", ".codex"),
      CLAUDE_CONFIG_DIR: join(run, "home", ".claude"),
      GROK_HOME: join(run, "home", ".grok"),
    };
    assertEnvUnder(env, ["HOME", "CFFIXED_USER_HOME", "T3CODE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME", "ZDOTDIR"], root);
    return env;
  },
  async launch(root, { port, logName = "app.log" }) {
    const { run } = this.paths(root);
    const desktop = join(this.sourceDir, "apps", "desktop");
    const electronBinary = join(desktop, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
    if (!existsSync(join(desktop, "dist-electron", "main.cjs"))) throw new Error(`T3 is not built: run \`vp run build:desktop\` in ${this.sourceDir}`);
    const log = openSync(join(run, "logs", logName), "a");
    // The plain Electron binary, never apps/desktop/scripts/start-electron.mjs: that
    // builds a bundle with the installed app's identifier and registers it with LaunchServices.
    const child = spawn(electronBinary, ["dist-electron/main.cjs", `--remote-debugging-port=${port}`, "--use-mock-keychain"], {
      cwd: desktop,
      env: this.env(root, { backendPort: await freePort() }),
      stdio: ["ignore", log, log],
    });
    return child;
  },
  isAppPage: (target) => /^t3code:/u.test(target.url),
  /** Rail shows the imported threads (possibly on the collapsed shelf) and the composer is mounted. */
  ready: (threads) => `!!document.querySelector("[data-testid=composer-editor]") && (/Settled \\(${threads}\\)/.test(document.querySelector("[data-testid=sidebar-settled-header]")?.textContent ?? "") || document.querySelectorAll("[data-testid=sidebar-row-slim], [data-testid=sidebar-row-card]").length >= ${threads})`,
  selectors: {
    threadRow: "[data-testid=sidebar-row-slim], [data-testid=sidebar-row-card]",
    threadRowClick: "[data-testid=sidebar-row-slim], [data-testid=sidebar-row-card]",
    composer: "[data-testid=composer-editor]",
    messageRow: "[data-timeline-row-kind=message]",
    running: "button[aria-label='Queue message']",
  },
  /** Welcome: Continue past Connect and Agents, then import the workspace project with its conversations. */
  async seed(session, { clickWhenReady, waitFor, expectedThreads }) {
    const dialog = "[role=dialog] button";
    const step = `(() => { const labels = [...document.querySelectorAll(${JSON.stringify(dialog)})].map((b) => b.textContent.trim()); `
      + `return labels.some((l) => /^Import \\d+ projects?$/.test(l)) ? "import" : labels.includes("Continue") ? "continue" : null; })()`;
    for (let guard = 0; guard < 5; guard += 1) {
      const { value } = await waitFor(session, step, { timeoutMs: 60_000 });
      if (value === "import") break;
      await clickWhenReady(session, dialog, /^Continue$/u);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    await clickWhenReady(session, dialog, /^Import 1 project$/u);
    await waitFor(session, `/Settled \\(${expectedThreads}\\)/.test(document.querySelector("[data-testid=sidebar-settled-header]")?.textContent ?? "") || document.querySelectorAll(${JSON.stringify(this.selectors.threadRow)}).length >= ${expectedThreads}`, { timeoutMs: 120_000 });
    await this.revealThreads(session, { clickWhenReady, waitFor, expectedThreads });
  },
  /** T3 sends a thread's whole history when it opens. */
  async loadHistory() { return 0; },
  /** Imported threads land on the collapsed "Settled" shelf; open it so rows can be clicked. */
  async revealThreads(session, { clickWhenReady, waitFor, expectedThreads }) {
    const rows = `document.querySelectorAll(${JSON.stringify(this.selectors.threadRow)}).length >= ${expectedThreads}`;
    const { value } = await waitFor(session, `(${rows}) ? "open" : document.querySelector("[data-testid=sidebar-settled-shelf-toggle]") ? "closed" : null`, { timeoutMs: 30_000 });
    if (value === "closed") await clickWhenReady(session, "[data-testid=sidebar-settled-shelf-toggle]", /.*/u);
    await waitFor(session, rows, { timeoutMs: 30_000 });
  },
};

export const APPS = { tau, t3 };

/** Replaces the run dir with a copy of the seeded template; paths inside stay valid because the location is the same. */
export function resetRunFromTemplate(app, root) {
  const { run, template } = app.paths(root);
  if (!existsSync(template)) throw new Error(`${app.label}: no seeded template under ${template}; run with --seed first`);
  rmSync(run, { recursive: true, force: true });
  cpSync(template, run, { recursive: true, verbatimSymlinks: true });
}

export function saveTemplate(app, root) {
  const { run, template } = app.paths(root);
  rmSync(template, { recursive: true, force: true });
  mkdirSync(dirname(template), { recursive: true });
  cpSync(run, template, { recursive: true, verbatimSymlinks: true });
}

export function assertOwnedRoot(root, app) {
  const resolved = resolve(root);
  if (!resolved.startsWith(realpathSync("/tmp")) && !resolved.startsWith(resolve(TAU_ROOT, ".tau-dev"))) {
    throw new Error(`${app.label}: refusing to use ${resolved}; roots live under /tmp or .tau-dev`);
  }
  return resolved;
}
