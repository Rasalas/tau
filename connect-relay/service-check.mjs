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
