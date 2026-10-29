import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import fs, { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createConnectRelay } from "./service.mjs";

test("route registration, credential roles, persistence and revocation", async () => {
  const folder = await mkdtemp(join(tmpdir(), "tau-relay-check-"));
  const adminToken = randomBytes(32).toString("base64url");
  const server = createServer(); const relay = await createConnectRelay(server, { adminToken, store: join(folder, "routes.json"), pendingMs: 50 });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  let host;
  try {
    assert.equal((await fetch(`${url}/v1/routes`, { method: "POST" })).status, 401);
    const response = await fetch(`${url}/v1/routes`, { method: "POST", headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(response.status, 201); const route = await response.json();
    const persisted = await readFile(join(folder, "routes.json"), "utf8"); assert.ok(!persisted.includes(route.hostToken)); assert.ok(!persisted.includes(route.clientToken));
    host = new WebSocket(`${url.replace("http:", "ws:")}/v1/host/${route.id}`, { headers: { Authorization: `Bearer ${route.hostToken}` } });
    await once(host, "open"); assert.equal(relay.stats().hosts, 1);
    const denied = new WebSocket(`${url.replace("http:", "ws:")}/v1/client/${route.id}`, { headers: { Authorization: `Bearer ${route.hostToken}` } });
    const deniedError = await new Promise((resolve) => denied.once("error", resolve)); assert.match(deniedError.message, /401/u); denied.terminate();
    assert.equal((await fetch(`${url}/v1/routes/${route.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${route.clientToken}` } })).status, 401);
    const closed = once(host, "close");
    assert.equal((await fetch(`${url}/v1/routes/${route.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${route.hostToken}` } })).status, 200);
    await closed; assert.equal(relay.stats().routes, 0); assert.equal(relay.stats().hosts, 0);
  } finally {
    host?.terminate(); relay.close(); await new Promise((resolve) => server.close(resolve)); await rm(folder, { recursive: true, force: true });
  }
});

test("browser relay authenticates before opening a host route and accepts only binary TLS records", async () => {
  const adminToken = randomBytes(32).toString("base64url");
  const server = createServer();
  const relay = await createConnectRelay(server, { adminToken, authMs: 80, maxPendingAuth: 1 });
  const peers = [];
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  const socket = (path, options) => { const peer = new WebSocket(`${url.replace("http:", "ws:")}${path}`, options); peers.push(peer); return peer; };
  try {
    const route = await (await fetch(`${url}/v1/routes`, { method: "POST", headers: { Authorization: `Bearer ${adminToken}` } })).json();
    const host = socket(`/v1/host/${route.id}`, { headers: { Authorization: `Bearer ${route.hostToken}` } });
    await once(host, "open");
    let opened = 0; host.on("message", () => opened++);

    const stalled = socket(`/v1/browser/${route.id}`, "tau-connect-v1");
    await once(stalled, "open");
    assert.equal(relay.stats().authenticating, 1);
    const limited = socket(`/v1/browser/${route.id}`, "tau-connect-v1");
    const error = await new Promise((resolve) => limited.once("error", resolve));
    assert.match(error.message, /400/u);
    assert.equal((await once(stalled, "close"))[0], 4401);
    assert.equal(opened, 0); assert.equal(relay.stats().authenticating, 0);

    for (const auth of [Buffer.from("not TLS"), JSON.stringify({ type: "authenticate", token: route.hostToken }), JSON.stringify({ type: "authenticate", token: route.clientToken, extra: "ignored" }).repeat(30)]) {
      // A single authentication slot requires sequential negative cases.
      // oxlint-disable-next-line no-await-in-loop
      const denied = socket(`/v1/browser/${route.id}`, "tau-connect-v1"); await once(denied, "open");
      // oxlint-disable-next-line no-await-in-loop
      const closed = once(denied, "close"); denied.send(auth); assert.equal((await closed)[0], 4401);
    }
    assert.equal(opened, 0);
    const browser = socket(`/v1/browser/${route.id}`, "tau-connect-v1"); await once(browser, "open");
    const accepted = once(browser, "message"); const request = once(host, "message");
    browser.send(JSON.stringify({ type: "authenticate", token: route.clientToken }));
    assert.deepEqual(JSON.parse(String((await accepted)[0])), { type: "authenticated" });
    const connection = JSON.parse(String((await request)[0])).id;
    const data = socket(`/v1/data/${route.id}/${connection}`, { headers: { Authorization: `Bearer ${route.hostToken}` } }); await once(data, "open");
    const received = once(data, "message"); const ciphertext = randomBytes(1024); browser.send(ciphertext);
    assert.deepEqual((await received)[0], ciphertext);
    const returned = once(browser, "message"); data.send(ciphertext); assert.deepEqual((await returned)[0], ciphertext);
    let plaintextForwarded = false;
    data.on("message", () => { plaintextForwarded = true; });
    const closed = once(browser, "close"); const dataClosed = once(data, "close");
    browser.send("plaintext"); assert.equal((await closed)[0], 1008); await dataClosed;
    assert.equal(plaintextForwarded, false);
  } finally { for (const peer of peers) peer.terminate(); relay.close(); await new Promise((resolve) => server.close(resolve)); }
});


