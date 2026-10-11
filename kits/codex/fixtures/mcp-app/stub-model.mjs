// Real-app check of MCP Apps with a Codex thread, no login:
//   CODEX_HOME=<shadow dir> with config.toml: model = "stub-model" (any model the picker offers works),
//   openai_base_url = "http://127.0.0.1:47831/v1", [mcp_servers.fixture] command = "node", args = [".../server.mjs"],
//   and an auth.json holding a placeholder API key; then `STUB_PORT=47831 node stub-model.mjs`.
//   Never point CODEX_HOME at a real home.
// A stand-in Responses API: first turn calls the fixture's show_counter tool, then says "Done".
import { createServer } from "node:http";

const port = Number(process.env.STUB_PORT ?? 0);
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
let n = 0;

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = req.url ?? "";
    if (req.method === "GET" && url.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    if (req.method !== "POST" || !url.includes("/responses")) { res.writeHead(404); res.end(); return; }
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* ignore */ }
    const flat = [];
    for (const t of body.tools ?? []) { if (t.name) flat.push({ name: t.name, ns: undefined }); for (const x of t.tools ?? []) flat.push({ name: x.name, ns: t.name }); }
    const tools = flat.map((t) => `${t.ns ?? ""}|${t.name}`);
    const found = flat.find((t) => /show_counter/.test(t.name));
    const target = found?.name;
    const namespace = found?.ns;
    const id = `resp_${++n}`;
    const answered = (body.input ?? []).some((item) => item.type === "function_call_output" || item.type === "custom_tool_call_output");
    const codeMode = (body.input ?? []).some((item) => item.type === "additional_tools");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const events = [{ type: "response.created", response: { id } }];
    if (!answered && codeMode) {
      events.push({ type: "response.output_item.done", item: { type: "custom_tool_call", call_id: `call_${n}`, name: "exec", input: "text(JSON.stringify(await tools.mcp__fixture__show_counter({ start: 3 })))" } });
    } else if (!answered && target) {
      events.push({ type: "response.output_item.done", item: { type: "function_call", call_id: `call_${n}`, name: target, ...(namespace ? { namespace } : {}), arguments: JSON.stringify({ start: 3 }) } });
    } else {
      events.push({ type: "response.output_item.done", item: { type: "message", role: "assistant", id: `msg_${n}`, content: [{ type: "output_text", text: answered ? "Done" : `No tool (${tools.join(",")})` }] } });
    }
    events.push({ type: "response.completed", response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } });
    res.end(sse(events));
    if (process.env.STUB_LOG) console.error(`[stub] ${id} model=${body.model} [${tools.join(",")}] tools=${tools.length} answered=${answered} -> ${events[1].item.type}`);
  });
});
server.listen(port, "127.0.0.1", () => console.log(`stub listening ${server.address().port}`));
