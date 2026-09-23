import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexSession } from "../../kits/codex/history-import.ts";
import { APPS } from "./apps.mjs";
import { codexNotifications } from "./fake-codex.mjs";
import { assertEnvUnder, forbiddenPaths, openForbiddenFiles, parseLsofNames } from "./isolation.mjs";
import { descendants, parsePs, processRole } from "./processes.mjs";
import { evaluateBudgets, markdownTable, parseArgs } from "./run.mjs";
import { rolloutLines, sessionPlan, writeCodexSessions } from "./sessions-fixture.mjs";
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
