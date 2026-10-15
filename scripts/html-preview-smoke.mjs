// A real Chromium frame under the native app's CSP. CDP stands in for the
// native resource handler; bytes still pass through the production bridge/store.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { findChromium, chromeArgs } from "./tau-mobile-cdp.mjs";
import { connect, evaluate, waitFor, waitForPage } from "./compare/cdp.mjs";
import { BIND_BROWSER_RESOURCES, HostBrowserResourceStore } from "../dist-electron/main/host-browser-resources.js";
import { runAsCaller } from "../dist-electron/main/host-invocation.js";

const directory = resolve(".tau-dev/html-preview-smoke");
await mkdir(directory, { recursive: true });
const store = new HostBrowserResourceStore();
const asPhone = (run) => runAsCaller({ kind: "workbench-client", connection: "phone" }, run);
const page = await asPhone(async () => store.services[BIND_BROWSER_RESOURCES]("pages").publishFrame({ html: `
<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:20px system-ui;padding:20px;background:#fff;color:#171717}button{font:inherit;padding:12px}</style></head><body>
<h1>HTML preview</h1><button id="count">Count: 0</button><script>
let count=0;document.querySelector('button').onclick=()=>{document.querySelector('button').textContent='Count: '+(++count);parent.postMessage({kind:'count',count},'*')};
let storageBlocked=false,parentBlocked=false;
try{localStorage.getItem('secret')}catch{storageBlocked=true}
try{parent.document.body}catch{parentBlocked=true}
fetch('https://example.invalid/blocked').then(()=>parent.postMessage({kind:'network-allowed'},'*')).catch(()=>parent.postMessage({kind:'ready',storageBlocked,parentBlocked},'*'));
</script></body></html>` }));
const policy = /<meta http-equiv="Content-Security-Policy"[^>]*>/u.exec(await readFile("mobile/index.html", "utf8"))[0];
await build({ stdin: { contents: `
import React from 'react';import{createRoot}from'react-dom/client';
import{SandboxFrame}from'./src/renderer/components/SandboxFrame.tsx';
import{createBrowserResourceBridge}from'./mobile/src/browser-resources.ts';
window.reports=[];
const bridge=await createBrowserResourceBridge({
listen:async callback=>{window.resourceRequest=callback;return()=>{}},
respond:async response=>window.nativeResponse(JSON.stringify(response)),close:async()=>{}
},'android');
const route=bridge.open(async path=>{const res=await fetch('/read-resource',{method:'POST',body:path});return res.json()});
createRoot(document.getElementById('root')).render(React.createElement(SandboxFrame,{src:route.resourceUrl(${JSON.stringify(page)}),title:'HTML preview',height:500,onMessage:data=>window.reports.push(data)}));
`, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, format: "esm", target: "es2022", outfile: `${directory}/probe.js` });
let browser;
let session;
let server;
const paused = new Map();
try {
  server = createServer(async (request, response) => {
    try {
      if (request.url === "/read-resource" && request.method === "POST") {
        let path = ""; for await (const chunk of request) path += chunk;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(await asPhone(() => store.readForClient(path))));
      } else if (request.url === "/probe.js" || request.url === "/probe.css") {
        response.setHeader("content-type", request.url.endsWith(".css") ? "text/css" : "text/javascript");
        response.end(await readFile(directory + request.url));
      } else {
        response.setHeader("content-type", "text/html");
        response.end(`<!doctype html><html><head>${policy}<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/probe.css"></head><body><div id="root"></div><script type="module" src="/probe.js"></script></body></html>`);
      }
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  browser = spawn(findChromium(), chromeArgs({ port: 0, profile: `${directory}/profile`, device: "android" }), { stdio: ["ignore", "ignore", "pipe"] });
  let logs = "";
  const endpoint = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error("Chromium did not start")), 15_000);
    browser.stderr.on("data", (chunk) => { logs += chunk; const match = /DevTools listening on ws:\/\/127.0.0.1:(\d+)/u.exec(logs); if (match) { clearTimeout(timer); done(Number(match[1])); } });
    browser.once("error", fail);
  });
  session = await connect((await waitForPage(endpoint)).webSocketDebuggerUrl);
  await session.send("Runtime.enable");
  await session.send("Runtime.addBinding", { name: "nativeResponse" });
  session.on("Runtime.bindingCalled", ({ name, payload }) => {
    if (name !== "nativeResponse") return;
    const result = JSON.parse(payload);
    const requestId = paused.get(result.id);
    if (!requestId) return;
    paused.delete(result.id);
    void session.send("Fetch.fulfillRequest", { requestId, responseCode: result.status, responseHeaders: Object.entries(result.headers).map(([headerName, value]) => ({ name: headerName, value })), body: result.body });
  });
  session.on("Fetch.requestPaused", ({ requestId, request }) => {
    const match = /^\/([^/]+)(\/resources\/[a-f0-9]{64})$/u.exec(new URL(request.url).pathname);
    assert.ok(match);
    paused.set(requestId, requestId);
    void evaluate(session, `window.resourceRequest(${JSON.stringify({ id: requestId, connectionId: match[1], path: match[2] })})`);
  });
  await session.send("Fetch.enable", { patterns: [{ urlPattern: "https://tau-resources.localhost/*", requestStage: "Request" }] });
  await session.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}` });
  await waitFor(session, "window.reports?.some(r=>r.kind==='ready')", { timeoutMs: 10_000 });
  const reports = await evaluate(session, "window.reports");
  assert.deepEqual(reports.find((entry) => entry.kind === "ready"), { kind: "ready", storageBlocked: true, parentBlocked: true });
  assert.ok(!reports.some((entry) => entry.kind === "network-allowed"));
  // A click in the child uses real input, while the parent cannot inspect its DOM.
  const frame = await evaluate(session, "(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return{x:r.x,y:r.y}})()");
  for (const type of ["mousePressed", "mouseReleased"]) await session.send("Input.dispatchMouseEvent", { type, x: frame.x + 75, y: frame.y + 130, button: "left", clickCount: 1 });
  await waitFor(session, "window.reports.some(r=>r.kind==='count'&&r.count===1)", { timeoutMs: 5_000 });
  const capture = await session.send("Page.captureScreenshot", { format: "png" });
  await writeFile(`${directory}/preview.png`, Buffer.from(capture.data, "base64"));
  console.log("PASS: mobile CSP renders an interactive sandbox frame through the native resource bridge; parent, storage and network remain blocked.");
  console.log(`${directory}/preview.png`);
} finally {
  session?.close();
  if (browser && browser.exitCode === null) { browser.kill("SIGTERM"); const force = setTimeout(() => browser.kill("SIGKILL"), 2_000); await once(browser, "exit"); clearTimeout(force); }
  if (server) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
  store.close();
}
