import { randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { Transform } from "node:stream";
import { WebSocketServer, createWebSocketStream, WebSocket } from "ws";

const secret = () => randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const matches = (value, hash) => typeof value === "string" && typeof hash === "string" && timingSafeEqual(Buffer.from(digest(value), "hex"), Buffer.from(hash, "hex"));
const bearer = (request) => /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(request.headers.authorization ?? "")?.[1];

/** A relay sees ciphertext only. Host authentication and pairing happen inside the tunneled TLS session. */
export async function createConnectRelay(server, { adminToken, store, maxRoutes = 100, maxConnections = 100, pendingMs = 10_000, authMs = 5_000, maxPendingAuth = 25 } = {}) {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(adminToken ?? "")) throw new Error("TAU_CONNECT_ADMIN_TOKEN must contain 32 random bytes in base64url form.");
  let routes = {};
  if (store) {
    try { routes = JSON.parse(await readFile(store, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const [id, route] of Object.entries(routes)) {
    if (!/^[a-f0-9-]{36}$/u.test(id) || !/^[a-f0-9]{64}$/u.test(route.host) || !/^[a-f0-9]{64}$/u.test(route.client)) throw new Error("The relay route store is invalid.");
  }
  const controls = new Map();
  const pending = new Map();
  const active = new Map();
  const authenticating = new Set();
  let writing = Promise.resolve();
  const persist = () => {
    const bytes = JSON.stringify(routes);
    writing = writing.then(async () => {
      if (!store) return;
      await mkdir(dirname(store), { recursive: true, mode: 0o700 });
      await writeFile(`${store}.tmp`, bytes, { mode: 0o600 });
      await rename(`${store}.tmp`, store);
    });
    return writing;
  };
  const ws = new WebSocketServer({ noServer: true, maxPayload: 65_536, perMessageDeflate: false });
  const send = (response, code, body) => { response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(body)); };
  const onRequest = async (request, response) => {
    if (request.url === "/health" && request.method === "GET") return send(response, 200, { status: "ok" });
    const admin = matches(bearer(request), digest(adminToken));
    const ownedRoute = /^\/v1\/routes\/([a-f0-9-]{36})$/u.exec(request.url ?? "")?.[1];
    if (!admin && !(request.method === "DELETE" && ownedRoute && routes[ownedRoute] && matches(bearer(request), routes[ownedRoute].host))) return send(response, 401, { error: "unauthorized" });
    try {
      if (request.url === "/v1/routes" && request.method === "POST") {
        if (!admin) return send(response, 401, { error: "unauthorized" });
        if (Object.keys(routes).length >= maxRoutes) return send(response, 429, { error: "route limit" });
        const id = randomUUID(); const hostToken = secret(); const clientToken = secret();
        routes[id] = { host: digest(hostToken), client: digest(clientToken) };
        try { await persist(); } catch (error) { delete routes[id]; throw error; }
        return send(response, 201, { id, hostToken, clientToken });
      }
      const id = /^\/v1\/routes\/([a-f0-9-]{36})$/u.exec(request.url ?? "")?.[1];
      if (id && request.method === "DELETE") {
        if (!routes[id]) return send(response, 404, { error: "unknown route" });
        delete routes[id];
        controls.get(id)?.terminate();
        for (const entry of pending.values()) if (entry.route === id) entry.client.terminate();
        for (const entry of active.values()) if (entry.route === id) { entry.client.terminate(); entry.host.terminate(); }
        await persist();
        return send(response, 200, { removed: true });
      }
      return send(response, 404, { error: "unknown endpoint" });
    } catch { return send(response, 500, { error: "route persistence failed" }); }
  };
  server.on("request", onRequest);
  const onUpgrade = (request, socket, head) => {
    const match = /^\/v1\/(host|client|data|browser)\/([a-f0-9-]{36})(?:\/([a-f0-9-]{36}))?$/u.exec(request.url ?? "");
    const role = match?.[1]; const route = match?.[2]; const id = match?.[3];
    const record = routes[route];
    const browser = role === "browser";
    if (browser && (id || request.headers["sec-websocket-protocol"] !== "tau-connect-v1" || authenticating.size >= maxPendingAuth)) { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return; }
    if (!record || (!browser && !matches(bearer(request), record[role === "client" ? "client" : "host"]))) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return; }
    if ((role === "client" || browser) && (!controls.has(route) || pending.size + active.size >= maxConnections)) { socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); return; }
    if (role === "data" && (!id || pending.get(id)?.route !== route)) { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return; }
    if (role !== "data" && id) { socket.destroy(); return; }
    ws.handleUpgrade(request, socket, head, (peer) => {
      if (!browser) { attach(peer, role, route, id); return; }
      authenticating.add(peer);
      const finish = () => { clearTimeout(timer); authenticating.delete(peer); };
      const timer = setTimeout(() => { finish(); peer.close(4401, "Relay authentication timed out"); }, authMs);
      peer.on("error", () => peer.terminate());
      peer.once("close", finish);
      peer.once("message", (data, binary) => {
        finish();
        let auth;
        try { if (!binary && data.length <= 1024) auth = JSON.parse(data.toString()); } catch { /* invalid authentication */ }
        if (auth?.type !== "authenticate" || !/^[A-Za-z0-9_-]{43}$/u.test(auth.token ?? "") || !matches(auth.token, routes[route]?.client)) {
          peer.close(4401, "Relay authentication refused"); return;
        }
        if (!controls.has(route) || pending.size + active.size >= maxConnections) { peer.close(1013, "Host unavailable"); return; }
        peer.send(JSON.stringify({ type: "authenticated" }));
        attach(peer, "client", route);
      });
    });
  };
  const attach = (peer, role, route, id) => {
      peer.on("error", () => peer.terminate());
      peer.on("message", (_data, binary) => { if (role !== "host" && !binary) { peer.invalid = true; peer.close(1008, "TLS records must be binary"); } });
      peer.alive = true;
      peer.on("pong", () => { peer.alive = true; });
      if (role === "host") {
        controls.get(route)?.terminate(); controls.set(route, peer);
        peer.on("message", () => peer.close(1008, "Control channel is server to host only"));
        peer.on("close", () => {
          if (controls.get(route) !== peer) return;
          controls.delete(route);
          for (const entry of pending.values()) if (entry.route === route) entry.client.terminate();
          for (const entry of active.values()) if (entry.route === route) { entry.client.terminate(); entry.host.terminate(); }
        });
      } else if (role === "client") {
        const connection = randomUUID();
        const stream = createWebSocketStream(peer, { highWaterMark: 65_536 });
        stream.on("error", () => peer.terminate());
        const timer = setTimeout(() => { pending.delete(connection); peer.terminate(); stream.destroy(); }, pendingMs);
        pending.set(connection, { route, client: peer, stream, timer });
        peer.on("close", () => { clearTimeout(timer); pending.delete(connection); stream.destroy(); });
        controls.get(route).send(JSON.stringify({ type: "open", id: connection }));
      } else {
        const entry = pending.get(id);
        if (!entry) { peer.terminate(); return; }
        clearTimeout(entry.timer); pending.delete(id);
        const stream = createWebSocketStream(peer, { highWaterMark: 65_536 });
        stream.on("error", () => peer.terminate());
        active.set(id, { route, host: peer, client: entry.client });
        // Closing a socket alone does not stop createWebSocketStream's message
        // listener from consuming that same frame. Guard both stream directions.
        const gate = (source) => new Transform({
          highWaterMark: 65_536,
          transform(bytes, _encoding, callback) {
            if (source.invalid) callback(new Error("Relay TLS stream received a text frame."));
            else callback(null, bytes);
          },
        });
        const clientGate = gate(entry.client); const hostGate = gate(peer);
        const stop = () => { active.delete(id); clientGate.destroy(); hostGate.destroy(); stream.destroy(); entry.stream.destroy(); peer.terminate(); entry.client.terminate(); };
        clientGate.on("error", stop); hostGate.on("error", stop);
        peer.on("close", stop); entry.client.on("close", stop);
        entry.stream.pipe(clientGate).pipe(stream);
        stream.pipe(hostGate).pipe(entry.stream);
      }
  };
  server.on("upgrade", onUpgrade);
  const heartbeat = setInterval(() => {
    for (const peer of ws.clients) {
      if (!peer.alive) peer.terminate();
      else { peer.alive = false; if (peer.readyState === WebSocket.OPEN) peer.ping(); }
    }
  }, 15_000);
  heartbeat.unref();
  return {
    close() { clearInterval(heartbeat); server.off("request", onRequest); server.off("upgrade", onUpgrade); for (const peer of ws.clients) peer.terminate(); ws.close(); },
    stats() { return { authenticating: authenticating.size, routes: Object.keys(routes).length, hosts: controls.size, pending: pending.size, active: active.size }; },
  };
}
