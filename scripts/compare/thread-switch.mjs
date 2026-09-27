// Switching threads from the rail (ticket K38): the time from the press on a
// row to the thread's newest reply painted beside a composer, for a short, a
// medium and a long thread, the first time (cold) and again (warm).
// Both apps switch between the same imported Codex threads; Tau also between
// Pi threads, which T3 cannot hold.
import { execFileSync } from "node:child_process";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { newestReplyText, sessionPlan } from "./sessions-fixture.mjs";
import { median, round } from "./stats.mjs";

/** Opened first, so every app starts the sequence from a thread on screen. */
export const STARTER_TITLE = "Small thread 4";
/** Rounds after the cold one; each switches to every target once more. */
export const WARM_ROUNDS = 3;
/** The switch is over once the newest reply has not moved for this long. */
export const SETTLE_QUIET_MS = 500;
export const SWITCH_TIMEOUT_MS = 15_000;

function codexTarget(size, titlePrefix) {
  const thread = sessionPlan().find((entry) => entry.title.startsWith(titlePrefix));
  if (!thread) throw new Error(`the session fixture has no thread "${titlePrefix}"`);
  return { size, kind: "codex", title: thread.title, row: new RegExp(escape(titlePrefix), "u"), text: newestReplyText(thread), turns: thread.turns };
}