// These checks use real HTTP, WebSockets and temporary stores, including across restart.
async function persistentRelay(t, options = {}) {
  const folder = await mkdtemp(join(tmpdir(), "tau-relay-persistence-"));
  const store = join(folder, "routes.json");
  const adminToken = randomBytes(32).toString("base64url");
  const peers = [];
  let server; let relay; let url;
  const stop = async () => {
    for (const peer of peers) peer.terminate();
    relay?.close();
    server?.closeAllConnections();
    if (server) await new Promise((resolve) => server.close(resolve));
  };
  t.after(async () => { await stop(); await rm(folder, { recursive: true, force: true }); });
  const start = async () => {
    server = createServer();
    relay = await createConnectRelay(server, { adminToken, store, ...options });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    url = `http://127.0.0.1:${server.address().port}`;
  };
  await start();
  const request = (method, suffix = "", token = adminToken) => fetch(`${url}/v1/routes${suffix}`, {
    method, headers: { Authorization: `Bearer ${token}` },
  });
  return {
    store,
    get server() { return server; },
    stats: () => relay.stats(),
    post: () => request("POST"),
    remove: (route, token) => request("DELETE", `/${route.id}`, token),
    disk: async () => JSON.parse(await readFile(store, "utf8")),
    restart: async () => { await stop(); await start(); },
    peer: (path, token) => {
      const peer = new WebSocket(`${url.replace("http:", "ws:")}/v1/${path}`, typeof token === "string"
        ? { headers: { Authorization: `Bearer ${token}` } } : token);
      peers.push(peer); return peer;
    },
  };
}

async function register(fixture) {
  const response = await fixture.post();
  assert.equal(response.status, 201);
  return response.json();
}

async function assertUnauthorized(peer) {
  const error = await new Promise((resolve) => peer.once("error", resolve));
  assert.match(error.message, /401/u);
}

// Pause only the target store's rename; the write and rename still use the real filesystem.
// This makes requests during an unfinished commit deterministic without changing the service API.
async function withPausedRename(store, check) {
  const original = fs.rename;
  const entered = Promise.withResolvers(); const released = Promise.withResolvers();
  let first = true;
  fs.rename = async (source, target) => {
    if (target === store && first) { first = false; entered.resolve(); await released.promise; }
    return original(source, target);
  };
  syncBuiltinESMExports();
  try { await check({ entered: entered.promise, release: released.resolve }); }
  finally { released.resolve(); fs.rename = original; syncBuiltinESMExports(); }
}

test("failed creation leaves no route and registration recovers after storage repair", { timeout: 10_000 }, async (t) => {
  const f = await persistentRelay(t);
  await mkdir(`${f.store}.tmp`);
  assert.equal((await f.post()).status, 500);
  assert.equal(f.stats().routes, 0);
  await assert.rejects(readFile(f.store), { code: "ENOENT" });
  await rm(`${f.store}.tmp`, { recursive: true });
  const route = await register(f);
  assert.deepEqual(Object.keys(await f.disk()), [route.id]);
  await f.restart();
  const host = f.peer(`host/${route.id}`, route.hostToken); await once(host, "open");
  const opened = once(host, "message");
  const client = f.peer(`client/${route.id}`, route.clientToken); await once(client, "open");
  assert.equal(JSON.parse(String((await opened)[0])).type, "open");
  const persisted = await readFile(f.store, "utf8");
  assert.ok(!persisted.includes(route.hostToken)); assert.ok(!persisted.includes(route.clientToken));
});

