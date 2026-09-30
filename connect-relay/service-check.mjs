import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
      const denied = socket(`/v1/browser/${route.id}`, "tau-connect-v1"); await once(denied, "open");
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
    const closed = once(browser, "close"); browser.send("plaintext"); assert.equal((await closed)[0], 1008);
  } finally { for (const peer of peers) peer.terminate(); relay.close(); await new Promise((resolve) => server.close(resolve)); }
});
