// A host that speaks just enough of the protocol for the supervisor's tests:
// it listens, prints the two lines the supervisor reads, answers hello with
// the version it was given, and leaves when asked. With TAU_HOST_SERVICE set
// it behaves like a service host: it asks the host `host.json` names to
// leave, takes its port, and writes `host.json` itself. Like the real host it
// takes `<userData>/host.lock` first and leaves with 75 when another holds it.
// Never used by the app.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(process.env.STUB_WS_FROM ?? import.meta.url);
const { WebSocket, WebSocketServer } = require("ws");

const version = process.env.STUB_VERSION ?? "0.0.0";
const tokenPath = process.env.STUB_TOKEN_PATH;
const token = process.env.STUB_TOKEN ?? "stub-token";
const service = process.env.TAU_HOST_SERVICE;
const descriptorPath = process.env.TAU_USER_DATA ? join(process.env.TAU_USER_DATA, "host.json") : undefined;

if (process.env.STUB_EXIT_IMMEDIATELY === "1") {
  console.error("stub host: refusing to start");
  process.exit(3);
}

mkdirSync(dirname(tokenPath), { recursive: true });
writeFileSync(tokenPath, `${token}\n`);

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** What `retireHost` does: `host.shutdown` with the token, then wait for the process to go. */
async function takeOver() {
  if (!descriptorPath || !existsSync(descriptorPath)) return 0;
  const previous = JSON.parse(readFileSync(descriptorPath, "utf8"));
  if (previous.pid !== process.pid && alive(previous.pid)) {
    await new Promise((resolve) => {
      const socket = new WebSocket(previous.url);
      socket.on("open", () => {
        socket.send(JSON.stringify({ type: "hello", id: "h", hello: { protocol: 1, token } }));
        socket.send(JSON.stringify({ type: "request", request: { id: "s", method: "host.shutdown", params: [] } }));
      });
      socket.on("close", resolve);
      socket.on("error", resolve);
    });
    while (alive(previous.pid)) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return process.env.STUB_KEEP_PORT === "0" ? 0 : Number(new URL(previous.url).port);
}

function leave() {
  if (service && descriptorPath && existsSync(descriptorPath) && JSON.parse(readFileSync(descriptorPath, "utf8")).pid === process.pid) rmSync(descriptorPath);
  process.exit(0);
}

const port = service ? await takeOver() : undefined;
let lock;
if (process.env.STUB_LOCK_FROM && process.env.TAU_USER_DATA) {
  const { tryLock } = await import(pathToFileURL(process.env.STUB_LOCK_FROM).href);
  const lockPath = join(process.env.TAU_USER_DATA, "host.lock");
  for (let attempt = 0; attempt < (service ? 100 : 1) && !lock; attempt += 1) {
    lock = await tryLock(lockPath, { pid: process.pid, startedAt: new Date().toISOString() });
    if (!lock) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!lock) {
    console.error(`another Tau host (pid ${JSON.parse(readFileSync(lockPath, "utf8")).pid}) owns this data folder`);
    process.exit(75);
  }
}
const listenPort = port ?? Number((process.env.TAU_HOST_LISTEN ?? "127.0.0.1:0").split(":").pop());
const server = new WebSocketServer({ host: "127.0.0.1", port: listenPort });
server.on("listening", () => {
  // A host that hangs before it announces itself.
  if (process.env.STUB_SILENT === "1") return;
  const url = `ws://127.0.0.1:${server.address().port}`;
  console.log(`tau-host listening on ${url}`);
  console.log(`token: ${tokenPath} (stub)`);
  if (service) writeFileSync(descriptorPath, JSON.stringify({ pid: process.pid, url, tokenPath, startedAt: new Date().toISOString(), version, service }));
});
server.on("error", (error) => {
  console.error(`stub host: ${error.message}`);
  process.exit(4);
});
server.on("connection", (socket) => {
  socket.on("message", (data) => {
    // A host that is alive and holds its folder, but answers nothing.
    if (process.env.STUB_HANG === "1") return;
    const frame = JSON.parse(String(data));
    if (frame.type === "hello") {
      if (frame.hello.token !== token) {
        socket.close(4401, "unauthorized");
        return;
      }
      socket.send(JSON.stringify({
        type: "hello-reply",
        id: frame.id,
        reply: { protocol: 1, hostVersion: version, capabilities: [], resync: false, missed: [], nextSeq: 1 },
      }));
      return;
    }
    const { id, method } = frame.request;
    socket.send(JSON.stringify({ type: "response", response: { id, result: { method } } }));
    if (method === "host.shutdown" && process.env.STUB_STUBBORN !== "1") setTimeout(leave, 10);
  });
});
process.on("SIGTERM", () => { if (process.env.STUB_STUBBORN !== "1") leave(); });