test("failed deletion retains credentials and live data; retry revokes durably", { timeout: 10_000 }, async (t) => {
  const f = await persistentRelay(t);
  const route = await register(f);
  const before = await f.disk();
  const host = f.peer(`host/${route.id}`, route.hostToken); await once(host, "open");
  const opened = once(host, "message");
  const client = f.peer(`client/${route.id}`, route.clientToken); await once(client, "open");
  const id = JSON.parse(String((await opened)[0])).id;
  const data = f.peer(`data/${route.id}/${id}`, route.hostToken); await once(data, "open");
  await mkdir(`${f.store}.tmp`);
  assert.equal((await f.remove(route, route.hostToken)).status, 500);
  assert.equal(f.stats().routes, 1);
  assert.deepEqual(await f.disk(), before);
  assert.equal(host.readyState, WebSocket.OPEN); assert.equal(client.readyState, WebSocket.OPEN);
  const received = once(data, "message"); client.send(Buffer.from("still connected"));
  assert.equal(String((await received)[0]), "still connected");
  await rm(`${f.store}.tmp`, { recursive: true });
  // Restart after the failed DELETE must preserve the original credentials.
  await f.restart();
  const resumed = f.peer(`host/${route.id}`, route.hostToken); await once(resumed, "open");
  const closed = once(resumed, "close");
  assert.equal((await f.remove(route, route.hostToken)).status, 200); await closed;
  assert.deepEqual(await f.disk(), {});
  await f.restart();
  assert.equal(f.stats().routes, 0);
  await assertUnauthorized(f.peer(`host/${route.id}`, route.hostToken));
  await assertUnauthorized(f.peer(`client/${route.id}`, route.clientToken));
});

test("failed deletion does not poison subsequent creates or a same-process delete retry", { timeout: 10_000 }, async (t) => {
  const f = await persistentRelay(t);
  const route = await register(f);
  await mkdir(`${f.store}.tmp`);
  assert.equal((await f.remove(route)).status, 500);
  await rm(`${f.store}.tmp`, { recursive: true });
  const other = await register(f);
  assert.equal((await f.remove(route, route.hostToken)).status, 200);
  assert.deepEqual(Object.keys(await f.disk()), [other.id]);
  await f.restart();
  assert.equal(f.stats().routes, 1);
  const host = f.peer(`host/${other.id}`, other.hostToken); await once(host, "open");
  await assertUnauthorized(f.peer(`host/${route.id}`, route.hostToken));
});

test("concurrent failed creates leave no ghost routes on disk or after restart", { timeout: 10_000 }, async (t) => {
  const f = await persistentRelay(t);
  const existing = await register(f);
  const before = await f.disk();
  await mkdir(`${f.store}.tmp`);
  const failed = await Promise.all(Array.from({ length: 8 }, () => f.post()));
  assert.deepEqual(failed.map((response) => response.status), Array(8).fill(500));
  assert.equal(f.stats().routes, 1); assert.deepEqual(await f.disk(), before);
  await rm(`${f.store}.tmp`, { recursive: true });
  const added = await Promise.all(Array.from({ length: 8 }, () => register(f)));
  const ids = [existing, ...added].map((route) => route.id).sort();
  assert.deepEqual(Object.keys(await f.disk()).sort(), ids);
  assert.equal(f.stats().routes, ids.length);
  await f.restart();
  assert.equal(f.stats().routes, ids.length);
  await Promise.all(added.map(async (route) => {
    const host = f.peer(`host/${route.id}`, route.hostToken); await once(host, "open");
  }));
});

test("creation is unpublished until commit and concurrent creates respect the route limit", { timeout: 10_000 }, async (t) => {
  const f = await persistentRelay(t, { maxRoutes: 1 });
  await withPausedRename(f.store, async ({ entered, release }) => {
    const first = f.post(); await entered;
    const arriving = once(f.server, "request"); const second = f.post(); await arriving;
    assert.equal(f.stats().routes, 0);
    await assert.rejects(readFile(f.store), { code: "ENOENT" });
    release();
    const created = await first; assert.equal(created.status, 201);
    assert.equal((await second).status, 429);
    const route = await created.json();
    assert.deepEqual(Object.keys(await f.disk()), [route.id]);
  });
});

