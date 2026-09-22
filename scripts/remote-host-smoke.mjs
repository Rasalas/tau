// Drives a headless Tau host over the socket transport: hello, bootstrap, a
// prompt, a disconnect, and a reconnect that replays the pushes missed in
// between — once in plaintext, once over TLS with a pinned certificate.
// Node 22 has WebSocket globally; the TLS run pins with `ws` and the host's
// own pinning code, because a global WebSocket cannot pin a certificate.
import { execFileSync, spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
async function startHost({ workspace, userData, tokenHome, tls }) {
  const host = spawn(process.execPath, [HOST_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: tokenHome,
      TAU_WORKSPACE: workspace,
      TAU_USER_DATA: userData,
      TAU_HOST_LISTEN: "127.0.0.1:0",
      TAU_NO_EXTENSIONS: "1",
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

  const bootstrap = await client.request("bootstrap");
  if (!bootstrap?.project?.cwd) fail("bootstrap carried no project");
  // A remote client addresses the workspace by identity and shows displayPath.
  const { workspaceId, displayPath } = bootstrap.project;
  if (typeof workspaceId !== "string" || !workspaceId.startsWith("ws1_")) fail("bootstrap carried no workspace id");
  // displayPath is the canonical path, so it may differ from cwd by a symlink.
  if (typeof displayPath !== "string" || !displayPath.startsWith("/")) fail("bootstrap carried no display path");
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
  if ((statSync(keyPath).mode & 0o777) !== 0o600) fail("the TLS key is not 0600");
  if ((statSync(join(userData, "tls")).mode & 0o777) !== 0o700) fail("the TLS directory is not 0700");
  step("tls: certificate kept 0600 under userData", host.fingerprint);

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

async function scenario({ tls }) {
  const label = tls ? "tls" : "plain";
  const workspace = await mkdtemp(join(tmpdir(), "tau-remote-smoke-"));
  const userData = mkdtempSync(join(tmpdir(), "tau-remote-userdata-"));
  const tokenHome = mkdtempSync(join(tmpdir(), "tau-remote-home-"));
  execFileSync("git", ["init", "-b", "main", workspace], { stdio: "ignore" });
  writeFileSync(join(workspace, "README.md"), "# remote host smoke\n");
  let host;
  try {
    host = await startHost({ workspace, userData, tokenHome, tls });
    const token = readFileSync(join(tokenHome, ".tau", "host-token"), "utf8").trim();
    step(`${label}: host started headless`, host.url);
    if (tls) await exerciseTls(host, userData, token);
    await exercise(host.url, token, host.fingerprint, label);
    if (tls) {
      // A pinned client survives a host restart: the certificate is kept, not remade.
      const first = host.fingerprint;
      await host.stop();
      host = await startHost({ workspace, userData, tokenHome, tls });
      if (host.fingerprint !== first) fail(`the fingerprint changed across a restart: ${first} -> ${host.fingerprint}`);
      const again = createClient(host.url, token, first);
      await again.opened;
      await again.hello();
      await again.close();
      step("tls: a restarted host keeps its fingerprint");
    }
  } finally {
    await host?.stop();
    await rm(workspace, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
    await rm(tokenHome, { recursive: true, force: true });
  }
}

await scenario({ tls: false });
await scenario({ tls: true });
console.log(`\nremote host smoke passed: ${steps.length} steps`);
