// Synthetic Codex rollouts both apps import through onboarding (gap analysis
// §2.3). Only user and assistant text: that is all Tau's importer keeps, so
// tool records would make the two apps show different threads.
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answerMarkdown } from "./turn-fixture.mjs";
import { FAKE_CODEX_VERSION } from "./fake-codex.mjs";

function uuid(seed) {
  const hex = (value) => (value >>> 0).toString(16).padStart(8, "0");
  const a = hex(Math.imul(seed + 1, 0x9e3779b1));
  const b = hex(Math.imul(seed + 7, 0x85ebca6b));
  const c = hex(Math.imul(seed + 13, 0xc2b2ae35));
  const d = hex(Math.imul(seed + 29, 0x27d4eb2f));
  // Version 7 layout, so ids look like the ones Codex writes.
  return `${a}-${b.slice(0, 4)}-7${b.slice(5, 8)}-8${c.slice(1, 4)}-${c.slice(4)}${d}`;
}

function assistantReply(thread, turn, heavy) {
  if (!heavy) return `Turn ${turn + 1} of ${thread.title}: checked the change, the tests pass and nothing else needs doing.`;
  // Every fourth reply carries fences and a table, the rest are short prose.
  return turn % 4 === 0 ? answerMarkdown({ targetBytes: 2_400, codeBlocks: 1 }) : `Reply ${turn + 1}: the ${thread.title.toLowerCase()} path is fine; ${"the renderer keeps one row per message and only the streaming row updates. ".repeat(3)}`;
}

/**
 * The sessions the fixture home holds: the large one first, so it is the newest.
 * The two switch threads come last: no run has opened them before the switch step.
 */
export function sessionPlan({ largeTurns = 100, smallThreads = 4, smallTurns = 6, switchThreads = true } = {}) {
  const plan = [{ title: "Large thread: transcript scroll fixture", turns: largeTurns, heavy: true }];
  for (let index = 0; index < smallThreads; index += 1) plan.push({ title: `Small thread ${index + 1}: follow-up on the rail`, turns: smallTurns, heavy: false });
  if (switchThreads) {
    plan.push({ title: "Medium thread: switch fixture", turns: 30, heavy: true });
    plan.push({ title: "Long thread: switch fixture", turns: 100, heavy: true });
  }
  return plan;
}

/** The start of a thread's newest reply, as both apps show it in the transcript. */
export function newestReplyText(thread) {
  return assistantReply(thread, thread.turns - 1, thread.heavy).slice(0, 60);
}

/** One rollout file's lines, in the shape a 0.154 CLI writes. */
export function rolloutLines(thread, { id, cwd, startMs }) {
  const at = (offset) => new Date(startMs + offset * 1000).toISOString();
  const lines = [
    { timestamp: at(0), type: "session_meta", payload: { id, timestamp: at(0), cwd, originator: "codex_cli_rs", cli_version: FAKE_CODEX_VERSION, source: "cli", model_provider: "openai", instructions: null } },
    { timestamp: at(0), type: "turn_context", payload: { cwd, approval_policy: "never", sandbox_policy: { type: "danger-full-access" }, model: "gpt-5.6-luna", effort: "low", summary: "auto" } },
  ];
  for (let turn = 0; turn < thread.turns; turn += 1) {
    const user = turn === 0 ? thread.title : `Follow-up ${turn + 1}: look at the next part of ${thread.title.toLowerCase()}.`;
    const reply = assistantReply(thread, turn, thread.heavy);
    const offset = 1 + turn * 10;
    lines.push(
      { timestamp: at(offset), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: user }] } },
      { timestamp: at(offset), type: "event_msg", payload: { type: "user_message", message: user, images: [], kind: "plain" } },
      { timestamp: at(offset + 5), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: reply }] } },
      { timestamp: at(offset + 5), type: "event_msg", payload: { type: "agent_message", message: reply } },
    );
  }
  return lines.map((line) => JSON.stringify(line));
}

/**
 * Writes the plan under `<codexHome>/sessions/YYYY/MM/DD/`, with mtimes in
 * plan order (newest first). Returns what was written.
 */
export function writeCodexSessions(codexHome, { cwd, now = Date.now(), ...options }) {
  // Both importers only offer sessions from the last 30 days.
  const base = now - 2 * 3_600_000;
  const written = [];
  sessionPlan(options).forEach((thread, index) => {
    const startMs = base - index * 3_600_000;
    const date = new Date(startMs);
    const dir = join(codexHome, "sessions", String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0"));
    mkdirSync(dir, { recursive: true });
    const id = uuid(index);
    const path = join(dir, `rollout-${date.toISOString().slice(0, 19).replaceAll(":", "-")}-${id}.jsonl`);
    writeFileSync(path, `${rolloutLines(thread, { id, cwd, startMs }).join("\n")}\n`);
    const mtime = new Date(startMs + thread.turns * 10_000);
    utimesSync(path, mtime, mtime);
    written.push({ path, id, title: thread.title, turns: thread.turns });
  });
  return written;
}