test("concurrent deletion commits before revocation, rechecks ownership, and frees capacity", { timeout: 10_000 }, async (t) => {
  const f = await persistentRelay(t, { maxRoutes: 1 });
  const route = await register(f);
  const host = f.peer(`host/${route.id}`, route.hostToken); await once(host, "open");
  const opened = once(host, "message");
  const client = f.peer(`client/${route.id}`, route.clientToken); await once(client, "open");
  const id = JSON.parse(String((await opened)[0])).id;
  const data = f.peer(`data/${route.id}/${id}`, route.hostToken); await once(data, "open");
  const waiting = once(host, "message");
  const pending = f.peer(`client/${route.id}`, route.clientToken); await once(pending, "open"); await waiting;
  const browser = f.peer(`browser/${route.id}`, ["tau-connect-v1"]); await once(browser, "open");
  await withPausedRename(f.store, async ({ entered, release }) => {
    const removal = f.remove(route, route.hostToken); await entered;
    const arriving = once(f.server, "request"); const repeated = f.remove(route, route.hostToken); await arriving;
    const arrivingCreate = once(f.server, "request"); const creation = f.post(); await arrivingCreate;
    assert.equal(f.stats().routes, 1);
    assert.deepEqual(Object.keys(await f.disk()), [route.id]);
    for (const peer of [host, client, data, pending, browser]) assert.equal(peer.readyState, WebSocket.OPEN);
    const closed = Promise.all([host, client, data, pending, browser].map((peer) => once(peer, "close")));
    release();
    assert.equal((await removal).status, 200);
    assert.equal((await repeated).status, 401);
    const response = await creation; assert.equal(response.status, 201);
    const replacement = await response.json();
    await closed;
    assert.deepEqual(Object.keys(await f.disk()), [replacement.id]);
    assert.equal((await f.remove(route)).status, 404);
    await assertUnauthorized(f.peer(`host/${route.id}`, route.hostToken));
    await f.restart();
    assert.deepEqual(Object.keys(await f.disk()), [replacement.id]);
    const resumed = f.peer(`host/${replacement.id}`, replacement.hostToken); await once(resumed, "open");
  });
});

test("a queued create excludes another create whose rename failed", { timeout: 10_000 }, async (t) => {
  const f = await persistentRelay(t);
  await withPausedRename(f.store, async ({ entered, release }) => {
    const first = f.post(); await entered;
    const [uncommittedId] = Object.keys(JSON.parse(await readFile(`${f.store}.tmp`, "utf8")));
    const arriving = once(f.server, "request"); const second = f.post(); await arriving;
    // Remove the staged file so the first real rename fails with ENOENT.
    await rm(`${f.store}.tmp`); release();
    assert.equal((await first).status, 500);
    const created = await second; assert.equal(created.status, 201);
    const route = await created.json();
    assert.notEqual(route.id, uncommittedId);
    assert.equal(f.stats().routes, 1);
    assert.deepEqual(Object.keys(await f.disk()), [route.id]);
    await f.restart();
    assert.equal(f.stats().routes, 1);
    const host = f.peer(`host/${route.id}`, route.hostToken); await once(host, "open");
  });
});

test("a queued create preserves a route whose deletion failed at rename", { timeout: 10_000 }, async (t) => {
  const f = await persistentRelay(t);
  const route = await register(f);
  const original = (await f.disk())[route.id];
  const host = f.peer(`host/${route.id}`, route.hostToken); await once(host, "open");
  await withPausedRename(f.store, async ({ entered, release }) => {
    const removal = f.remove(route); await entered;
    const arriving = once(f.server, "request"); const creation = f.post(); await arriving;
    await rm(`${f.store}.tmp`); release();
    assert.equal((await removal).status, 500);
    const created = await creation; assert.equal(created.status, 201);
    const other = await created.json();
    const saved = await f.disk();
    assert.deepEqual(saved[route.id], original);
    assert.deepEqual(Object.keys(saved).sort(), [route.id, other.id].sort());
    assert.equal(host.readyState, WebSocket.OPEN);
    await f.restart();
    assert.equal(f.stats().routes, 2);
    const resumed = f.peer(`host/${route.id}`, route.hostToken); await once(resumed, "open");
    assert.equal((await f.remove(route, route.hostToken)).status, 200);
    assert.deepEqual(Object.keys(await f.disk()), [other.id]);
  });
});
