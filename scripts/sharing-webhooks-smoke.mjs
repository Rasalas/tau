// Full host + browser check, confined to loopback and .tau-dev. No real tailnet,
// credentials, model account, service manager or user browser profile is used.
import assert from "node:assert/strict";
import { createHash, createHmac, createPublicKey } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createTlsServer, request as httpsRequest } from "node:https";
import { mkdirSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";
import { startTestHost, stopTestHost, testHostDir } from "./tau-test-host.mjs";
import { findChromium, chromeArgs } from "./tau-mobile-cdp.mjs";
import { stopProcess } from "./tau-cdp.mjs";
import { prepareFakePiAgentDir, startFakeModelServer, FAKE_MODEL, FAKE_PROVIDER } from "./fake-model-server.mjs";
import { prepareServersDir, serversInstanceEnv } from "../kits/servers/fixtures/servers-test-env.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NAME = "sharing-webhooks";
const DIR = testHostDir(NAME);
const DNS = "tau-test-box.tail0000.ts.net";
const SECRET = "isolated-webhook-fixture-key";
const { HostUplink } = await import(pathToFileURL(join(ROOT, "dist-electron/main/host-uplink.js")));
const { createSelfSignedCertificate } = await import(pathToFileURL(join(ROOT, "dist-electron/main/self-signed-certificate.js")));
const steps = [];
const note = (text) => { steps.push(text); console.log(`✓ ${text}`); };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, what, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await read()) return; await delay(100); }
  throw new Error(`Timed out: ${what}`);
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function cdp(url) {
  const ws = new WebSocket(url);
  const waiting = new Map(); let counter = 0;
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw)); const item = waiting.get(frame.id);
    if (item) { waiting.delete(frame.id); clearTimeout(item.timer); if (frame.error) item.reject(new Error(frame.error.message)); else item.resolve(frame.result); }
  });
  ws.on("close", () => { for (const item of waiting.values()) { clearTimeout(item.timer); item.reject(new Error("CDP closed")); } waiting.clear(); });
  return {
    close: () => ws.close(),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++counter;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
      waiting.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
    }),
  };
}
const evaluate = async (page, expression) => {
  const result = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result?.value;
};

