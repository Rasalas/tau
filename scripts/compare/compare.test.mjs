import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServer } from "../../kits/codex/app-server.ts";
import { parseCodexSession } from "../../kits/codex/history-import.ts";
import { APPS, resetRunFromTemplate } from "./apps.mjs";
import { codexNotifications } from "./fake-codex.mjs";
import { assertEnvUnder, forbiddenPaths, openForbiddenFiles, parseLsofNames } from "./isolation.mjs";
import { descendants, parseFootprint, parsePs, processRole } from "./processes.mjs";
import { evaluateBudgets, markdownTable, parseArgs } from "./run.mjs";
import { loadScreens, parseArgs as parseScreenArgs, shotName } from "./screens/run.mjs";
import { MEASURE, TAB_ORDER } from "./screens/measure.mjs";
import { rolloutLines, sessionPlan, writeCodexSessions } from "./sessions-fixture.mjs";
import { largeThreadRows, writePiThread } from "./large-thread.mjs";
import { aggregateRuns, frameStats, percentile } from "./stats.mjs";
import { buildTurn, END_SENTINEL, FIRST_SENTINEL, summarizeTurn } from "./turn-fixture.mjs";

describe("the recorded turn", () => {
  it("is deterministic", () => {
    expect(JSON.stringify(buildTurn())).toBe(JSON.stringify(buildTurn()));
  });

  it("carries what the plan asks for: 150 KB with 20 fences, a 1 MB tool output", () => {
    const summary = summarizeTurn(buildTurn());
    expect(summary.textBytes).toBeGreaterThanOrEqual(150_000);
    expect(summary.fences).toBe(20);
    expect(summary.outputBytes).toBeGreaterThanOrEqual(1_000_000);
    expect(summary.tools).toBe(6);
  });

  it("starts with the first sentinel and ends with the last one as a delta of its own", () => {
    const texts = buildTurn().events.filter((event) => event.kind === "text");
    expect(texts[0].delta).toContain(FIRST_SENTINEL);
    expect(texts.at(-1).delta.trim()).toBe(END_SENTINEL);
  });
});

