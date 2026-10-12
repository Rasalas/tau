#!/usr/bin/env node
// What one model request weighs: a fake model that records the system prompt and
// the tool declarations of every request it gets, so a dev instance pointed at it
// (`--agent-dir <dir>`) shows what the kits' tools cost per turn.
//
//   node scripts/measure-request-weight.mjs [--dir .tau-dev/request-weight]
//   npm run dev:instance -- --build --fresh --agent-dir .tau-dev/request-weight/pi-agent
//
// Send any prompt in a thread; each request appends a summary line to
// `<dir>/requests.jsonl` and its body to `<dir>/request-<n>.json`. Tokens are
// chars / 4, the estimate Pi itself uses: there is no tokenizer in node_modules.
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fakeReply, prepareFakePiAgentDir, startFakeModelServer } from "./fake-model-server.mjs";

const CHARS_PER_TOKEN = 4;
const tokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);

function text(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  return "";
}

/** Chars of the system prompt and of the tool declarations, and the declared names. */
export function weigh(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = messages.filter((message) => message.role === "system" || message.role === "developer").map((message) => text(message.content)).join("\n");
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const declarations = tools.map((tool) => JSON.stringify(tool));
  return {
    systemChars: system.length,
    toolCount: tools.length,
    toolChars: declarations.reduce((sum, declaration) => sum + declaration.length, 0),
    totalChars: system.length + declarations.reduce((sum, declaration) => sum + declaration.length, 0),
    tools: tools.map((tool, index) => ({ name: tool.function?.name ?? tool.name, chars: declarations[index].length })),
  };
}

export function summary(weight) {
  return { ...weight, systemTokens: tokens(weight.systemChars), toolTokens: tokens(weight.toolChars), totalTokens: tokens(weight.totalChars) };
}

async function main() {
  const flag = process.argv.indexOf("--dir");
  const dir = resolve(flag > 0 ? process.argv[flag + 1] : ".tau-dev/request-weight");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let count = 0;
  const server = await startFakeModelServer({
    respond: (body) => {
      count += 1;
      writeFileSync(join(dir, `request-${count}.json`), JSON.stringify(body));
      const { tools, ...rest } = summary(weigh(body));
      appendFileSync(join(dir, "requests.jsonl"), `${JSON.stringify({ n: count, ...rest, toolNames: tools.map((tool) => tool.name) })}\n`);
      return fakeReply(body);
    },
  });
  const agentDir = join(dir, "pi-agent");
  prepareFakePiAgentDir(agentDir, server.baseUrl);
  console.log(JSON.stringify({ baseUrl: server.baseUrl, agentDir, log: join(dir, "requests.jsonl") }));
  const stop = () => { void server.close().finally(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
