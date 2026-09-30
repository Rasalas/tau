import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { createCloudRouteStore } from "./cloud-store.mjs";
import { createConnectRelay } from "./service.mjs";
import { createFirestoreDocument, metadataAccessToken } from "./firestore.mjs";
import { fenceRevision } from "./cloud-state.mjs";

function fakeDocument() {
  let state = { routes: {}, allowedRevision: null, lease: null };
  let time = 1_700_000_000_000;
  let failing = false;
  let chain = Promise.resolve();
  return {
    now: () => time,
    advance: (ms) => { time += ms; },
    fail: () => { failing = true; },
    snapshot: () => structuredClone(state),
    update(mutate) {
      const operation = chain.then(() => {
        if (failing) throw new Error("Firestore is unavailable.");
        const next = structuredClone(state);
        const result = mutate(next, time);
        state = next;
        return { state: structuredClone(state), result };
      });
      chain = operation.catch(() => {});
      return operation;
    },
  };
}

test("only one process owns a route across replicas, restarts and deployment fences", async () => {
  const document = fakeDocument();
  const a = createCloudRouteStore({ revision: "tau-connect-old", document, now: document.now });
  const duplicate = createCloudRouteStore({ revision: "tau-connect-old", document, now: document.now });
  const b = createCloudRouteStore({ revision: "tau-connect-next", document, now: document.now });
  let stopped = 0;
  a.subscribe({ onUnavailable: () => { stopped++; }, onRoutesChanged: () => {} });
  try {
    assert.deepEqual(await Promise.all([a.ensureReady(), duplicate.ensureReady()]), [true, false]);
    const id = "0cde33c7-c04a-411c-8c16-721366981346";
    const record = { host: "a".repeat(64), client: "b".repeat(64) };
    assert.equal(await a.add(id, record, 1), true);
    assert.equal(await a.add("e041918c-780f-4d43-aea7-24385af92ce5", record, 1), false);
    const lease = document.snapshot().lease;
    assert.equal((await fenceRevision(document, "tau-connect-next")).result, "tau-connect-old");
    assert.deepEqual(document.snapshot().lease, lease, "fence preserves the old lease until its safety deadline");
    assert.equal(await b.ensureReady(), false);
    document.advance(15_001);
    assert.equal(await a.ensureReady(), false);
    assert.ok(stopped > 0);
    assert.equal(await b.ensureReady(), false);
    document.advance(30_000);
    assert.equal(await b.ensureReady(), true);
    assert.deepEqual(b.snapshot()[id], record, "hashed registration survives the process handover");
    assert.equal(await duplicate.ensureReady(), false);
    b.close();
    const restarted = createCloudRouteStore({ revision: "tau-connect-next", document, now: document.now });
    try {
      assert.equal(await restarted.ensureReady(), false);
      document.advance(45_001);
      assert.equal(await restarted.ensureReady(), true);
      assert.equal(await restarted.remove(id), true);
      assert.equal(restarted.snapshot()[id], undefined);
    } finally { restarted.close(); }
  } finally { a.close(); duplicate.close(); b.close(); }
});

test("frozen idle CPU reacquires on request; an unavailable database closes live peers and rejects HTTP and upgrades", async () => {
  const document = fakeDocument();
  const storage = createCloudRouteStore({ revision: "tau-connect-test", document, now: document.now });
  assert.equal(await storage.ensureReady(), true);
  document.advance(60_000);
  assert.equal(storage.ready(), false);
  assert.equal(await storage.ensureReady(), true, "incoming request renews the expired idle lease");
  const adminToken = randomBytes(32).toString("base64url");
  const server = createServer();
  const relay = await createConnectRelay(server, { adminToken, routeStore: storage });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  let host;
  try {
    const response = await fetch(`${url}/v1/routes`, { method: "POST", headers: { Authorization: `Bearer ${adminToken}` } });
    const route = await response.json();
    host = new WebSocket(`${url.replace("http:", "ws:")}/v1/host/${route.id}`, { headers: { Authorization: `Bearer ${route.hostToken}` } });
    await once(host, "open");
    const closed = once(host, "close");
    document.fail(); document.advance(15_001);
    assert.equal((await fetch(`${url}/ready`)).status, 503);
    await closed;
    assert.equal((await fetch(`${url}/v1/routes`, { method: "POST", headers: { Authorization: `Bearer ${adminToken}` } })).status, 503);
    const client = new WebSocket(`${url.replace("http:", "ws:")}/v1/client/${route.id}`, { headers: { Authorization: `Bearer ${route.clientToken}` } });
    assert.match((await new Promise((resolve) => client.once("error", resolve))).message, /503/u);
    client.terminate();
  } finally { host?.terminate(); relay.close(); await new Promise((resolve) => server.close(resolve)); }
});