function escape(text) {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** The imported threads both apps switch between. */
export function codexTargets() {
  return [codexTarget("short", "Small thread 2"), codexTarget("medium", "Medium thread"), codexTarget("long", "Long thread")];
}

/** Pi threads shaped like an agent's work: reads, searches, edits with diffs, test runs, Markdown answers. */
export const PI_SWITCH_THREADS = [
  { size: "short", title: "Short Pi switch thread", turns: 3 },
  { size: "medium", title: "Medium Pi switch thread", turns: 12 },
  { size: "long", title: "Long Pi switch thread", turns: 40 },
];

const answerMark = (title, turn) => `${title}: turn ${turn + 1} is done`;

/** Tau's Pi threads; each final answer names its thread and turn. */
export function piTargets() {
  return PI_SWITCH_THREADS.map(({ size, title, turns }) => ({
    size, kind: "pi", title, row: new RegExp(escape(title), "u"), text: answerMark(title, turns - 1), turns,
  }));
}

function sourceFile(turn, lines) {
  const out = [`import { readFile } from "node:fs/promises";`, ""];
  for (let line = 0; out.length < lines; line += 1) {
    out.push(`export async function step${turn}_${line}(path: string): Promise<number> {`, `  const text = await readFile(path, "utf8"); // module ${turn}, part ${line}`, "  return text.split(\"\\n\").length;", "}", "");
  }
  return out.slice(0, lines).join("\n");
}

function finalAnswer(title, turn) {
  return [
    `${answerMark(title, turn)}. The change keeps the parser's contract and moves the cache behind one seam.`,
    "",
    "What changed:",
    "",
    `- \`src/module-${turn}.ts\` reads the file once and hands the lines on;`,
    "- the caller no longer re-reads it after every edit;",
    "- the tests cover the empty file and a file without a trailing newline.",
    "",
    "```ts",
    `export async function count${turn}(path: string): Promise<number> {`,
    "  const lines = await cachedLines(path);",
    "  return lines.filter((line) => line.trim().length > 0).length;",
    "}",
    "```",
    "",
    "| check | before | after |",
    "| --- | ---: | ---: |",
    `| reads per call | ${turn + 2} | 1 |`,
    "| tests | 41 | 44 |",
    "",
    "Nothing else needed touching; the build and the linter pass.",
  ].join("\n");
}

/**
 * Writes a Pi session the way an agent's work looks: per turn a prompt,
 * thinking, a read of a 150-line file, a search, an edit with its diff, a
 * test run and a Markdown answer with a fence and a table. In a Git
 * workspace each turn also gets Workspace Kit's checkpoint: its entry and
 * its before/after refs on the workspace's tree.
 */
export async function writeAgentPiThread(tauRoot, { sessionDir, cwd, title, turns, endsAt, checkpoints = true }) {
  const pi = await import(pathToFileURL(join(tauRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href);
  const manager = pi.SessionManager.create(cwd, sessionDir);
  manager.appendSessionInfo(title);
  const sessionId = manager.getSessionId();
  const tree = checkpoints ? execFileSync("git", ["-C", cwd, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim() : undefined;
  const refs = [];
  const step = 10_000;
  let at = endsAt - turns * 8 * step;
  const next = () => (at += step);
  const usage = { input: 1_200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1_500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (content) => ({ role: "assistant", content, api: "openai-responses", provider: "openai", model: "gpt-5.6-luna", usage, stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop", timestamp: next() });
  const result = (id, toolName, text, details) => ({ role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }], ...(details ? { details } : {}), isError: false, timestamp: next() });
  for (let turn = 0; turn < turns; turn += 1) {
    const file = `src/module-${turn}.ts`;
    const before = sourceFile(turn, 150);
    const after = before.replace("  return text.split", "  const lines = text.split(\"\\n\");\n  return lines");
    const promptId = manager.appendMessage({ role: "user", content: [{ type: "text", text: `Turn ${turn + 1}: ${file} reads the same file on every call. Make it read once, keep the public functions as they are, and run the tests.` }], timestamp: next() });
    const startedAt = at;
    manager.appendMessage(assistant([
      { type: "thinking", thinking: `The module re-reads the file per call. ${"I should read it first and then look for the callers before editing. ".repeat(4)}` },
      { type: "toolCall", id: `read-${turn}`, name: "read", arguments: { path: file } },
    ]));
    manager.appendMessage(result(`read-${turn}`, "read", before));
    manager.appendMessage(assistant([{ type: "toolCall", id: `grep-${turn}`, name: "bash", arguments: { command: `rg -n "step${turn}_" src` } }]));
    manager.appendMessage(result(`grep-${turn}`, "bash", Array.from({ length: 40 }, (_, line) => `src/caller-${line}.ts:${line + 10}:  await step${turn}_${line}(path);`).join("\n")));
    const diff = pi.generateDiffString(before, after);
    manager.appendMessage(assistant([{ type: "toolCall", id: `edit-${turn}`, name: "edit", arguments: { path: file, edits: [{ oldText: "  return text.split", newText: "  const lines = text.split(\"\\n\");\n  return lines" }] } }]));
    manager.appendMessage(result(`edit-${turn}`, "edit", `Successfully replaced 1 block(s) in ${file}.`, { diff: diff.diff, firstChangedLine: diff.firstChangedLine }));
    manager.appendMessage(assistant([{ type: "toolCall", id: `test-${turn}`, name: "bash", arguments: { command: "npm test" } }]));
    manager.appendMessage(result(`test-${turn}`, "bash", Array.from({ length: 60 }, (_, line) => ` ✓ src/module-${line}.test.ts (${line % 7 + 1} tests) ${line * 3 + 4}ms`).join("\n")));
    manager.appendMessage(assistant([{ type: "text", text: finalAnswer(title, turn) }]));
    if (tree) {
      const turnId = `turn-${turn}`;
      const ref = (phase) => `refs/tau/checkpoints/${sessionId}/${turnId}/${phase}`;
      refs.push(ref("before"), ref("after"));
      manager.appendCustomEntry("tau.turn-checkpoint.v1", {
        id: turnId, turnId, sessionId, anchorMessageId: promptId,
        beforeSnapshotId: ref("before"), afterSnapshotId: ref("after"),
        startedAt, endedAt: at, files: [], added: 2, removed: 1,
      });
    }
  }
  if (tree) execFileSync("git", ["-C", cwd, "update-ref", "--stdin"], { input: refs.map((ref) => `create ${ref} ${tree}\n`).join("") });
  const path = manager.getSessionFile();
  utimesSync(path, new Date(endsAt), new Date(endsAt));
  return { path, entries: manager.getEntries().length };
}

/**
 * Arms the page before the press: the probe starts at the `mousedown` the
 * harness sends and resolves `window.__switchProbe.done` once the target's
 * newest reply is painted in view with a composer on screen and has held
 * still for SETTLE_QUIET_MS. Page code, app-neutral.
 */
export function armSwitchProbe({ text, composer, messageRow }) {
  return `(() => {
  const text = ${JSON.stringify(text)};
  const state = { downAt: undefined, visibleAt: undefined, paintedAt: undefined, lastChangeAt: undefined, changes: 0, missingFrames: 0, longTasks: [] };
  const rowFor = () => {
    for (const row of document.querySelectorAll(${JSON.stringify(messageRow)})) if (row.textContent.includes(text)) return row;
    return undefined;
  };
  const inView = () => {
    if (!document.querySelector(${JSON.stringify(composer)})) return undefined;
    const row = rowFor();
    if (!row) return undefined;
    const rect = row.getBoundingClientRect();
    if (rect.height === 0 || rect.bottom <= 0 || rect.top >= innerHeight) return undefined;
    if (!row.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return undefined;
    return rect;
  };
  const tasks = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) state.longTasks.push({ start: entry.startTime, duration: entry.duration });
  });
  tasks.observe({ type: "longtask" });
  const check = () => {
    if (state.downAt === undefined || state.visibleAt !== undefined || !inView()) return;
    state.visibleAt = performance.now();
    // The frame that paints this commit: its rAF callbacks run before paint, the task after it runs after.
    requestAnimationFrame(() => setTimeout(() => { state.paintedAt = performance.now(); }));
  };
  const observer = new MutationObserver(check);
  let last;
  state.done = new Promise((resolvePromise) => {
    const frame = (now) => {
      check();
      if (state.visibleAt !== undefined) {
        const rect = inView();
        const box = rect ? { top: Math.round(rect.top), height: Math.round(rect.height) } : undefined;
        if (!box) state.missingFrames += 1;
        if (last !== undefined && (!box || !last || box.top !== last.top || box.height !== last.height)) {
          state.changes += 1;
          state.lastChangeAt = now;
        }
        last = box ?? null;
      }
      const quietSince = Math.max(state.paintedAt ?? Infinity, state.lastChangeAt ?? 0);
      const finished = performance.now() - quietSince >= ${SETTLE_QUIET_MS};
      const timedOut = performance.now() - state.downAt > ${SWITCH_TIMEOUT_MS};
      if (!finished && !timedOut) { requestAnimationFrame(frame); return; }
      observer.disconnect();
      tasks.disconnect();
      const end = Math.max(state.paintedAt ?? 0, state.lastChangeAt ?? 0);
      const during = state.longTasks.filter((task) => task.start >= state.downAt && task.start <= end);
      resolvePromise({
        timedOut: !finished,
        visibleMs: state.paintedAt === undefined ? null : state.paintedAt - state.downAt,
        settledMs: state.paintedAt === undefined ? null : end - state.downAt,
        changes: state.changes,
        missingFrames: state.missingFrames,
        longTasks: during.length,
        longTaskMs: during.reduce((sum, task) => sum + task.duration, 0),
      });
    };
    addEventListener("mousedown", (event) => {
      state.downAt = event.timeStamp;
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      check();
      requestAnimationFrame(frame);
    }, { capture: true, once: true });
  });
  window.__switchProbe = state;
  return true;
})()`;
}

export const SWITCH_RESULT = "window.__switchProbe.done";

/**
 * One launch's switches, per kind and size: the cold switch as measured and
 * the median of the warm rounds.
 */
export function summarizeSwitches(switches) {
  const summary = {};
  for (const entry of switches) {
    const slot = ((summary[entry.kind] ??= {})[entry.size] ??= { cold: undefined, warm: [] });
    if (entry.round === 0) slot.cold = entry.result;
    else slot.warm.push(entry.result);
  }
  const pick = (result) => result && {
    visibleMs: round(result.visibleMs),
    settledMs: round(result.settledMs),
    changes: result.changes,
    longTaskMs: round(result.longTaskMs),
  };
  const warm = (results) => {
    if (!results.length) return undefined;
    const of = (key) => round(median(results.map((result) => result[key])));
    return { visibleMs: of("visibleMs"), settledMs: of("settledMs"), changes: of("changes"), longTaskMs: of("longTaskMs") };
  };
  const out = {};
  for (const [kind, sizes] of Object.entries(summary)) {
    for (const [size, slot] of Object.entries(sizes)) {
      (out[kind] ??= {})[size] = { cold: pick(slot.cold), warm: warm(slot.warm) };
    }
  }
  return out;
}

/** The table's rows: label and the aggregate path, both apps where the kind allows. */
export function threadSwitchRows(prefix = "threadSwitch") {
  const rows = [];
  for (const kind of ["codex", "pi"]) {
    for (const temperature of ["cold", "warm"]) {
      for (const size of ["short", "medium", "long"]) {
        const label = `switch ${kind === "pi" ? "(Tau's Pi threads) " : ""}${temperature}, ${size}: visible · settled (ms)`;
        rows.push([label, `${prefix}.${kind}.${size}.${temperature}.visibleMs`, `${prefix}.${kind}.${size}.${temperature}.settledMs`]);
      }
    }
  }
  return rows;
}