let model, owner, browser, browserCdp, tlsServer, host;
const pages = [];
let complete = false;
try {
  model = await startFakeModelServer();
  const fakePort = await freePort();
  const proxyPort = await freePort();
  const servers = join(DIR, "servers");
  const fakeState = join(DIR, "fake-tailscale");
  host = await startTestHost({ name: NAME, kits: true, fresh: true, login: false }, {
    env: {
      ...serversInstanceEnv(servers),
      TAU_TAILSCALE_COMMAND: join(ROOT, "kits/tailscale/fixtures/fake-tailscale.mjs"),
      FAKE_TAILSCALE_STATE: fakeState, FAKE_TAILSCALE_LOW_PORT_BASE: String(fakePort - 443),
      ZDOTDIR: join(DIR, "empty-zdotdir"),
    },
    prepare: (env) => {
      prepareServersDir(servers);
      prepareFakePiAgentDir(env.PI_CODING_AGENT_DIR, model.baseUrl);
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", "init", "-q", "-b", "main"], { cwd: env.TAU_WORKSPACE });
      writeFileSync(join(env.TAU_WORKSPACE, "README.md"), "# Isolated sharing fixture\n");
    },
  });
  owner = new HostUplink({ url: host.url, token: readFileSync(host.tokenFile, "utf8").trim() });
  assert.equal((await owner.hello()).owner, true);
  await owner.request("bootstrap");
  await owner.request("connections-set-network", [{ lan: false, tailscale: false, announce: false, proxyPort }]);
  const invoke = (extension, command, input) => owner.request("host-extension", [extension, command, input]);
  const scheduling = (command, input) => invoke("tau.scheduling", command, input);
  const sharing = (command, input) => invoke("tau.thread-sharing", command, input);
  await invoke("tau.tailscale", "serve-on", { httpsPort: 443, name: DNS });
  note("Real Tau host and its loopback proxy run with an isolated model and fake Tailscale Serve");

  const material = createSelfSignedCertificate({ commonName: DNS, dnsNames: [DNS], ipAddresses: ["127.0.0.1"], days: 1 });
  tlsServer = createTlsServer(material, (request, response) => {
    const forwarded = httpRequest({ hostname: "127.0.0.1", port: fakePort, method: request.method, path: request.url, headers: { ...request.headers, host: DNS } }, (upstream) => { response.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(response); });
    forwarded.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(forwarded);
  });
  await new Promise((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
  const tlsPort = tlsServer.address().port;
  const post = (path, body, headers) => new Promise((resolve, reject) => {
    const request = httpsRequest({ hostname: "127.0.0.1", port: tlsPort, servername: DNS, ca: material.cert, path, method: "POST", headers: { ...headers, Host: DNS, Connection: "close" } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    request.on("error", reject); request.end(body);
  });
  const sign = (id, body, timestamp = Date.now()) => ({ "X-Tau-Delivery": id, "X-Tau-Timestamp": String(timestamp), "X-Tau-Signature": createHmac("sha256", SECRET).update(`${timestamp}\n${id}\n`).update(body).digest("hex") });
  const job = await scheduling("create", { name: "Tailnet smoke", workspace: host.workspace, backend: "pi", prompt: "Webhook fixture accepted", schedule: { kind: "webhook", filters: [{ path: "action", op: "equals", value: "completed" }] }, workspaceStrategy: "current", accessLevel: "read-only", maxDurationMinutes: 1 });
  await scheduling("set-webhook-secret", { id: job.id, value: SECRET });
  await scheduling("enable", { id: job.id });
  await scheduling("set-enabled", { enabled: true });
  let endpoint;
  await until(async () => { endpoint = (await scheduling("manage")).webhookUrl; return endpoint?.startsWith(`https://${DNS}/extensions/`); }, "published webhook endpoint");
  const hookPath = new URL(endpoint).pathname + "/" + job.id;
  const body = '{"action":"completed","fixture":"payload-must-not-enter-prompt"}';
  assert.equal(await post(hookPath, body, { ...sign("one", body), "X-Tau-Signature": "0".repeat(64) }), 401);
  const ignored = '{"action":"ignored"}';
  assert.equal(await post(hookPath, ignored, sign("ignored", ignored)), 204);
  assert.equal(await post(hookPath, body, sign("one", body)), 202);
  assert.equal(await post(hookPath, body, sign("one", body)), 200);
  await until(async () => (await scheduling("manage")).jobs.find((j) => j.id === job.id)?.status === "completed", "webhook runtime completion");
  assert(!JSON.stringify(model.requests).includes("payload-must-not-enter-prompt"));
  note("Signed HTTPS webhook starts a real runtime; invalid signatures, filters and duplicate deliveries work");

  const thread = await owner.request("start-thread", [{ cwd: host.workspace, backend: "pi", title: "Guest smoke", prompt: "Guest fixture message", model: { provider: FAKE_PROVIDER, id: FAKE_MODEL } }]);
  await sharing("enable", { enabled: true });
  const grant = await sharing("create", { threadId: thread.sessionId, hours: 1, mode: "suggest", showToolOutput: false });
  const spki = createHash("sha256").update(createPublicKey(material.cert).export({ type: "spki", format: "der" })).digest("base64");
  const cdpPort = await freePort();
  const profile = join(DIR, "guest-browser");
  mkdirSync(profile, { recursive: true });
  const chromeLog = openSync(join(DIR, "guest-browser.log"), "a");
  browser = spawn(findChromium(), [...chromeArgs({ port: cdpPort, profile, device: "iphone" }).filter((a) => !a.startsWith("--host-resolver-rules=")), `--host-resolver-rules=MAP ${DNS}:443 127.0.0.1:${tlsPort}`, `--ignore-certificate-errors-spki-list=${spki}`, "--no-proxy-server"], { env: { ...process.env, HOME: join(DIR, "home"), TAU_NO_FOCUS: "1" }, stdio: ["ignore", chromeLog, chromeLog] });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok; } catch { return false; } }, "isolated guest browser");
  const version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
  browserCdp = await cdp(version.webSocketDebuggerUrl);
  async function guestPage() {
    const { browserContextId } = await browserCdp.send("Target.createBrowserContext");
    const { targetId } = await browserCdp.send("Target.createTarget", { url: "about:blank", browserContextId });
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    const page = await cdp(targets.find((t) => t.id === targetId).webSocketDebuggerUrl);
    pages.push(page);
    await page.send("Page.enable");
    await page.send("Page.navigate", { url: grant.url });
    return page;
  }
  const guest = await guestPage();
  await until(async () => (await evaluate(guest, 'document.getElementById("messages")?.textContent || ""')).includes("Guest fixture message"), "guest transcript");
  assert.equal(await evaluate(guest, "location.hash"), "");
  const second = await guestPage();
  await until(async () => (await evaluate(second, 'document.getElementById("status")?.textContent || ""')).includes("another browser"), "one-browser claim refusal");
  note("Guest page claims one independent browser and refuses a second browser");

  await evaluate(guest, 'document.getElementById("text").value="Guest suggested fixture";document.getElementById("composer").requestSubmit();true');
  let suggestion;
  await until(async () => { suggestion = (await sharing("state")).links.find((l) => l.id === grant.id)?.suggestions.find((s) => s.state === "pending"); return !!suggestion; }, "moderated suggestion");
  assert(!JSON.stringify(model.requests).includes("Guest suggested fixture"));
  await sharing("send", { id: grant.id, suggestionId: suggestion.id });
  await until(async () => JSON.stringify(model.requests).includes("Guest suggested fixture"), "explicit owner admission");
  await until(async () => (await evaluate(guest, 'document.getElementById("messages")?.textContent || ""')).includes("Guest suggested fixture"), "guest transcript update");
  note("A browser suggestion reaches the runtime only after the owner explicitly sends it");
  await sharing("revoke", { id: grant.id });
  await until(async () => (await evaluate(guest, 'document.getElementById("status")?.textContent || ""')).includes("has ended"), "guest revocation");
  assert.equal(await evaluate(guest, 'document.getElementById("messages").textContent'), "");
  assert.equal(await evaluate(guest, 'document.getElementById("composer").hidden'), true);
  note("Revocation ends browser access and clears its transcript and composer");
  await scheduling("set-enabled", { enabled: false });
  assert.equal(await post(hookPath, body, sign("after-disable", body)), 404);
  await invoke("tau.tailscale", "serve-off");
  complete = true;
} finally {
  for (const page of pages) page.close();
  browserCdp?.close();
  if (browser?.pid) await stopProcess(browser.pid);
  if (owner) {
    await owner.request("host-extension", ["tau.tailscale", "serve-off"]).catch(() => undefined);
    owner.close();
  }
  if (host) await stopTestHost(NAME);
  // A failure during host activation can still leave the fake Serve daemon.
  const stateFile = join(DIR, "fake-tailscale/state.json");
  try { const state = JSON.parse(readFileSync(stateFile, "utf8")); for (const pid of Object.values(state.daemons ?? {})) if (Number.isInteger(pid)) await stopProcess(pid); } catch { /* no fixture daemon */ }
  if (tlsServer) { tlsServer.closeAllConnections(); await new Promise((resolve) => tlsServer.close(resolve)); }
  await model?.close();
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, "result.json"), JSON.stringify({ passed: complete, steps, network: "loopback only; fake Tailscale Serve", tls: "fixture certificate trusted only by the isolated clients", externalPeerVerified: false }, null, 2) + "\n");
}
console.log(`Passed ${steps.length} integration steps; all owned listeners and processes stopped.`);