test("Firestore REST transactions retry aborted commits without storing raw credentials", async () => {
  const calls = [];
  let commits = 0;
  const document = createFirestoreDocument({
    project: "tau-push-e3c95", tokenProvider: async () => "test-identity",
    async fetchImpl(url, options) {
      assert.equal(options.headers.Authorization, "Bearer test-identity");
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ url, body });
      let status = 200; let response = {};
      if (url.endsWith(":beginTransaction")) response = { transaction: "opaque+transaction" };
      if (options.method === "GET") { assert.ok(url.endsWith("?transaction=opaque%2Btransaction")); status = 404; }
      if (url.endsWith(":commit") && ++commits === 1) { status = 409; response = { error: { status: "ABORTED" } }; }
      return new Response(JSON.stringify(response), { status, headers: { date: "Tue, 14 Nov 2023 22:13:20 GMT" } });
    },
  });
  const result = await document.update((state, time) => { assert.equal(time, 1_700_000_000_000); state.routes["0cde33c7-c04a-411c-8c16-721366981346"] = { host: "a".repeat(64), client: "b".repeat(64) }; return "saved"; });
  assert.equal(result.result, "saved");
  assert.equal(commits, 2);
  assert.ok(calls.some(({ url }) => url.endsWith(":rollback")));
  const write = calls.findLast(({ url }) => url.endsWith(":commit")).body.writes[0].update;
  assert.equal(write.name, "projects/tau-push-e3c95/databases/tau-connect/documents/tauConnect/state");
  assert.equal(write.fields.routes.mapValue.fields["0cde33c7-c04a-411c-8c16-721366981346"].mapValue.fields.host.stringValue, "a".repeat(64));
});

test("Firestore failures omit upstream response details; metadata tokens are cached", async () => {
  let requests = 0;
  const provider = metadataAccessToken(async (url, options) => {
    requests++;
    assert.equal(options.headers["Metadata-Flavor"], "Google");
    assert.ok(url.endsWith("/service-accounts/default/token"));
    return Response.json({ access_token: "metadata-credential", expires_in: 3600 });
  });
  assert.equal(await provider(), "metadata-credential"); assert.equal(await provider(), "metadata-credential");
  assert.equal(requests, 1);
  const document = createFirestoreDocument({ project: "tau-push-e3c95", tokenProvider: provider, fetchImpl: async () => new Response(JSON.stringify({ error: { message: "upstream-secret-text" } }), { status: 403, headers: { date: new Date().toUTCString() } }) });
  await assert.rejects(document.update(() => {}), (error) => error.message === "Firestore request failed (403).");
});

test("a process publishes route mutations in transaction order despite overlapping callers", async () => {
  const backing = fakeDocument();
  let running = 0; let peak = 0;
  const document = { async update(mutate) {
    peak = Math.max(peak, ++running);
    try {
      const result = await backing.update(mutate);
      // Slow responses after commits must not overwrite a later route snapshot.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return result;
    } finally { running--; }
  } };
  const storage = createCloudRouteStore({ revision: "tau-connect-order", document, now: backing.now });
  try {
    assert.equal(await storage.ensureReady(), true);
    const record = { host: "a".repeat(64), client: "b".repeat(64) };
    const ids = ["0cde33c7-c04a-411c-8c16-721366981346", "e041918c-780f-4d43-aea7-24385af92ce5"];
    assert.deepEqual(await Promise.all(ids.map((id) => storage.add(id, record, 100))), [true, true]);
    assert.equal(peak, 1);
    assert.deepEqual(Object.keys(storage.snapshot()), ids);
  } finally { storage.close(); }
});
