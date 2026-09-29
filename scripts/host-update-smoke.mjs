// Drives a headless host's own updater (K103) against a release feed on
// loopback: `update-status`, `update-check` with its push, `update-install`
// through the fake installer (`TAU_UPDATE_FAKE_INSTALL`), a second host whose
// download does not match the feed's checksum, and a third whose feed carries
// no signature; neither installs anything. The feed is signed with a throwaway
// key the hosts trust through `TAU_UPDATE_FEED_KEY`, as the release is with its own.
// Needs `npm run build`. Nothing leaves 127.0.0.1 and nothing is installed.
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rawPublicKey, signFeed } from "./packaging/release-signing.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOST_ENTRY = join(ROOT, "dist-electron", "main", "headless.js");
const VERSION = "99.0.0";
const FEED_KEY = generateKeyPairSync("ed25519");

const guard = setTimeout(() => { console.error("✗ the smoke ran into its 90s guard"); process.exit(1); }, 90_000);
guard.unref();
const step = (name) => console.log(`✓ ${name}`);
const fail = (message) => { console.error(`✗ ${message}`); process.exitCode = 1; throw new Error(message); };

function feedName() {
  if (process.platform === "darwin") return "latest-mac.yml";
  if (process.platform === "win32") return "latest.yml";
  return process.arch === "x64" ? "latest-linux.yml" : `latest-linux-${process.arch}.yml`;
}

