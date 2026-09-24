// Drives a headless Tau host over the socket transport: hello, compression,
// bootstrap, a prompt, a disconnect, and a reconnect that replays the pushes
// missed in between — once in plaintext, once over TLS with a pinned certificate —
// plus heartbeats, the Origin check and the close of a socket that never says hello.
// Each run then pairs devices over the socket, allowed by the owner after comparing
// a code (bound to the pinned certificate over TLS), denies one, holds a Read-only
// device to reads, revokes live connections and rotates the host token (ADR 0023,
// ADR 0024). A last run with kits sends a call into a window and checks that it
// reaches one connection and only its answer counts, and that a Read-only device
// runs only the kit commands that just look.
// Node 22 has WebSocket globally; the TLS run pins with `ws` and the host's
// own pinning code, because a global WebSocket cannot pin a certificate.
import { execFileSync, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
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
function createClient(url, token, fingerprint, origin) {
  const socket = fingerprint || origin
    ? new PinnedWebSocket(url, {
      ...(fingerprint ? { createConnection: pinnedTlsConnect(fingerprint) } : {}),
      ...(origin ? { origin } : {}),
    })
    : new WebSocket(url);
  const pending = new Map();
  const pushes = [];
  const calls = [];
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
    if (frame.type === "client-call") { calls.push(frame.call); return; }
    if (frame.type === "pong") { pending.get(frame.id)?.resolve(frame); pending.delete(frame.id); return; }
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
    calls,
    opened,
    closed,
    extensions: () => socket.extensions,
    hello: (lastSeq, extra = {}) => {
      const id = `h${++counter}`;
      return send({ type: "hello", id, hello: { ...extra, protocol: PROTOCOL, token, ...(lastSeq === undefined ? {} : { lastSeq }) } }, id);
    },
    request: (method, params = []) => {
      const id = `r${++counter}`;
      return send({ type: "request", request: { id, method, params } }, id);
    },
    ping: () => {
      const id = `p${++counter}`;
      return send({ type: "ping", id }, id);
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
// The digits a pinning device computes, from the same module the app uses.
const { pairingCommitment, pairingVerificationCode, randomPairingNonce } = await import(pathToFileURL(join(ROOT, "dist-electron", "shared", "pairing.js")).href);
const { parsePairingPayload } = await import(pathToFileURL(join(ROOT, "dist-electron", "shared", "connections.js")).href);
const PHONE_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1";

/** Starts a headless host; `tls` adds TAU_HOST_TLS=1. Resolves once it prints its socket. */
async function startHost({ workspace, userData, tokenHome, tls, webClient, kits = false }) {
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
      ...(kits ? {} : { TAU_NO_EXTENSIONS: "1" }),
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

/** The protocol run both variants share: token, hello, bootstrap, prompt, replay, resync, liveness, origin. */
async function exercise(url, token, fingerprint, label) {
  // Says nothing; the host must close it on its own while the rest runs.
  const silent = createClient(url, token, fingerprint);
  await silent.opened;

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

  if (!replay.capabilities.includes("heartbeat")) fail("the host did not announce heartbeats");
  const pong = await resumed.ping();
  if (pong.type !== "pong") fail(`a ping was answered with ${JSON.stringify(pong)}`);
  step(`${label}: heartbeat answered`);
  await resumed.close();

  const foreign = createClient(url, token, fingerprint, "https://evil.example");
  await foreign.opened;
  const foreignClose = await foreign.closed;
  if (foreignClose.code !== 4403) fail(`a page from another site was not refused (close ${foreignClose.code})`);
  const own = createClient(url, token, fingerprint, new URL(url.replace(/^ws/u, "http")).origin);
  await own.opened;
  await own.hello();
  await own.close();
  step(`${label}: origin checked`, "another site's page refused with 4403, the host's own accepted");

  const silentClose = await silent.closed;
  if (silentClose.code !== 4408) fail(`a socket without a hello was closed with ${silentClose.code} instead of 4408`);
  step(`${label}: a socket without a hello is closed`, "4408");
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

/** Any request to the page's server; over TLS the host's own certificate is the only CA. */
function httpPost(pageUrl, path, body, ca) {
  const url = new URL(path, pageUrl);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = send(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      ...(ca ? { ca } : {}),
    }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += String(chunk); });
      response.on("end", () => resolve({ status: response.statusCode, text }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

/**
 * A device asking to pair over the socket (ADR 0024). With `fingerprint` it
 * pins the certificate and binds the digits to it, as the app does.
 */
async function askToPair(url, { code, fingerprint, name } = {}) {
  const socket = new PinnedWebSocket(url, {
    headers: { "user-agent": PHONE_AGENT },
    ...(fingerprint ? { createConnection: pinnedTlsConnect(fingerprint) } : {}),
  });
  const replies = [];
  const waiters = [];
  let shown;
  const closed = new Promise((resolve) => socket.on("close", (closeCode, reason) => resolve({ code: closeCode, reason: String(reason) })));
  const nonce = fingerprint ? randomPairingNonce() : undefined;
  socket.on("message", async (data) => {
    const frame = JSON.parse(String(data));
    if (frame.type !== "pair-reply") return;
    const { reply } = frame;
    if (reply.state === "challenge") {
      shown = await pairingVerificationCode({ fingerprint, deviceNonce: nonce, hostNonce: reply.hostNonce });
      socket.send(JSON.stringify({ type: "pair-reveal", id: "pair", nonce }));
      return;
    }
    if (reply.state === "waiting") {
      if (shown && shown !== reply.verification) fail(`the host's digits ${reply.verification} are not the device's ${shown}`);
      shown ??= reply.verification;
    }
    replies.push(reply);
    for (const waiter of waiters.splice(0)) waiter();
  });
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.send(JSON.stringify({ type: "pair", id: "pair", pair: { ...(code ? { code } : {}), ...(name ? { name } : {}), ...(nonce ? { commitment: await pairingCommitment(nonce) } : {}) } }));
  const next = async () => {
    while (replies.length === 0) await new Promise((resolve) => waiters.push(resolve));
    return replies.shift();
  };
  return { next, closed, shown: () => shown, close: () => socket.close() };
}

/** A device asks and the owner allows it after finding the device's digits among the requests. */
async function pairDevice(url, owner, { code, fingerprint, name, access } = {}) {
  const device = await askToPair(url, { code, fingerprint, name });
  const waiting = await device.next();
  if (waiting.state !== "waiting") fail(`the request was not put to the owner: ${JSON.stringify(waiting)}`);
  const { requests } = await owner.request("connections-list");
  const request = requests.find((entry) => entry.verification === device.shown());
  if (!request) fail(`the owner sees no request with the device's digits ${device.shown()}: ${JSON.stringify(requests)}`);
  const { approved } = await owner.request("connections-approve", [request.id, access ? { access } : {}]);
  if (!approved) fail("the owner could not allow a waiting device");
  const answer = await device.next();
  if (answer.state !== "approved" || !/^tauc\.[0-9a-f]{24}\./u.test(answer.token)) fail(`no token after the owner allowed it: ${JSON.stringify(answer)}`);
  device.close();
  return { token: answer.token, access: answer.access, verification: device.shown(), request };
}

/** Methods that change something; a Read-only device is refused each, whatever its input. */
const WRITES = [
  ["prompt", ["Say hello.", undefined, undefined, "smoke-read-only", undefined]],
  ["steer", ["x"]], ["follow-up", ["x"]], ["queue-message", ["s", "x"]], ["new-session", []], ["abort", [undefined]],
  ["rename-thread", ["Renamed by a Read-only device"]], ["set-model", ["p", "m"]], ["set-thinking", ["high"]], ["set-mode", ["plan"]],
  ["run-shell-action", ["echo hi"]], ["update-config", [{}]], ["clear-config", [[]]], ["open-project", ["/"]], ["remove-project", ["/"]],
  ["add-model-provider", [{}]], ["reload-runtime", []], ["compact-context", []], ["answer-extension-ui", ["id", {}]],
  ["host-extension-active", ["tau.terminal", false]], ["extension-grant", ["tau.terminal", true]], ["copy-text", ["x"]],
  ["start-job", ["prompt", ["x"]]],
];

/** A Read-only device reads, is refused every change, and a new preset applies at its next call. */
async function exerciseReadOnly(host, owner, label) {
  const { code } = await owner.request("connections-create-link", [{ label: "Watcher", access: "read-only" }]);
  const watcher = await pairDevice(host.url, owner, { code, fingerprint: host.fingerprint });
  if (watcher.access !== "read-only") fail(`a Read-only link paired ${watcher.access}`);
  const device = createClient(host.url, watcher.token, host.fingerprint);
  await device.opened;
  const hello = await device.hello();
  if (hello.access !== "read-only") fail(`the hello did not say Read only: ${JSON.stringify(hello)}`);
  await device.request("bootstrap");
  await device.request("host-extensions");
  for (const [method, params] of WRITES) {
    const outcome = await device.request(method, params).then(() => "answered", (error) => String(error.message));
    if (!/^forbidden: .*Read only/u.test(outcome)) fail(`a Read-only device was not refused ${method}: ${outcome}`);
  }
  const record = (await owner.request("connections-list")).clients.find((entry) => entry.label === "Watcher");
  if (record?.lastAction) fail(`a refused call counted as a change: ${JSON.stringify(record.lastAction)}`);
  step(`${label}: a Read-only device reads and is refused every change`, `${WRITES.length} methods`);

  await owner.request("connections-update-client", [record.id, { access: "full", label: "Watcher, now Full" }]);
  await device.request("rename-thread", ["Renamed by a device made Full"]).catch((error) => {
    if (String(error.message).startsWith("forbidden")) fail("a new preset did not apply at the next call");
  });
  const after = (await owner.request("connections-list")).clients.find((entry) => entry.id === record.id);
  if (after?.label !== "Watcher, now Full" || after.lastAction?.action !== "rename-thread") fail(`the rename or the last change is missing: ${JSON.stringify(after)}`);
  step(`${label}: renaming and a new preset apply at once; the row shows the last change`, after.lastAction.action);
  await device.close();
  await owner.request("connections-revoke-client", [record.id]);
}

/** Pairing, presets, revocation of a live connection and rotation, as a device meets them. */
async function exerciseAccess(host, tokenPath, userData, label) {
  const ca = host.fingerprint ? readFileSync(join(userData, "tls", "host-cert.pem"), "utf8") : undefined;
  const printed = host.output().match(/web client: (\S+)/u);
  if (!printed) fail(`the host printed no pairing link\n${host.output()}`);
  const link = parsePairingPayload(printed[1]);
  const page = link?.endpoints[0];
  if (!link || !page) fail(`the printed link carries no code: ${printed[1]}`);
  if (host.fingerprint && link.fingerprint !== host.fingerprint) fail(`the link's fingerprint ${link.fingerprint} is not the host's ${host.fingerprint}`);
  if (!host.fingerprint && link.fingerprint) fail("a plaintext host put a fingerprint in its link");
  if (!/^[0-9a-f]{32}$/u.test(link.hostId ?? "")) fail(`the link names no host id: ${printed[1]}`);
  step(`${label}: the printed link carries the code, the host id${host.fingerprint ? " and the fingerprint" : ""}`);
  const legacy = await httpPost(page, "/pair", JSON.stringify({ code: link.code }), ca);
  if (legacy.status !== 410 || legacy.text.includes("tauc.")) fail(`POST /pair still answers: ${legacy.status} ${legacy.text}`);
  step(`${label}: POST /pair hands out nothing`);

  const hostToken = readFileSync(tokenPath, "utf8").trim();
  const owner = createClient(host.url, hostToken, host.fingerprint);
  await owner.opened;
  await owner.hello();

  // Nobody is let in before the owner says so; over TLS the device binds the digits to the pinned certificate.
  const asking = await askToPair(host.url, { code: link.code, fingerprint: host.fingerprint, name: "Smoke phone" });
  const waiting = await asking.next();
  if (waiting.state !== "waiting") fail(`the startup link was not put to the owner: ${JSON.stringify(waiting)}`);
  const pending = (await owner.request("connections-list")).requests;
  if (pending.length !== 1 || pending[0].verification !== asking.shown() || pending[0].name !== "Smoke phone") fail(`the owner does not see the device's digits: ${JSON.stringify(pending)}`);
  if ((await owner.request("connections-list")).clients.length !== 0) fail("a device was let in before the owner allowed it");
  await owner.request("connections-approve", [pending[0].id, {}]);
  const approved = await asking.next();
  if (approved.state !== "approved") fail(`the allowed device got no token: ${JSON.stringify(approved)}`);
  asking.close();
  const paired = { token: approved.token };
  if (paired.token === hostToken) fail("pairing handed out the host token");
  const spent = await askToPair(host.url, { code: link.code, fingerprint: host.fingerprint });
  const refusal = await spent.next();
  if (refusal.state !== "refused" || refusal.reason !== "unknown-code") fail(`a spent link asked again: ${JSON.stringify(refusal)}`);
  step(`${label}: a device asks with the link and gets a token once the owner allows its code`, `code ${asking.shown()}${host.fingerprint ? ", bound to the pinned certificate" : ""}`);

  // Without a link, and denied: the socket closes and nobody is added.
  const stranger = await askToPair(host.url, { fingerprint: host.fingerprint });
  await stranger.next();
  const [unlinked] = (await owner.request("connections-list")).requests;
  if (!unlinked || unlinked.link) fail(`a request without a link is not shown as such: ${JSON.stringify(unlinked)}`);
  await owner.request("connections-deny", [unlinked.id]);
  const denied = await stranger.next();
  if (denied.state !== "denied" || (await stranger.closed).reason !== "denied") fail(`the denied device was not told: ${JSON.stringify(denied)}`);
  if ((await owner.request("connections-list")).clients.length !== 1) fail("a denied device was added");
  step(`${label}: a request without a link reaches the owner, and a denial lets nobody in`);

  const phone = createClient(host.url, paired.token, host.fingerprint);
  await phone.opened;
  await phone.hello();
  const forbidden = await phone.request("connections-list").then(() => "answered", (error) => String(error.message));
  if (!forbidden.startsWith("forbidden")) fail(`a paired client could list connections: ${forbidden}`);
  const listed = await owner.request("connections-list");
  const client = listed.clients.find((entry) => entry.connections === 1);
  if (!client || client.device.os !== "iOS" || client.access !== "full" || client.idleTimeoutDays !== 90 || !client.expiresAt) fail(`the owner does not see the paired client: ${JSON.stringify(listed.clients)}`);
  if (process.platform !== "win32" && (statSync(join(userData, "paired-clients.json")).mode & 0o777) !== 0o600) fail("paired-clients.json is not 0600");
  if (readFileSync(join(userData, "paired-clients.json"), "utf8").includes(paired.token.split(".")[2])) fail("a client secret was written in clear");
  step(`${label}: a paired client connects, may not manage access, is listed with its preset and expiry`, `${client.label}, ${client.lastAddress}`);

  const created = await owner.request("connections-create-link", [{ label: "Smoke", lifetimeMs: 60_000 }]);
  if (!created.urls[0]?.url.includes(`#pair=${created.code}`)) fail(`a created link carries no code: ${JSON.stringify(created.urls)}`);
  await owner.request("connections-revoke-link", [created.link.id]);
  const revokedLink = await askToPair(host.url, { code: created.code, fingerprint: host.fingerprint });
  if ((await revokedLink.next()).reason !== "unknown-code") fail("a revoked link was accepted");
  step(`${label}: a created link can be revoked before use`);

  await exerciseReadOnly(host, owner, label);

  await owner.request("connections-revoke-client", [client.id]);
  const ended = await phone.closed;
  if (ended.code !== 4401 || ended.reason !== "revoked") fail(`revocation did not close the live connection: ${JSON.stringify(ended)}`);
  const again = createClient(host.url, paired.token, host.fingerprint);
  await again.opened;
  if (await again.hello().then(() => "accepted", () => "refused") !== "refused") fail("a revoked token was accepted");
  step(`${label}: revoking closes the live connection and refuses the token`);

  const other = await pairDevice(host.url, owner, { code: (await owner.request("connections-create-link", [{}])).code, fingerprint: host.fingerprint });
  const tablet = createClient(host.url, other.token, host.fingerprint);
  await tablet.opened;
  await tablet.hello();
  const { revoked } = await owner.request("connections-revoke-others");
  if (revoked < 1 || (await tablet.closed).reason !== "revoked") fail(`signing out the others left a device connected: ${revoked}`);
  if ((await owner.request("connections-list")).clients.length !== 0) fail("a device survived signing out the others");
  step(`${label}: signing out every other device closes their connections`, `${revoked} device(s)`);

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

/**
 * A call into a window (ADR 0023): Workspace Kit's folder picker asked for by a
 * window's page reaches that window alone; a paired client that claims the same
 * window neither sees it nor settles it; a client without a window is refused at once.
 */
async function exerciseCalls(host, tokenPath, workspace, elsewhere) {
  const hostToken = readFileSync(tokenPath, "utf8").trim();
  const ownerSocket = createClient(host.url, hostToken);
  await ownerSocket.opened;
  await ownerSocket.hello();
  const paired = await pairDevice(host.url, ownerSocket, { code: (await ownerSocket.request("connections-create-link", [{}])).code });
  const connect = async (token, hello) => {
    const client = createClient(host.url, token);
    await client.opened;
    await client.hello(undefined, hello);
    return client;
  };
  const window = await connect(hostToken, { auxiliary: true, windowId: "smoke-window", windowHalves: ["window"] });
  const page = await connect(hostToken, { windowId: "smoke-window", profile: "desktop" });
  const phone = await connect(paired.token, { auxiliary: true, windowId: "smoke-window", windowHalves: ["window"] });
  await page.request("bootstrap");

  const picked = page.request("host-extension", ["tau.workspace", "pick-folder"]);
  await waitFor(() => window.calls.length === 1, "the folder picker call to reach the window");
  const [call] = window.calls;
  if (call.extensionId !== "window" || call.command !== "pick-directory") fail(`unexpected call: ${JSON.stringify(call)}`);
  if (phone.calls.length > 0 || page.calls.length > 0) fail("a call into the window reached another connection");
  if ([window, page, phone].some((client) => client.pushes.some((push) => push.event.type === "client-call"))) fail("a call into the window travelled as a push");
  step("calls: the folder picker reaches the caller's window alone");

  // The phone learned the id somehow and answers first: it must not count.
  await phone.request("client-call-result", [call.callId, elsewhere]);
  await window.request("client-call-result", [call.callId, workspace]);
  const answer = await picked;
  if (answer?.displayPath !== workspace) fail(`the host took a forged answer: ${JSON.stringify(answer)}`);
  step("calls: a forged answer from a paired client is ignored", answer.displayPath);

  // Its own request goes to its own claimed half, never to the host's window.
  const own = phone.request("host-extension", ["tau.workspace", "pick-folder"]);
  await waitFor(() => phone.calls.length === 1, "the paired client's own call");
  if (window.calls.length !== 1) fail("a paired client's call reached the host's window");
  await phone.request("client-call-result", [phone.calls[0].callId, null]);
  await own;
  const browser = await connect(paired.token, { profile: "web" });
  const refused = await browser.request("host-extension", ["tau.workspace", "pick-folder"]).then(() => "answered", (error) => String(error.message));
  if (!/no window that can answer/u.test(refused)) fail(`a client without a window was not refused: ${refused}`);
  if (window.calls.length !== 1) fail("a browser's folder picker opened on the host's window");
  step("calls: a paired client is asked only for its own calls; one without a window is refused");

  await window.close();
  const started = Date.now();
  const alone = await page.request("host-extension", ["tau.workspace", "pick-folder"]).then(() => "answered", (error) => String(error.message));
  if (!/no window that can answer/u.test(alone) || Date.now() - started > 5_000) fail(`a call without a window did not fail at once: ${alone}`);
  step("calls: without a window the call fails at once", `${Date.now() - started} ms`);

  // Kit commands: a Read-only device runs those registered with access "read", and no other, not even as a job.
  const watcher = await pairDevice(host.url, ownerSocket, { code: (await ownerSocket.request("connections-create-link", [{ access: "read-only" }])).code });
  const viewer = await connect(watcher.token, { profile: "compact" });
  for (const [kit, command, input] of [["tau.terminal", "list"], ["tau.workspace", "changes", {}], ["tau.thread-rail", "state"], ["tau.files", "stat", { path: "README.md" }]]) {
    const outcome = await viewer.request("host-extension", [kit, command, input]).then(() => "answered", (error) => String(error.message));
    if (outcome.startsWith("forbidden")) fail(`a Read-only device was refused ${kit}/${command}: ${outcome}`);
  }
  const refusedWrites = [["tau.terminal", "open", {}], ["tau.terminal", "input", { id: "x", data: "ls\n" }], ["tau.workspace", "commit", {}], ["tau.workspace", "write-file", {}], ["tau.files", "write", {}], ["tau.thread-rail", "archive", {}]];
  for (const [kit, command, input] of refusedWrites) {
    const outcome = await viewer.request("host-extension", [kit, command, input]).then(() => "answered", (error) => String(error.message));
    if (!/^forbidden: .*Read only/u.test(outcome)) fail(`a Read-only device ran ${kit}/${command}: ${outcome}`);
  }
  // The job starts, but the registry refuses the command inside it before it runs.
  const { jobId } = await viewer.request("start-job", ["host-extension", ["tau.workspace", "clone-start", {}]]);
  await waitFor(() => viewer.pushes.some((push) => push.event.type === "job-done" && push.event.jobId === jobId), "the job's end");
  const done = viewer.pushes.find((push) => push.event.type === "job-done" && push.event.jobId === jobId).event;
  if (done.error?.code !== "forbidden") fail(`a Read-only device ran a changing kit command as a job: ${JSON.stringify(done)}`);
  step("calls: a Read-only device runs only the kit commands that just look", `${refusedWrites.length + 1} refused`);
  await Promise.all([page.close(), phone.close(), browser.close(), viewer.close(), ownerSocket.close()]);
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

async function callsScenario() {
  const workspace = await mkdtemp(join(tmpdir(), "tau-remote-smoke-"));
  const userData = mkdtempSync(join(tmpdir(), "tau-remote-userdata-"));
  const tokenHome = mkdtempSync(join(tmpdir(), "tau-remote-home-"));
  const webClient = mkdtempSync(join(tmpdir(), "tau-remote-web-"));
  writeFileSync(join(webClient, "index.html"), "<!doctype html><title>Tau</title>");
  execFileSync("git", ["init", "-b", "main", workspace], { stdio: "ignore" });
  let host;
  try {
    host = await startHost({ workspace, userData, tokenHome, tls: false, webClient, kits: true });
    step("calls: host started with kits", host.url);
    await exerciseCalls(host, join(tokenHome, ".tau", "host-token"), realpathSync(workspace), realpathSync(tokenHome));
  } finally {
    await host?.stop();
    const removal = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };
    await rm(workspace, removal);
    await rm(userData, removal);
    await rm(tokenHome, removal);
    await rm(webClient, removal);
  }
}

await scenario({ tls: false });
await scenario({ tls: true });
await callsScenario();
console.log(`\nremote host smoke passed: ${steps.length} steps`);
