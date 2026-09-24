#!/usr/bin/env node
// Drives a development build of the app in the iOS Simulator or the Android
// emulator, the way `npm run cdp` drives a desktop instance:
//
//   node scripts/sim.mjs serve                 bridge on 127.0.0.1 (run it in the background)
//   node scripts/sim.mjs eval "<expression>"   evaluates in the app's web view, prints JSON
//   node scripts/sim.mjs wait-for "<expr>" [ms]
//
// Only a build made with `vite build --mode development` connects (see
// src/dev-automation.ts); the Android emulator reaches this machine as 10.0.2.2.
// The bridge listens on loopback only. Helpers in scope: all(sel), byText(sel, re),
// tap(el), type(el, text), sleep(ms), text().
import { createServer } from "node:http";
import { createRequire } from "node:module";

const port = Number(process.env.TAU_AUTOMATION_PORT ?? 9477);
const [command, ...args] = process.argv.slice(2);

async function post(expr, timeoutMs) {
  const response = await fetch(`http://127.0.0.1:${port}/eval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expr, timeoutMs }),
  });
  return response.json();
}

async function serve() {
  // The repository's own `ws`, so the app package needs no dependency for a dev tool.
  const { WebSocketServer } = createRequire(new URL("../../package.json", import.meta.url))("ws");
  let app;
  let counter = 0;
  const waiting = new Map();
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/status") {
      response.end(JSON.stringify({ connected: Boolean(app) }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/eval") {
      response.statusCode = 404;
      response.end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const { expr, timeoutMs = 15_000 } = JSON.parse(body);
      if (!app) {
        response.end(JSON.stringify({ error: "No app is connected. Is a development build running?" }));
        return;
      }
      const id = `e${(counter += 1)}`;
      const timer = setTimeout(() => {
        waiting.delete(id);
        response.end(JSON.stringify({ error: `No answer within ${timeoutMs} ms.` }));
      }, timeoutMs);
      waiting.set(id, (reply) => {
        clearTimeout(timer);
        response.end(JSON.stringify(reply));
      });
      app.send(JSON.stringify({ id, expr }));
    });
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => {
    app = socket;
    console.log(`[sim] app connected ${new Date().toISOString()}`);
    socket.on("message", (data) => {
      const reply = JSON.parse(String(data));
      waiting.get(reply.id)?.(reply);
      waiting.delete(reply.id);
    });
    socket.on("close", () => {
      if (app === socket) app = undefined;
      console.log(`[sim] app disconnected ${new Date().toISOString()}`);
    });
  });
  server.listen(port, "127.0.0.1", () => console.log(`[sim] pid=${process.pid} listening on 127.0.0.1:${port}`));
}

async function main() {
  switch (command) {
    case "serve":
      await serve();
      return;
    case "eval": {
      const reply = await post(args[0], Number(args[1] ?? 15_000));
      console.log(JSON.stringify(reply.error ? { error: reply.error } : reply.result, null, 2));
      if (reply.error) process.exitCode = 1;
      return;
    }
    case "wait-for": {
      const deadline = Date.now() + Number(args[1] ?? 15_000);
      while (Date.now() < deadline) {
        const reply = await post(args[0], 5_000).catch(() => ({}));
        if (reply.result) { console.log(JSON.stringify(reply.result)); return; }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      console.error("timed out");
      process.exitCode = 1;
      return;
    }
    default:
      console.error("usage: sim.mjs serve | eval <expr> [ms] | wait-for <expr> [ms]");
      process.exitCode = 2;
  }
}

await main();