describe("the fake Codex app-server", () => {
  const turn = buildTurn({ answerBytes: 3_000, codeBlocks: 2, bigOutputBytes: 30_000, smallCommands: 2 });
  const notifications = codexNotifications(turn, { threadId: "thread", turnId: "turn" });

  it("frames the turn with turn/started and turn/completed", () => {
    expect(notifications[0].method).toBe("turn/started");
    expect(notifications.at(-1).method).toBe("turn/completed");
  });

  it("streams exactly the fixture's text and tool output", () => {
    const text = notifications.filter((entry) => entry.method === "item/agentMessage/delta").map((entry) => entry.params.delta).join("");
    const output = notifications.filter((entry) => entry.method === "item/commandExecution/outputDelta").map((entry) => entry.params.delta).join("");
    expect(text).toBe(turn.events.filter((event) => event.kind === "text").map((event) => event.delta).join(""));
    expect(output.length).toBe(summarizeTurn(turn).outputBytes);
  });

  it("closes every item it opens, in time order", () => {
    const started = notifications.filter((entry) => entry.method === "item/started").map((entry) => entry.params.item.id);
    const completed = notifications.filter((entry) => entry.method === "item/completed").map((entry) => entry.params.item.id);
    expect(completed.sort()).toEqual(started.sort());
    const times = notifications.map((entry) => entry.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe("the stand-in behind a seeded root", () => {
  const policy = { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } };

  it("runs this checkout's stand-in although another checkout seeded the root, and plays a turn to the Codex kit's client", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "compare-shim-"));
    mkdirSync(APPS.tau.paths(root).template, { recursive: true });
    mkdirSync(join(root, "bin"));
    // What a root seeded from a since-removed worktree carries.
    writeFileSync(join(root, "bin", "codex"), `#!/bin/sh\nexec "${process.execPath}" /gone/worktree/scripts/compare/fake-codex.mjs "$@"\n`, { mode: 0o755 });
    const turn = buildTurn({ answerBytes: 2_000, codeBlocks: 1, bigOutputBytes: 10_000, smallCommands: 1, intervalMs: 1 });
    writeFileSync(join(root, "turn.json"), JSON.stringify(turn));
    resetRunFromTemplate(APPS.tau, root);

    const env = APPS.tau.env(root);
    const deltas = [];
    let completed;
    const turnCompleted = new Promise((resolvePromise) => { completed = resolvePromise; });
    const server = await CodexAppServer.open({
      command: env.TAU_CODEX_COMMAND,
      cwd: root,
      env,
      clientVersion: "0",
      onNotification: (method, params) => {
        if (method === "item/agentMessage/delta") deltas.push(params.delta);
        if (method === "turn/completed") completed(params);
      },
      onRequest: async () => ({}),
    });
    try {
      expect(await server.account()).toEqual({ type: "apiKey" });
      const [model] = await server.models();
      const started = await server.startThread({ cwd: root, model: model.id, policy });
      const resumed = await server.resumeThread({ threadId: started.thread.id, cwd: root, policy });
      expect(resumed.thread.id).toBe(started.thread.id);
      await server.startTurn({ threadId: started.thread.id, input: [{ type: "text", text: "go", text_elements: [] }], policy, model: model.id });
      expect((await turnCompleted).turn.status).toBe("completed");
      expect(deltas.join("")).toBe(turn.events.filter((event) => event.kind === "text").map((event) => event.delta).join(""));
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("thinking in the replayed turn", () => {
  it("is off by default, so the benchmark's turn is unchanged", () => {
    expect(buildTurn().events.some((event) => event.kind === "thinking")).toBe(false);
  });

  it("becomes one reasoning item that closes before the answer starts", () => {
    const turn = buildTurn({ answerBytes: 500, codeBlocks: 0, bigOutputBytes: 100, smallCommands: 0, thinkingChars: 600 });
    const notifications = codexNotifications(turn, { threadId: "thread", turnId: "turn" });
    const methods = notifications.map((entry) => `${entry.method}:${entry.params.item?.type ?? ""}`);
    const completed = methods.indexOf("item/completed:reasoning");
    expect(methods.indexOf("item/started:reasoning")).toBeLessThan(completed);
    expect(completed).toBeLessThan(methods.indexOf("item/started:agentMessage"));
    const summary = notifications.filter((entry) => entry.method === "item/reasoning/summaryTextDelta").map((entry) => entry.params.delta).join("");
    expect(summary).toHaveLength(600);
    expect(notifications[completed].params.item.summary).toEqual([summary]);
  });
});

describe("a failing turn", () => {
  it("reports the error and completes the turn as failed", () => {
    const notifications = codexNotifications(buildTurn({ failWith: "stream disconnected" }), { threadId: "thread", turnId: "turn" });
    expect(notifications.find((entry) => entry.method === "error").params).toMatchObject({ error: { message: "stream disconnected" }, willRetry: false });
    expect(notifications.at(-1).params.turn).toMatchObject({ status: "failed", error: { message: "stream disconnected" } });
  });
});

describe("the session fixture", () => {
  it("is read by Tau's own Codex importer, the large thread capped at its 200 messages", () => {
    const [large, small] = sessionPlan();
    const parsedLarge = parseCodexSession(rolloutLines(large, { id: "id-large", cwd: "/work", startMs: Date.now() }), Date.now());
    const parsedSmall = parseCodexSession(rolloutLines(small, { id: "id-small", cwd: "/work", startMs: Date.now() }), Date.now());
    expect(parsedLarge.messages).toHaveLength(200);
    expect(parsedLarge.title).toBe(large.title);
    expect(parsedSmall.messages).toHaveLength(small.turns * 2);
  });

  it("writes rollouts in the CLI's dated layout, newest first by mtime", () => {
    const home = mkdtempSync(join(tmpdir(), "compare-sessions-"));
    const written = writeCodexSessions(home, { cwd: "/work", now: Date.parse("2026-09-23T12:00:00Z") });
    expect(written).toHaveLength(sessionPlan().length);
    for (const entry of written) expect(entry.path).toMatch(/sessions\/2026\/09\/2[23]\/rollout-.+\.jsonl$/u);
    expect(readdirSync(join(home, "sessions", "2026", "09")).length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(written[0].path, "utf8").split("\n")[0]).type).toBe("session_meta");
  });
});

describe("isolation", () => {
  const root = join(realpathSync(tmpdir()), "compare-root");

  it("accepts an env whose data paths all sit under the app's root", () => {
    expect(() => assertEnvUnder({ HOME: join(root, "home"), OTHER: "x" }, ["HOME"], root)).not.toThrow();
  });

  it("rejects a data path outside the root, a missing one, and any value pointing into the user's app data", () => {
    expect(() => assertEnvUnder({ HOME: "/Users/someone" }, ["HOME"], root)).toThrow(/outside/u);
    expect(() => assertEnvUnder({}, ["HOME"], root)).toThrow(/not set/u);
    expect(() => assertEnvUnder({ HOME: join(root, "home"), LEAK: forbiddenPaths()[0] }, ["HOME"], root)).toThrow(/points into/u);
  });

  it("builds both apps' environments without inheriting the caller's", () => {
    const tauEnv = APPS.tau.env(join(root, "tau"));
    const t3Env = APPS.t3.env(join(root, "t3"), { backendPort: 1234 });
    for (const env of [tauEnv, t3Env]) {
      expect(env.HOME).toBe(env.CFFIXED_USER_HOME);
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(env.PATH.split(":")[0]).toMatch(/\/bin$/u);
    }
    expect(t3Env.T3CODE_HOME.startsWith(join(root, "t3"))).toBe(true);
    expect(t3Env.T3CODE_TELEMETRY_ENABLED).toBe("false");
    expect(tauEnv.TAU_USER_DATA.startsWith(join(root, "tau"))).toBe(true);
  });

  it("finds open files inside forbidden directories from lsof output", () => {
    const home = "/Users/someone";
    const output = ["p1", "n/private/tmp/ok", `n${home}/.t3/userdata/state.sqlite`, `n${home}/Library/Application Support/t3code/Cookies`, `n${home}/Library/Fonts/a.ttf`].join("\n");
    expect(parseLsofNames(output)).toHaveLength(4);
    expect(openForbiddenFiles([1], { home, run: () => output })).toEqual([`${home}/.t3/userdata/state.sqlite`, `${home}/Library/Application Support/t3code/Cookies`]);
  });
});

describe("processes", () => {
  const rows = parsePs([
    "  10     1  1000 /x/Electron.app/Contents/MacOS/Electron .",
    "  11    10  2000 /x/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/x --type=renderer",
    "  12    10  3000 /x/Electron.app/Contents/MacOS/Electron /x/dist-electron/main/headless.js",
    "  13    12   500 /usr/bin/node /x/scripts/compare/fake-codex.mjs app-server",
    "  20     1  9999 /Applications/Other.app/Contents/MacOS/Other",
  ].join("\n"));

  it("walks only the tree under the given root", () => {
    expect(descendants(rows, [10]).map((row) => row.pid).sort()).toEqual([10, 11, 12, 13]);
  });

  it("tells the backend from the window and leaves the fake CLI out", () => {
    expect(rows.map((row) => processRole(row.command))).toEqual(["main", "renderer", "backend", "excluded", "other"]);
  });

  it("reads each process's footprint from macOS's footprint tool", () => {
    const output = [
      "======================================================================",
      "Electron [12]: 64-bit    Footprint: 157286400 B (16384 bytes per page)",
      "======================================================================",
      "Electron Helper (Renderer) [11]: 64-bit    Footprint: 2523520 B (16384 bytes per page)",
      "Summary Footprint: 159809920 B",
    ].join("\n");
    expect([...parseFootprint(output)]).toEqual([[12, 157_286_400], [11, 2_523_520]]);
  });
});

describe("stats and reporting", () => {
  it("interpolates percentiles and summarizes frames", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(frameStats([0, 16, 32, 80])).toMatchObject({ frames: 3, dropped: 1, max: 48 });
  });

  it("aggregates numeric leaves across runs", () => {
    expect(aggregateRuns([{ a: { b: 1 } }, { a: { b: 3 } }])["a.b"]).toEqual({ median: 2, p95: 2.9, n: 2 });
  });

  it("fails a budget the median exceeds, and one that was not measured", () => {
    const aggregate = { "replay.wire.receivedKiB": { median: 12 } };
    expect(evaluateBudgets(aggregate, { "replay.wire.receivedKiB": 10 })).toEqual(["replay.wire.receivedKiB median 12 > budget 10"]);
    expect(evaluateBudgets(aggregate, { "replay.wire.receivedKiB": 20, "replay.wire.received": 5 })).toEqual(["replay.wire.received was not measured"]);
  });

  it("parses flags and refuses unknown ones", () => {
    expect(parseArgs(["--apps", "tau", "--runs", "3", "--check"])).toMatchObject({ apps: ["tau"], runs: 3, check: true });
    expect(() => parseArgs(["--nope"])).toThrow(/unknown flag/u);
    expect(() => parseArgs(["--apps", "vscode"])).toThrow(/unknown app/u);
    expect(parseArgs(["--large-thread", "--apps", "tau,t3"])).toMatchObject({ largeThread: true, apps: ["tau"] });
  });

  it("renders a side-by-side table from a report", () => {
    const table = markdownTable({
      apps: { tau: { app: "Tau" }, t3: { app: "T3 Code" } },
      turn: { durationMs: 100 },
      aggregate: { tau: { "startup.firstPaintMs": { median: 10, p95: 12 } }, t3: {} },
      results: { tau: [], t3: [] },
    });
    expect(table).toContain("| metric (median / p95) | Tau | T3 Code |");
    expect(table).toContain("| first paint (ms) | 10 / 12 | – |");
  });
});

describe("the screen comparison", () => {
  it("names a capture by screen, state, app, tag and scheme", () => {
    expect(shotName({ screen: "02-rail", app: "t3", scheme: "dark" })).toBe("02-rail-t3-dark.png");
    expect(shotName({ screen: "03-row-menu", state: "menu", app: "tau", tag: "t3like", scheme: "light" })).toBe("03-row-menu-menu-tau-t3like-light.png");
  });

  it("parses flags, and keeps a Tau theme away from T3", () => {
    expect(parseScreenArgs(["--apps", "tau", "--screens", "02,05", "--theme", "t3-like"])).toMatchObject({ apps: ["tau"], screens: ["02", "05"], theme: "t3-like", schemes: ["dark", "light"] });
    expect(() => parseScreenArgs(["--theme", "t3-like"])).toThrow(/Tau only/u);
    expect(() => parseScreenArgs(["--schemes", "sepia"])).toThrow(/unknown scheme/u);
  });

  it("has a script or a stated reason for every screen in both apps", async () => {
    const screens = await loadScreens();
    expect(screens.length).toBeGreaterThanOrEqual(12);
    for (const screen of screens) {
      expect(screen.id).toMatch(/^\d\d-[a-z-]+$/u);
      expect(screen.title).toBeTruthy();
      for (const id of ["tau", "t3"]) expect(typeof screen[id] === "function" || Boolean(screen.skip?.[id])).toBe(true);
    }
  });

  it("ships page code that parses", () => {
    expect(() => new Function(`return ${MEASURE}`)).not.toThrow();
    expect(() => new Function(`return ${TAB_ORDER}`)).not.toThrow();
  });
});

describe("the large Pi thread", () => {
  const root = join(import.meta.dirname, "..", "..");

  it("writes four entries a turn, its tag in every prompt, with the modification time asked for", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tau-compare-large-"));
    const modifiedAt = new Date(Date.now() - 3_600_000);
    const { path, entries } = await writePiThread(root, { sessionDir: dir, cwd: dir, title: "Large Pi thread", turns: 3, tag: "run-x", modifiedAt });
    expect(entries).toBe(13);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const prompts = lines.filter((line) => line.message?.role === "user").map((line) => line.message.content[0].text);
    expect(prompts.at(-1)).toBe("Question 2: what does file 2 contain? run-x");
    expect(Math.abs(statSync(path).mtimeMs - modifiedAt.getTime())).toBeLessThan(1_000);
  });

  it("gates only what its table reports", () => {
    const budgets = JSON.parse(readFileSync(join(import.meta.dirname, "budgets.json"), "utf8")).tauLargeThread;
    const paths = new Set(largeThreadRows().map(([, path]) => path));
    expect(Object.keys(budgets).length).toBeGreaterThan(0);
    for (const path of Object.keys(budgets)) expect(paths.has(path)).toBe(true);
  });
});
