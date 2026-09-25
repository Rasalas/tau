// A fake model on 127.0.0.1 that speaks OpenAI's streamed chat completions,
// so a Pi runtime on a test host runs real turns without a login or a paid
// model. It answers from the last user message:
//   "write <path> <word>"  → a `write` tool call, then "done" after the result
//   "wait <ms>"            → a first delta, the pause (for aborts), then "ok"
//   anything else          → "ok"
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

export const FAKE_PROVIDER = "tau-fake";
export const FAKE_MODEL = "fake-1";

function text(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  return "";
}

/** What the fake says to a request body: `{ text }`, `{ toolCall }`, or `{ text, waitMs }`. */
export function fakeReply(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages.at(-1);
  if (last?.role === "tool") return { text: "done" };
  const prompt = text([...messages].reverse().find((message) => message.role === "user")?.content).trim();
  const write = prompt.match(/\bwrite\s+(\S+)\s+(\S+)/u);
  if (write) return { toolCall: { name: "write", arguments: { path: write[1], content: `${write[2]}\n` } } };
  const wait = prompt.match(/\bwait\s+(\d+)\b/u);
  if (wait) return { text: "ok", waitMs: Math.min(Number(wait[1]), 120_000) };
  return { text: "ok" };
}

/** Starts the fake; `respond(body)` overrides `fakeReply`. Resolves with `baseUrl`, the `requests` seen and `close`. */
export async function startFakeModelServer({ respond = fakeReply } = {}) {
  const requests = [];
  const open = new Set();
  let counter = 0;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", async () => {
      let body;
      try { body = JSON.parse(raw); } catch { body = {}; }
      requests.push(body);
      const reply = respond(body);
      const id = `chatcmpl-fake-${++counter}`;
      const model = typeof body.model === "string" ? body.model : FAKE_MODEL;
      const chunk = (choice, extra = {}) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model, choices: choice ? [{ index: 0, ...choice }] : [], ...extra })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      let closed = false;
      const gone = new Promise((resolve) => response.on("close", () => { closed = true; resolve(); }));
      response.write(chunk({ delta: { role: "assistant", content: "" }, finish_reason: null }));
      if (reply.toolCall) {
        response.write(chunk({ delta: { tool_calls: [{ index: 0, id: `call_${counter}`, type: "function", function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.arguments) } }] }, finish_reason: null }));
        response.write(chunk({ delta: {}, finish_reason: "tool_calls" }));
      } else {
        if (reply.waitMs) {
          response.write(chunk({ delta: { content: "…" }, finish_reason: null }));
          // An abort closes the response; the pause ends with it.
          let timer;
          await Promise.race([gone, new Promise((resolve) => { timer = setTimeout(resolve, reply.waitMs); })]);
          clearTimeout(timer);
          if (closed) return;
        }
        response.write(chunk({ delta: { content: reply.text }, finish_reason: null }));
        response.write(chunk({ delta: {}, finish_reason: "stop" }));
      }
      response.write(chunk(undefined, { usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } }));
      response.end("data: [DONE]\n\n");
    });
  });
  server.on("connection", (socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    close: () => new Promise((resolve) => {
      for (const socket of open) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

/** Pi's `models.json` provider for the fake; a price so a thread's cost is above zero. */
export function fakeModelsJson(baseUrl) {
  return {
    providers: {
      [FAKE_PROVIDER]: {
        name: "Tau fake",
        baseUrl,
        api: "openai-completions",
        apiKey: "fake",
        models: [{ id: FAKE_MODEL, name: "Fake 1", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 4_096, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
      },
    },
  };
}

/** A Pi agent dir that knows only the fake and uses it by default; nothing is linked from the real ~/.pi. */
export function prepareFakePiAgentDir(agentDir, baseUrl) {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), `${JSON.stringify(fakeModelsJson(baseUrl), null, 2)}\n`);
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ defaultProvider: FAKE_PROVIDER, defaultModel: FAKE_MODEL }, null, 2)}\n`);
}
