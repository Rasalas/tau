// A real Pi tool call on an isolated Tau host, without a display or paid model.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { startTestHost, stopTestHost } from "./tau-test-host.mjs";
import { prepareFakePiAgentDir, startFakeModelServer } from "./fake-model-server.mjs";
import { HostUplink } from "../dist-electron/main/host-uplink.js";

const name = "html-page-preview";
let hits = 0;
const fixture = createServer((_request, response) => { hits++; response.end("must not be reached"); });
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const blockedUrl = `http://127.0.0.1:${fixture.address().port}/blocked`;
const html = `<!doctype html><h1>Preview fixture</h1><script>
  console.error("synthetic page error");
  try { localStorage.setItem("private", "value"); console.error("storage-accessible"); }
  catch { console.error("opaque-storage-blocked"); }
  fetch(${JSON.stringify(blockedUrl)}).catch(() => console.error("connection-blocked"));
</script><img src="${blockedUrl}">`;
let finished;
const checked = new Promise((resolve) => { finished = resolve; });
const model = await startFakeModelServer({ respond(body) {
  if (!body.tools?.some((tool) => ["tool_search", "preview_html_page"].includes(tool.function?.name))) return { text: "ok" };
  const calls = body.messages.filter((message) => message.role === "assistant").flatMap((message) => message.tool_calls ?? []);
  if (calls.some((call) => call.function?.name === "preview_html_page")) { finished(body); return { text: "checked" }; }
  if (calls.some((call) => call.function?.name === "tool_search")) return { toolCall: { name: "preview_html_page", arguments: { title: "Fixture", html, width: 600, height: 400, colorScheme: "dark" } } };
  return { toolCall: { name: "tool_search", arguments: { query: "preview_html_page", limit: 2 } } };
} });
let client;
let owned = false;
let timer;
try {
  const host = await startTestHost({ name, fresh: true, kits: true, login: false }, {
    env: { DISPLAY: "", WAYLAND_DISPLAY: "", WAYLAND_SOCKET: "" },
    prepare: (env) => prepareFakePiAgentDir(env.PI_CODING_AGENT_DIR, model.baseUrl, { images: true }),
  });
  owned = true;
  client = new HostUplink({ url: host.url, token: (await readFile(host.tokenFile, "utf8")).trim() });
  await client.request("bootstrap");
  await client.request("start-thread", [{ cwd: host.workspace, prompt: "Check the HTML preview fixture.", backend: "pi", model: { provider: "tau-fake", id: "fake-1" } }]);
  const body = await Promise.race([checked, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("HTML preview tool timed out.")), 45_000); })]);
  const text = JSON.stringify(body.messages.filter((message) => message.role === "tool"));
  for (const expected of ["Not published", "synthetic page error", "opaque-storage-blocked", "connection-blocked"]) assert(text.includes(expected), `missing diagnostic: ${expected}; tool text: ${text.slice(-1500)}`);
  assert(!text.includes("storage-accessible"));
  assert(!text.includes("[tau-html-page:"));
  const image = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).find((part) => part.type === "image_url");
  assert(image?.image_url.url.startsWith("data:image/png;base64,"), "runtime received no preview PNG");
  const png = Buffer.from(image.image_url.url.split(",")[1], "base64");
  assert.equal(png.readUInt32BE(16), 600);
  assert.equal(png.readUInt32BE(20), 400);
  assert.equal(hits, 0, "sandboxed page reached the loopback server");
  const files = await readdir(host.userData, { recursive: true });
  assert(!files.some((path) => path.includes("html-preview-")), "temporary browser profile survived the tool");
  console.log("HTML preview passed: real Tau/Pi tool, PNG 600×400, console diagnostics, opaque storage, blocked network, no publication, temporary profile removed.");
} finally {
  clearTimeout(timer);
  client?.close();
  if (owned) await stopTestHost(name);
  await model.close();
  await new Promise((resolve) => fixture.close(resolve));
}
