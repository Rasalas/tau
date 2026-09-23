// Decodes everything fake-codex.mjs says with T3's generated Codex protocol
// schemas, so a shape T3 would reject fails here instead of mid-benchmark.
// Run with Node 24 (type stripping): node fake-codex-conformance.mjs <t3-clone>
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { buildTurn } from "./turn-fixture.mjs";

const clone = process.argv[2];
if (!clone) throw new Error("usage: node fake-codex-conformance.mjs <t3-clone>");
const generated = join(clone, "packages/effect-codex-app-server/src/_generated");
const meta = await import(join(generated, "meta.gen.ts"));
const { Schema } = await import(join(clone, "packages/effect-codex-app-server/node_modules/effect/dist/index.js"));

const dir = mkdtempSync(join(tmpdir(), "fake-codex-check-"));
const turnFile = join(dir, "turn.json");
writeFileSync(turnFile, JSON.stringify(buildTurn({ answerBytes: 2_000, codeBlocks: 2, bigOutputBytes: 20_000, smallCommands: 1, intervalMs: 1, thinkingChars: 300 })));
const child = spawn(process.execPath, [fileURLToPath(new URL("./fake-codex.mjs", import.meta.url)), "app-server"], {
  env: { ...process.env, COMPARE_TURN_FILE: turnFile, CODEX_HOME: dir },
  stdio: ["pipe", "pipe", "inherit"],
});
const received = [];
const lines = createInterface({ input: child.stdout });
let done;
const finished = new Promise((resolve) => { done = resolve; });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  received.push(message);
  if (message.method === "turn/completed") done();
});
const requests = [
  ["initialize", { clientInfo: { name: "check", version: "0" }, capabilities: null }],
  ["account/read", {}],
  ["model/list", {}],
  ["skills/list", { cwds: [dir] }],
  ["thread/start", { cwd: dir }],
];
let id = 0;
const sent = new Map();
for (const [method, params] of requests) {
  sent.set(++id, method);
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
}
await new Promise((resolve) => setTimeout(resolve, 300));
const threadId = received.find((message) => sent.get(message.id) === "thread/start")?.result?.thread?.id;
sent.set(++id, "turn/start");
child.stdin.write(`${JSON.stringify({ id, method: "turn/start", params: { threadId, input: [{ type: "text", text: "go", text_elements: [] }] } })}\n`);
await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 10_000))]);
child.stdin.end();

const failures = [];
const check = (label, schema, value) => {
  if (!schema) { failures.push(`${label}: no schema`); return; }
  try { Schema.decodeUnknownSync(schema)(value); } catch (error) { failures.push(`${label}: ${String(error.message).slice(0, 600)}`); }
};
for (const message of received) {
  if (message.id !== undefined) check(`response ${sent.get(message.id)}`, meta.CLIENT_REQUEST_RESPONSES[sent.get(message.id)], message.result);
  else check(`notification ${message.method}`, meta.SERVER_NOTIFICATION_PARAMS[message.method], message.params);
}
console.log(JSON.stringify({ messages: received.length, methods: [...new Set(received.map((message) => message.method ?? `response:${sent.get(message.id)}`))], failures }, null, 2));
if (failures.length) process.exitCode = 1;
