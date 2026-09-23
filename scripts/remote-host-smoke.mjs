// Drives a headless Tau host over the socket transport: hello, compression,
// bootstrap, a prompt, a disconnect, and a reconnect that replays the pushes
// missed in between — once in plaintext, once over TLS with a pinned certificate.
// Each run then pairs a client through a link, revokes it while it is connected
// and rotates the host token (ADR 0023).
// Node 22 has WebSocket globally; the TLS run pins with `ws` and the host's
// own pinning code, because a global WebSocket cannot pin a certificate.
import { execFileSync, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket as PinnedWebSocket } from "ws";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOST_ENTRY = join(ROOT, "dist-electron", "main", "headless.js");
const PROTOCOL = 1;
const steps = [];

// Nothing here should take minutes; a hang is a failure, not a wait.
const guard = setTimeout(() => {
  console.error("✗ the smoke ran into its 120s guard");
  process.exit(1);
}, 120_000);
guard.unref();

function step(name, detail = "") {
  steps.push(name);
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/**
 * A minimal protocol client: one socket, hello, requests by id, pushes by seq.
 * With a fingerprint it speaks TLS and accepts only that certificate.
 */
function createClient(url, token, fingerprint) {
  const socket = fingerprint
    ? new PinnedWebSocket(url, { createConnection: pinnedTlsConnect(fingerprint) })
    : new WebSocket(url);
  const pending = new Map();
  const pushes = [];
  let counter = 0;
  const closed = new Promise((resolve) => socket.addEventListener("close", (event) => resolve({ code: event.code, reason: String(event.reason) })));
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", (event) => reject(event.error ?? new Error(`cannot connect to ${url}`)));
  });
  socket.addEventListener("close", () => {
    // A refused hello is answered by a close, so nothing may stay pending.
    for (const waiter of pending.values()) waiter.reject(new Error("the host closed the connection"));
    pending.clear();
  });
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data);
    if (frame.type === "push") { pushes.push(frame.push); return; }
    const id = frame.type === "response" ? frame.response.id : frame.id;
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    if (frame.type === "hello-reply") waiter.resolve(frame.reply);
    else if (frame.response.error) waiter.reject(new Error(`${frame.response.error.code}: ${frame.response.error.message}`));
    else waiter.resolve(frame.response.result);
  });
  const send = (frame, id) => new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify(frame));
  });
  return {
    pushes,
    opened,
    closed,
    extensions: () => socket.extensions,
    hello: (lastSeq) => {
      const id = `h${++counter}`;
      return send({ type: "hello", id, hello: { protocol: PROTOCOL, token, ...(lastSeq === undefined ? {} : { lastSeq }) } }, id);
    },
    request: (method, params = []) => {
      const id = `r${++counter}`;
      return send({ type: "request", request: { id, method, params } }, id);
    },
    close: () => new Promise((resolve) => {
      socket.addEventListener("close", () => resolve());
      socket.close();
    }),
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(50);
  }
  fail(`timed out waiting for ${message}`);
}

if (!existsSync(HOST_ENTRY)) {
  console.log("Building the host entry (tsc -p tsconfig.electron.json)…");
  execFileSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.electron.json"], { cwd: ROOT, stdio: "inherit" });
}
// The pinning a window uses, not a copy of it.
const { pinnedTlsConnect, HostCertificateRefusedError } = await import(pathToFileURL(join(ROOT, "dist-electron", "main", "host-tls-trust.js")).href);

