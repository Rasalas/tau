// A fake model on 127.0.0.1 that speaks OpenAI's streamed chat completions,
// so a Pi runtime on a test host runs real turns without a login or a paid
// model. It answers from the last user message:
//   "write <path> <word>"  → a `write` tool call, then "done" after the result
//   "wait <ms>"            → a first delta, the pause (for aborts), then "ok"
//   "fail <status> <text>" → HTTP <status> with <text> as the provider's error
//   "run <seconds>"        → a `bash` call that runs `mkdir` and sleeps, then "done"
//   "think <ms>"           → reasoning streamed for <ms> before each answer (with the others too)
//   "takeover <url>"       → a line, then a `request_takeover` call for the Preview at <url>, then "done"
//                            (GET /login on this server is a sign-in page to point it at)
//   "ask one" / "ask any"  → an `ask_user_question` call, one question to pick one or several, then "done"
//   "spawn[<title>=<prompt>; …]" → one `tau_spawn_thread` call per entry in one reply, then "done"
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

/** The question the ask-user tool puts for "ask one" and "ask any"; the texts of the workbench design. */
export function fakeQuestion(multiSelect) {
  return multiSelect
    ? {
      question: "Orders have no index on created_at. Which of these may I do?",
      header: "Index",
      multiSelect: true,
      options: [
        { label: "Add an index on created_at", description: "one migration" },
        { label: "Backfill cursors for existing rows", description: "" },
        { label: "Change the default sort to id", description: "visible in the UI" },
      ],
    }
    : {
      question: "Orders are sorted by created_at, which has no index. Paginating 2M rows without one will time out on the first page. How should I proceed?",
      header: "Index",
      multiSelect: false,
      options: [
        { label: "Add an index on created_at", description: "one migration, ~40s on prod-size data" },
        { label: "Paginate by id instead", description: "no migration, but order differs from the UI" },
        { label: "Leave it — page size is small enough", description: "" },
      ],
    };
}

/** What the fake says to a request body: `{ text }`, `{ toolCall }` (a `text` streams before it), `{ toolCalls }`, `{ text, waitMs }`, or `{ status, error }`. */
export function fakeReply(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages.at(-1);
  const prompt = text([...messages].reverse().find((message) => message.role === "user")?.content).trim();
  const think = prompt.match(/\bthink\s+(\d+)\b/u);
  const thinkMs = think ? { thinkMs: Math.min(Number(think[1]), 120_000) } : {};
  if (last?.role === "tool") return { text: "done", ...thinkMs };
  const spawn = prompt.match(/\bspawn\[(.+?)\]/su);
  if (spawn) {
    const toolCalls = spawn[1].split(";").map((entry) => entry.split("=")).filter(([title, task]) => title?.trim() && task?.trim())
      .map(([title, task]) => ({ name: "tau_spawn_thread", arguments: { title: title.trim(), prompt: task.trim() } }));
    if (toolCalls.length > 0) return { toolCalls };
  }
  const ask = prompt.match(/\bask\s+(one|any)\b/u);
  if (ask) return { toolCall: { name: "ask_user_question", arguments: { questions: [fakeQuestion(ask[1] === "any")] } } };
  const write = prompt.match(/\bwrite\s+(\S+)\s+(\S+)/u);
  if (write) return { toolCall: { name: "write", arguments: { path: write[1], content: `${write[2]}\n` } } };
  const takeover = prompt.match(/\btakeover\s+(https?:\/\/\S+)/u);
  if (takeover) {
    const host = new URL(takeover[1]).hostname;
    return {
      text: "The admin page redirects to the staff sign-in. I can't enter your credentials, so I've paused here and handed the preview to you.",
      toolCall: { name: "request_takeover", arguments: { reason: `Sign in to ${host} in the preview`, target: "preview", url: takeover[1] } },
    };
  }
  const run = prompt.match(/\brun\s+(\d+)\b/u);
  if (run) return { toolCall: { name: "bash", arguments: { command: `mkdir -p fake-run && sleep ${Math.min(Number(run[1]), 120)}` } }, ...thinkMs };
  const fail = prompt.match(/\bfail\s+([45]\d\d)\s+(.+)$/su);
  if (fail) return { status: Number(fail[1]), error: fail[2].trim() };
  const wait = prompt.match(/\bwait\s+(\d+)\b/u);
  if (wait) return { text: "ok", waitMs: Math.min(Number(wait[1]), 120_000), ...thinkMs };
  return { text: "ok", ...thinkMs };
}

const SIGN_IN_PAGE = `<!doctype html><meta charset="utf-8"><title>Staff sign-in</title>
<style>body{font:14px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#fbfaf8}
form{width:300px;display:flex;flex-direction:column;gap:10px;padding:22px;border-radius:12px;background:#f0eeea}
input{padding:8px 10px;border:0;border-radius:8px;font:inherit}button{padding:8px;border:0;border-radius:8px;font:600 14px system-ui}</style>
<form><b>Staff sign-in</b><label>Email<br><input name="email" value="you@shop.local"></label>
<label>Password<br><input name="password" type="password"></label><button type="button">Sign in</button></form>`;

/** Starts the fake; `respond(body)` overrides `fakeReply`. Resolves with `baseUrl`, the `requests` seen and `close`. */
export async function startFakeModelServer({ respond = fakeReply } = {}) {
  const requests = [];
  const open = new Set();
  let counter = 0;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/login")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(SIGN_IN_PAGE);
      return;
    }
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
      if (reply.status) {
        response.writeHead(reply.status, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: reply.error, type: "invalid_request_error" } }));
        return;
      }
      const id = `chatcmpl-fake-${++counter}`;
      const model = typeof body.model === "string" ? body.model : FAKE_MODEL;
      const chunk = (choice, extra = {}) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model, choices: choice ? [{ index: 0, ...choice }] : [], ...extra })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      let closed = false;
      const gone = new Promise((resolve) => response.on("close", () => { closed = true; resolve(); }));
      response.write(chunk({ delta: { role: "assistant", content: "" }, finish_reason: null }));
      for (let spent = 0; reply.thinkMs && spent < reply.thinkMs; spent += 250) {
        if (closed) return;
        response.write(chunk({ delta: { reasoning_content: spent ? " and weighing it" : "Reading the request" }, finish_reason: null }));
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (closed) return;
      const calls = reply.toolCalls ?? (reply.toolCall ? [reply.toolCall] : []);
      if (calls.length > 0) {
        if (reply.text) response.write(chunk({ delta: { content: reply.text }, finish_reason: null }));
        calls.forEach((call, index) => response.write(chunk({ delta: { tool_calls: [{ index, id: `call_${counter}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, finish_reason: null })));
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
