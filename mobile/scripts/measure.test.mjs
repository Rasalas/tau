import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { parseStartOutput, parseWebView, statistics, summarize, markdown, parseOptions, selectTargets } from "./measure-results.mjs";
import { expression, openThread } from "./measure-probes.mjs";

describe("Android launch output", () => {
  it("reads TotalTime, rather than ThisTime or WaitTime", () => {
    expect(parseStartOutput("Starting: Intent {}\r\nStatus: ok\r\nThisTime: 91\r\nTotalTime: 312\r\nWaitTime: 345\r\nComplete")).toBe(312);
    expect(parseStartOutput("Status: ok\nTotalTime: 0\n")).toBe(0);
  });

  it("rejects failed, reused and incomplete launches", () => {
    for (const output of ["Status: timeout\nTotalTime: 123", "Status: ok", "Error: Activity not found\nStatus: ok\nTotalTime: 1", "Warning: Activity not started\nStatus: ok\nTotalTime: 1", "Status: ok\nTotalTime: -1", "Status: ok\nTotalTime: NaN"]) {
      expect(() => parseStartOutput(output)).toThrow();
    }
  });
});

describe("measurement statistics", () => {
  it("computes even and odd medians without changing the samples", () => {
    const values = [400, 10, 20, 30];
    expect(statistics(values)).toEqual({ count: 4, median: 25, min: 10, max: 400 });
    expect(values).toEqual([400, 10, 20, 30]);
    expect(statistics([30, 10, 20]).median).toBe(20);
  });

  it("does not turn missing or invalid measurements into zero", () => {
    for (const values of [[], [NaN], [Infinity], [-1], [null]]) expect(() => statistics(values)).toThrow();
  });

  it("excludes warm-up and keeps every target and phase separate", () => {
    const sample = (round, warmup, size, value) => ({ round, warmup, size, launch: { totalMs: value, listPaintMs: value + 10, observedMs: value + 20 }, coldMs: value + 30, warmMs: value + 40 });
    const result = summarize([sample(0, true, "short", 9999), sample(1, false, "short", 100), sample(2, false, "short", 200), sample(1, false, "long", 300)]);
    expect(result.short.nativeStart).toEqual({ count: 2, median: 150, min: 100, max: 200 });
    expect(result.short.listPaint.median).toBe(160);
    expect(result.short.coldOpen.median).toBe(180);
    expect(result.short.warmOpen.median).toBe(190);
    expect(result.long.nativeStart.count).toBe(1);
    expect(() => summarize([sample(0, true, "short", 1)])).toThrow();
  });
});

describe("options and target selection", () => {
  it("defaults to five measured rounds and one warm-up", () => {
    expect(parseOptions([])).toMatchObject({ runs: 5, warmup: 1, serial: "emulator-5554", avd: "tau_play_review", bridgePort: 9477 });
    expect(parseOptions(["--runs", "2", "--warmup", "0"]).warmup).toBe(0);
    for (const args of [["--runs", "0"], ["--warmup", "-1"], ["--runs", "2.5"], ["--serial", "physical-phone"], ["--bridge-port", "65536"], ["--bogus"], ["--targets"]]) expect(() => parseOptions(args)).toThrow();
  });

  it("records unavailable threads, but fails when none are available", () => {
    const targets = [{ size: "short", title: "Short", text: "latest short" }, { size: "long", title: "Long", text: "latest long" }];
    expect(selectTargets(targets, ["Short"])).toEqual({ selected: [targets[0]], skipped: [{ size: "long", reason: "Thread absent from list" }] });
    expect(() => selectTargets(targets, [])).toThrow();
    expect(() => selectTargets([{ size: "short", title: "", text: "" }], ["Short"])).toThrow();
    expect(() => selectTargets([...targets, targets[0]], ["Short", "Long"])).toThrow();
  });
});

it("names the WebView package that renders the app", () => {
  expect(parseWebView("Current WebView Update Service state\n  Current WebView package (name, version): (com.google.android.webview, 154.0.8037.106)\n")).toBe("com.google.android.webview 154.0.8037.106");
  expect(parseWebView("Current WebView package (name, version): (null, null)")).toBe("null null");
  expect(parseWebView("no match")).toBeUndefined();
});

it("writes an evidence summary with provenance and measurement limits", () => {
  const report = { date: "2026-10-14T12:00:00Z", commit: "abc123", dirty: false, runs: 5, warmup: 1, device: { avd: "tau_play_review", api: "36", image: "sdk/image", webview: "com.google.android.webview 154.0" }, app: { version: "0.7.41", build: "74100", apkSha256: "deadbeef" }, load: { before: "load averages: 2.1 2.2 2.3", after: "load averages: 2.4 2.5 2.6" }, skipped: [{ size: "long", reason: "Thread absent from list" }], summary: { short: { nativeStart: statistics([100, 200]), listPaint: statistics([300, 400]), observedStart: statistics([500, 600]), coldOpen: statistics([50, 60]), warmOpen: statistics([20, 30]) } } };
  const text = markdown(report);
  expect(text).toContain("abc123");
  expect(text).toContain("36");
  expect(text).toContain("WebView: com.google.android.webview 154.0");
  expect(text).toContain("150.0 | 100.0–200.0 | 2");
  expect(text).toContain("Warm-up excluded");
  expect(text).toContain("Thread absent from list");
  expect(text).toContain("physical device");
  expect(text).toContain(report.load.after);
});

it("times the newest answer in the correct thread after paint, ignoring an older answer", async () => {
  let now = 100;
  let opened = false;
  let done = false;
  const frames = [];
  const tasks = new Map();
  const location = { search: "" };
  const box = { width: 100, height: 50, top: 0, bottom: 50, left: 0, right: 100 };
  const element = () => ({ checkVisibility: () => true, getBoundingClientRect: () => box, closest: () => null, contains: () => true });
  const reply = { ...element(), textContent: "older answer" };
  const composer = element();
  const row = { ...element(), disabled: false, scrollIntoView: () => {}, closest: (selector) => selector === "[data-steady-row]" ? { getAttribute: () => "thread-1" } : null, querySelector: () => ({ textContent: "Short" }) };
  const document = {
    visibilityState: "visible", elementFromPoint: () => row,
    querySelectorAll: (selector) => selector.includes("touch-thread-open") ? [row] : opened ? [reply] : [],
    querySelector: (selector) => selector === "textarea" && opened ? composer : null,
  };
  const context = {
    document, location, innerHeight: 500, innerWidth: 400, URLSearchParams,
    performance: { now: () => now, timeOrigin: 1000 },
    tap: () => { opened = true; location.search = "?thread=thread-1"; },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: () => {},
    setTimeout: (fn, delay) => { const id = tasks.size + 1; tasks.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => tasks.delete(id),
  };
  const result = runInNewContext(expression(openThread, { title: "Short", text: "newest answer" }, 1000), context).then((value) => { done = true; return value; });
  now += 16;
  frames.shift()();
  await Promise.resolve();
  expect(done).toBe(false);
  reply.textContent = "newest answer";
  location.search = "?thread=other-thread";
  now += 16;
  frames.shift()();
  await Promise.resolve();
  expect(done).toBe(false);
  location.search = "?thread=thread-1";
  now += 16;
  frames.shift()();
  await Promise.resolve();
  expect(done).toBe(false);
  now += 16;
  frames.shift()();
  expect(done).toBe(false);
  now += 1;
  [...tasks.values()].find((task) => task.delay === 0).fn();
  expect(await result).toEqual({ ms: 65, origin: 1000 });
});