/** The fake installer takes the .deb of this architecture, whatever the platform. */
async function startFeed({ corrupt, unsigned }) {
  const debArch = process.arch === "x64" ? "amd64" : process.arch;
  const name = `Tau_${VERSION}_${debArch}.deb`;
  const body = Buffer.from(`fake tau ${VERSION}`);
  const sha512 = createHash("sha512").update(body).digest("base64");
  const yml = `version: ${VERSION}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${body.length}\npath: ${name}\n`;
  const signature = signFeed(Buffer.from(yml), [FEED_KEY.privateKey]);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === `/${feedName()}`) return response.end(yml);
    if (request.url === `/${feedName()}.sig` && !unsigned) return response.end(signature);
    if (request.url === `/${name}`) return response.end(corrupt ? Buffer.from("not the release") : body);
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, sha512, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function startHost({ feed, dir }) {
  const marker = join(dir, "installed.json");
  const host = spawn(process.execPath, [HOST_ENTRY], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      TAU_WORKSPACE: dir,
      TAU_USER_DATA: join(dir, "userdata"),
      TAU_HOST_LISTEN: "127.0.0.1:0",
      TAU_NO_EXTENSIONS: "1",
      TAU_NO_RUNTIME_UPDATES: "1",
      TAU_CONFIG_FILE: join(dir, "config.json"),
      PI_CODING_AGENT_DIR: join(dir, "pi-agent"),
      PI_CODING_AGENT_SESSION_DIR: join(dir, "pi-sessions"),
      TAU_UPDATE_FEED_URL: feed.url,
      TAU_UPDATE_FEED_KEY: rawPublicKey(FEED_KEY.publicKey),
      TAU_UPDATE_FAKE_INSTALL: marker,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  host.stdout.on("data", (chunk) => { output += chunk; });
  host.stderr.on("data", (chunk) => { output += chunk; });
  const deadline = Date.now() + 30_000;
  while (!/listening on ws:\/\/\S+/u.test(output) || !/token: (\S+)/u.test(output)) {
    if (Date.now() > deadline || host.exitCode !== null) fail(`the host did not start:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const url = output.match(/listening on (ws:\/\/\S+)/u)[1];
  const token = readFileSync(output.match(/token: (\S+)/u)[1], "utf8").trim();
  return { host, url, token, marker, stop: () => new Promise((resolve) => { host.once("exit", resolve); host.kill("SIGTERM"); }) };
}

function connect(url, token) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const pushes = [];
  let counter = 0;
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data);
    if (frame.type === "push") { pushes.push(frame.push.event); return; }
    const id = frame.type === "response" ? frame.response.id : frame.id;
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    if (frame.type === "hello-reply") waiter.resolve(frame.reply);
    else if (frame.response.error) waiter.reject(Object.assign(new Error(frame.response.error.message), { code: frame.response.error.code }));
    else waiter.resolve(frame.response.result);
  });
  const send = (frame, id) => new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify(frame)); });
  return {
    pushes,
    open: () => new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); })
      .then(() => send({ type: "hello", id: "h", hello: { protocol: 1, token } }, "h")),
    request: (method, params = []) => { const id = `r${++counter}`; return send({ type: "request", request: { id, method, params } }, id); },
    close: () => socket.close(),
  };
}

async function run({ corrupt = false, unsigned = false }) {
  const dir = await mkdtemp(join(tmpdir(), "tau-host-update-"));
  const feed = await startFeed({ corrupt, unsigned });
  const host = await startHost({ feed, dir });
  const client = connect(host.url, host.token);
  try {
    await client.open();
    const label = unsigned ? "unsigned feed" : corrupt ? "corrupt download" : "good release";
    const before = await client.request("update-status");
    if (before.installer !== "host" || before.phase !== "idle" || before.automatic !== true) fail(`${label}: unexpected first status ${JSON.stringify(before)}`);
    step(`${label}: update-status answers ${before.version}, installed by the host itself`);
    if (unsigned) {
      const checked = await client.request("update-check");
      if (checked.phase !== "failed" || !/signature/u.test(checked.reason ?? "")) fail(`an unsigned feed was not refused: ${JSON.stringify(checked)}`);
      const installed = await client.request("update-install");
      if (installed.phase !== "failed" || existsSync(host.marker) || feed.requests.some((url) => url.endsWith(".deb"))) fail(`an unsigned feed reached the download: ${JSON.stringify(installed)}`);
      step(`update-check refuses a feed without the release key's signature: ${checked.reason}`);
      return;
    }
    if (!corrupt) {
      const checked = await client.request("update-check");
      // Automatic: it downloads at once, but installs only after the host was quiet for a while.
      if (checked.phase !== "ready" || checked.latest !== VERSION) fail(`the check did not stage ${VERSION}: ${JSON.stringify(checked)}`);
      if (existsSync(host.marker)) fail("an automatic install ran without the quiet period");
      step(`update-check finds ${VERSION} and downloads it, installing nothing yet`);
      const phases = client.pushes.filter((event) => event.type === "update-status").map((event) => event.status.phase);
      for (const phase of ["checking", "available", "downloading", "ready"]) if (!phases.includes(phase)) fail(`no update-status push for ${phase}: ${phases.join(", ")}`);
      step(`update-status pushes: ${[...new Set(phases)].join(" → ")}`);
    }
    const installed = await client.request("update-install");
    if (corrupt) {
      if (installed.phase !== "failed" || !/checksum/u.test(installed.reason ?? "")) fail(`a corrupt download was not refused: ${JSON.stringify(installed)}`);
      if (existsSync(host.marker)) fail("the corrupt download reached the installer");
      step("update-install refuses a download that does not match the release's checksum");
    } else {
      if (installed.phase !== "installed") fail(`update-install did not install: ${JSON.stringify(installed)}`);
      const marker = JSON.parse(readFileSync(host.marker, "utf8"));
      if (marker.version !== VERSION || marker.sha512 !== feed.sha512) fail(`the installer got ${JSON.stringify(marker)}`);
      step(`update-install hands ${marker.file} (checksum verified) to the installer`);
    }
  } finally {
    client.close();
    await host.stop();
    await feed.close();
    await rm(dir, { recursive: true, force: true });
  }
}

if (!existsSync(HOST_ENTRY)) fail("dist-electron is missing; run npm run build first");
await run({});
await run({ corrupt: true });
await run({ unsigned: true });
console.log("host update smoke passed");