/** Starts a headless host; `tls` adds TAU_HOST_TLS=1. Resolves once it prints its socket. */
async function startHost({ workspace, userData, tokenHome, tls, webClient }) {
  const host = spawn(process.execPath, [HOST_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: tokenHome,
      // os.homedir() reads USERPROFILE on Windows; without it the token lands in the real home.
      USERPROFILE: tokenHome,
      TAU_WORKSPACE: workspace,
      TAU_USER_DATA: userData,
      TAU_HOST_LISTEN: "127.0.0.1:0",
      TAU_NO_EXTENSIONS: "1",
      TAU_WEB_CLIENT: webClient,
      ...(tls ? { TAU_HOST_TLS: "1" } : {}),
      // HOME is a fresh temp dir already, so ~/.pi/agent/sessions never touches
      // the real store, but the override is pinned explicitly anyway: it is
      // the same contract dev-instance.mjs relies on, and it keeps this smoke
      // isolated even if HOME later grows a symlink back to real credentials.
      PI_CODING_AGENT_SESSION_DIR: join(tokenHome, "pi-sessions"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  host.stdout.on("data", (chunk) => { output += String(chunk); });
  host.stderr.on("data", (chunk) => { output += String(chunk); });
  host.on("exit", (code) => { if (code !== 0 && code !== null && !host.stopping) fail(`the host exited with ${code}\n${output}`); });
  const ready = tls
    ? () => /listening on wss:\/\/\S+/u.test(output) && /tls fingerprint: SHA256 (\S+)/u.test(output)
    : () => /listening on ws:\/\/\S+/u.test(output);
  await waitFor(ready, "the host to listen");
  return {
    url: output.match(/listening on (wss?:\/\/\S+)/u)[1],
    fingerprint: output.match(/tls fingerprint: SHA256 (\S+)/u)?.[1],
    output: () => output,
    stop: async () => {
      host.stopping = true;
      host.kill("SIGTERM");
      await wait(200);
      host.kill("SIGKILL");
    },
  };
}

/** The protocol run both variants share: token, hello, bootstrap, prompt, replay, resync. */
async function exercise(url, token, fingerprint, label) {
  const rejected = createClient(url, "wrong-token", fingerprint);
  await rejected.opened;
  const refusal = await rejected.hello().then(() => "accepted", () => "closed");
  if (refusal !== "closed") fail("a wrong token was accepted");
  step(`${label}: a wrong token is refused`);

  const client = createClient(url, token, fingerprint);
  await client.opened;
  const hello = await client.hello();
  if (hello.protocol !== PROTOCOL) fail(`unexpected protocol ${hello.protocol}`);
  step(`${label}: hello`, `protocol ${hello.protocol}, capabilities ${hello.capabilities.join(", ")}`);
  if (!client.extensions().includes("permessage-deflate")) fail(`the host did not negotiate compression (extensions: "${client.extensions()}")`);
  step(`${label}: frames are compressed`, client.extensions());

  const bootstrap = await client.request("bootstrap");
  if (!bootstrap?.project?.cwd) fail("bootstrap carried no project");
  // A remote client addresses the workspace by identity and shows displayPath.
  const { workspaceId, displayPath } = bootstrap.project;
  if (typeof workspaceId !== "string" || !workspaceId.startsWith("ws1_")) fail("bootstrap carried no workspace id");
  // displayPath is the canonical path, so it may differ from cwd by a symlink.
  if (typeof displayPath !== "string" || !isAbsolute(displayPath)) fail("bootstrap carried no display path");
  step(`${label}: bootstrap`, `workspace ${workspaceId} at ${displayPath}`);

  // The same id names the project everywhere the host publishes it.
  const indexed = bootstrap.threadIndex?.projects?.[0];
  if (indexed && indexed.workspaceId !== workspaceId) fail("the thread index names the workspace differently");

  // Local files are off for a socket client unless the operator opted in.
  if (hello.capabilities.includes("local-files")) fail("a socket client was told the host's files are local");
  step(`${label}: no local-files capability over the socket`);

  const extensions = await client.request("host-extensions");
  step(`${label}: host-extensions`, `${extensions.length} listed`);

  // Whether a model answers depends on credentials; the plumbing does not.
  await client.request("prompt", ["Say hello.", undefined, undefined, `smoke-${label}`, undefined]).catch(() => undefined);
  await waitFor(() => client.pushes.length > 0, "a push after the prompt");
  step(`${label}: send-prompt`, `${client.pushes.length} push(es), last seq ${client.pushes.at(-1).seq}`);
  await client.request("abort", [undefined]).catch(() => undefined);

  const lastSeq = client.pushes.at(-1).seq;
  await client.close();
  step(`${label}: disconnected`, `at seq ${lastSeq}`);

  // Something happens while nobody is listening; the host keeps it for replay.
  const detached = createClient(url, token, fingerprint);
  await detached.opened;
  await detached.hello();
  await detached.request("rename-thread", [`Replayed while away (${label})`]).catch(() => undefined);
  await waitFor(() => detached.pushes.some((push) => push.seq > lastSeq), "a push while the first client is away");
  await detached.close();

  const resumed = createClient(url, token, fingerprint);
  await resumed.opened;
  const replay = await resumed.hello(lastSeq);
  if (replay.resync) fail("the host asked for a resync although the buffer still reached back");
  if (replay.missed.length === 0) fail("no missed pushes were replayed");
  const sequences = replay.missed.map((push) => push.seq);
  if (sequences[0] !== lastSeq + 1) fail(`replay started at ${sequences[0]} instead of ${lastSeq + 1}`);
  step(`${label}: reconnected with lastSeq`, `replayed ${sequences.length} push(es): ${sequences.join(", ")}`);

  // A client the buffer cannot repair (here: one past the host's sequence)
  // is told to refetch instead of being handed a hole.
  const stale = await resumed.hello(10_000);
  if (!stale.resync) fail("a client outside the replay window should be told to resync");
  step(`${label}: resync path`, `resync: true, nextSeq ${stale.nextSeq}`);
  await resumed.close();
}

/** What only the TLS host must do: prove its certificate, refuse the wrong pin, keep its key private. */
async function exerciseTls(host, userData, token) {
  const certPath = join(userData, "tls", "host-cert.pem");
  const keyPath = join(userData, "tls", "host-key.pem");
  const onDisk = new X509Certificate(readFileSync(certPath, "utf8")).fingerprint256;
  if (onDisk !== host.fingerprint) fail(`the printed fingerprint ${host.fingerprint} is not the certificate's ${onDisk}`);
  // Windows has no POSIX modes; the key is private through the user profile's ACL there.
  if (process.platform !== "win32") {
    if ((statSync(keyPath).mode & 0o777) !== 0o600) fail("the TLS key is not 0600");
    if ((statSync(join(userData, "tls")).mode & 0o777) !== 0o700) fail("the TLS directory is not 0700");
  }
  step(process.platform === "win32" ? "tls: certificate kept under userData (modes not checked on Windows)" : "tls: certificate kept 0600 under userData", host.fingerprint);

  const impostor = `${host.fingerprint.slice(0, -2)}${host.fingerprint.endsWith("00") ? "01" : "00"}`;
  const wrongPin = createClient(host.url, token, impostor);
  const refused = await wrongPin.opened.then(() => undefined, (error) => error);
  if (!(refused instanceof HostCertificateRefusedError)) fail(`a wrong fingerprint was not refused: ${refused}`);
  step("tls: a wrong fingerprint is refused before the socket opens");

  const plaintext = createClient(host.url.replace(/^wss:/u, "ws:"), token);
  const plain = await plaintext.opened.then(() => "open", () => "refused");
  if (plain !== "refused") fail("the TLS port answered a plaintext WebSocket");
  step("tls: no plaintext on the TLS port");
}

/** `POST /pair` as a browser sends it; over TLS the host's own certificate is the only CA. */
function redeem(pageUrl, code, ca) {
  const url = new URL("/pair", pageUrl);
  const body = JSON.stringify({ code });
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = send(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1" },
      ...(ca ? { ca } : {}),
    }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += String(chunk); });
      response.on("end", () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : undefined }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

/** Pairing, revocation of a live connection and rotation, as a client meets them. */
async function exerciseAccess(host, tokenPath, userData, label) {
  const ca = host.fingerprint ? readFileSync(join(userData, "tls", "host-cert.pem"), "utf8") : undefined;
  const printed = host.output().match(/web client: (\S+)#pair=(\S+)/u);
  if (!printed) fail(`the host printed no pairing link\n${host.output()}`);
  const [, page, code] = printed;
  const paired = await redeem(page, code, ca);
  if (paired.status !== 200 || !/^tauc\.[0-9a-f]{24}\./u.test(paired.body?.token ?? "")) fail(`the startup link did not pair: ${paired.status} ${JSON.stringify(paired.body)}`);
  const hostToken = readFileSync(tokenPath, "utf8").trim();
  if (paired.body.token === hostToken) fail("pairing handed out the host token");
  if ((await redeem(page, code, ca)).status !== 403) fail("a spent pairing code was redeemed twice");
  step(`${label}: a pairing link gives a token of the client's own, once`);

  const owner = createClient(host.url, hostToken, host.fingerprint);
  await owner.opened;
  await owner.hello();
  const phone = createClient(host.url, paired.body.token, host.fingerprint);
  await phone.opened;
  await phone.hello();
  const forbidden = await phone.request("connections-list").then(() => "answered", (error) => String(error.message));
  if (!forbidden.startsWith("forbidden")) fail(`a paired client could list connections: ${forbidden}`);
  const listed = await owner.request("connections-list");
  const client = listed.clients.find((entry) => entry.connections === 1);
  if (!client || client.device.os !== "iOS") fail(`the owner does not see the paired client: ${JSON.stringify(listed.clients)}`);
  if (process.platform !== "win32" && (statSync(join(userData, "paired-clients.json")).mode & 0o777) !== 0o600) fail("paired-clients.json is not 0600");
  if (readFileSync(join(userData, "paired-clients.json"), "utf8").includes(paired.body.token.split(".")[2])) fail("a client secret was written in clear");
  step(`${label}: a paired client connects, may not manage access, is listed`, `${client.label}, ${client.lastAddress}`);

  const created = await owner.request("connections-create-link", [{ label: "Smoke", lifetimeMs: 60_000 }]);
  if (!created.urls[0]?.url.includes(`#pair=${created.code}`)) fail(`a created link carries no code: ${JSON.stringify(created.urls)}`);
  await owner.request("connections-revoke-link", [created.link.id]);
  if ((await redeem(page, created.code, ca)).status !== 403) fail("a revoked link was redeemed");
  step(`${label}: a created link can be revoked before use`);

  await owner.request("connections-revoke-client", [client.id]);
  const ended = await phone.closed;
  if (ended.code !== 4401 || ended.reason !== "revoked") fail(`revocation did not close the live connection: ${JSON.stringify(ended)}`);
  const again = createClient(host.url, paired.body.token, host.fingerprint);
  await again.opened;
  if (await again.hello().then(() => "accepted", () => "refused") !== "refused") fail("a revoked token was accepted");
  step(`${label}: revoking closes the live connection and refuses the token`);

  const bystander = createClient(host.url, hostToken, host.fingerprint);
  await bystander.opened;
  await bystander.hello();
  const { token: rotated } = await owner.request("connections-rotate-host-token");
  const cut = await bystander.closed;
  if (cut.code !== 4401 || cut.reason !== "token-rotated") fail(`rotation did not close the other host-token connection: ${JSON.stringify(cut)}`);
  if (readFileSync(tokenPath, "utf8").trim() !== rotated) fail("the rotated token was not written to the token file");
  if (process.platform !== "win32" && (statSync(tokenPath).mode & 0o777) !== 0o600) fail("the rotated token file is not 0600");
  await owner.request("host-extensions");
  const stale = createClient(host.url, hostToken, host.fingerprint);
  await stale.opened;
  if (await stale.hello().then(() => "accepted", () => "refused") !== "refused") fail("the old host token was accepted after rotation");
  const fresh = createClient(host.url, rotated, host.fingerprint);
  await fresh.opened;
  await fresh.hello();
  await fresh.close();
  await owner.close();
  step(`${label}: rotation closes the other host-token connections and keeps the caller`);
}

async function scenario({ tls }) {
  const label = tls ? "tls" : "plain";
  const workspace = await mkdtemp(join(tmpdir(), "tau-remote-smoke-"));
  const userData = mkdtempSync(join(tmpdir(), "tau-remote-userdata-"));
  const tokenHome = mkdtempSync(join(tmpdir(), "tau-remote-home-"));
  // A page is all the host needs to serve `/pair`; the built client is not.
  const webClient = mkdtempSync(join(tmpdir(), "tau-remote-web-"));
  writeFileSync(join(webClient, "index.html"), "<!doctype html><title>Tau</title>");
  execFileSync("git", ["init", "-b", "main", workspace], { stdio: "ignore" });
  writeFileSync(join(workspace, "README.md"), "# remote host smoke\n");
  let host;
  try {
    host = await startHost({ workspace, userData, tokenHome, tls, webClient });
    const token = readFileSync(join(tokenHome, ".tau", "host-token"), "utf8").trim();
    step(`${label}: host started headless`, host.url);
    if (tls) await exerciseTls(host, userData, token);
    await exercise(host.url, token, host.fingerprint, label);
    if (tls) {
      // A pinned client survives a host restart: the certificate is kept, not remade.
      const first = host.fingerprint;
      await host.stop();
      host = await startHost({ workspace, userData, tokenHome, tls, webClient });
      if (host.fingerprint !== first) fail(`the fingerprint changed across a restart: ${first} -> ${host.fingerprint}`);
      const again = createClient(host.url, token, first);
      await again.opened;
      await again.hello();
      await again.close();
      step("tls: a restarted host keeps its fingerprint");
    }
    // Last: rotation replaces the token the steps above used.
    await exerciseAccess(host, join(tokenHome, ".tau", "host-token"), userData, label);
  } finally {
    await host?.stop();
    // Windows keeps a file busy for a moment after the process that held it ends.
    const removal = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };
    await rm(workspace, removal);
    await rm(userData, removal);
    await rm(tokenHome, removal);
    await rm(webClient, removal);
  }
}

await scenario({ tls: false });
await scenario({ tls: true });
console.log(`\nremote host smoke passed: ${steps.length} steps`);
