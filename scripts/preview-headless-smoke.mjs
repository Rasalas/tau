// Real Preview on an isolated Tau host, without Electron, a display or accounts.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startTestHost, stopTestHost } from "./tau-test-host.mjs";
import { prepareFakePiAgentDir, startFakeModelServer } from "./fake-model-server.mjs";
import { HostUplink } from "../dist-electron/main/host-uplink.js";

const name = "preview-headless";
const model = await startFakeModelServer();
let typed = "";
const fixture = createServer((request, response) => {
  const url = new URL(request.url, "http://fixture");
  if (url.pathname === "/typed") { typed = url.searchParams.get("value"); response.end("ok"); return; }
  if (url.pathname === "/download") { response.end(request.headers.cookie?.includes("probe=retained") ? "authenticated" : "anonymous"); return; }
  if (url.pathname === "/login") response.setHeader("set-cookie", "probe=retained; HttpOnly; Max-Age=3600; SameSite=Lax");
  response.setHeader("content-type", "text/html");
  response.end(`<!doctype html><title>Headless Preview fixture</title>
    <input aria-label="Account" oninput="fetch('/typed?value='+encodeURIComponent(this.value))">
    <script>console.error("synthetic console error")</script>`);
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${fixture.address().port}`;
let client;
let owned = false;
const guard = setTimeout(() => { console.error("Headless Preview smoke timed out."); process.exitCode = 1; void cleanup(); }, 90_000);
const options = {
  env: { DISPLAY: "", WAYLAND_DISPLAY: "", WAYLAND_SOCKET: "" },
  prepare: (env) => prepareFakePiAgentDir(env.PI_CODING_AGENT_DIR, model.baseUrl),
};
const preview = (command, input) => client.request("host-extension", ["tau.preview", command, input]);
async function start(fresh) {
  const host = await startTestHost({ name, fresh, kits: true, login: false }, options);
  owned = true;
  client = new HostUplink({ url: host.url, token: (await readFile(host.tokenFile, "utf8")).trim() });
  await client.request("bootstrap");
  // Open a real thread so Preview uses that thread's isolated workspace.
  await client.request("start-thread", [{ cwd: host.workspace, prompt: "say one word", backend: "pi", model: { provider: "tau-fake", id: "fake-1" } }]);
  return host;
}
async function stop(closePreview = true) {
  if (!owned) return;
  if (closePreview) await preview("close").catch(() => undefined);
  client.close();
  client = undefined;
  await stopTestHost(name);
  owned = false;
}
async function cleanup() {
  await stop(false);
  await new Promise((resolve) => fixture.close(resolve));
  await model.close();
}
try {
  let host = await start(true);
  await preview("use-profile", { name: "smoke" });
  await preview("open", { url: `${url}/login` });
  const state = await preview("state");
  assert.equal(state.surface, "headless");
  assert.equal(state.title, "Headless Preview fixture");
  assert.equal(state.noWindow, undefined);
  assert(state.consoleErrors.some((error) => error.includes("synthetic console error")));
  await preview("open", { url: `${url}/login#section` });
  assert.equal((await preview("state")).url, `${url}/login#section`);
  await preview("input", { kind: "click", x: 0.04, y: 0.02 });
  assert.deepEqual(await preview("input", { kind: "text", text: "Ada" }), { focus: "field" });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (typed === "Ada") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(typed, "Ada");
  const frame = await preview("live-frame", { maxWidth: 640, viewer: { id: "smoke", width: 390, height: 844, dpr: 1, touch: true } });
  assert(frame?.data && frame.width > 0 && frame.height > 0);
  assert.equal(Buffer.from(frame.data, "base64").readUInt16BE(0), 0xffd8);
  await preview("download", { url: `${url}/download`, destination: "report.txt" });
  assert.equal(await readFile(join(host.workspace, "report.txt"), "utf8"), "authenticated");
  await assert.rejects(preview("download", { url: `${url}/download`, destination: "report.txt" }));
  await assert.rejects(preview("download", { url: `${url}/download`, destination: "../escape.txt" }), /outside the workspace/u);
  await stop(false);
  host = await start(false);
  await preview("open", { url: `${url}/check` });
  await preview("download", { url: `${url}/download`, destination: "after-restart.txt" });
  assert.equal(await readFile(join(host.workspace, "after-restart.txt"), "utf8"), "authenticated");
  await preview("delete-profile", { id: "smoke" });
  await preview("use-profile", { name: "smoke" });
  await preview("download", { url: `${url}/download`, destination: "after-delete.txt" });
  assert.equal(await readFile(join(host.workspace, "after-delete.txt"), "utf8"), "anonymous");
  const offline = join(host.workspace, "offline.html");
  await writeFile(offline, "<title>Offline Preview fixture</title><p>local content</p>");
  await preview("open", { url: pathToFileURL(offline).href });
  assert.equal((await preview("state")).title, "Offline Preview fixture");
  const outside = join(host.workspace, "..", "outside.html");
  await writeFile(outside, "<title>Private content</title>");
  await assert.rejects(preview("open", { url: pathToFileURL(outside).href }), /workspace/u);
  console.log("Headless Preview passed: real Tau host, no display, trusted input, live JPEG, console errors, authenticated downloads, no overwrite, retained and deleted profiles, restart, offline files and workspace confinement.");
} finally { clearTimeout(guard); await cleanup(); }
