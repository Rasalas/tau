// A host that speaks just enough of the protocol for the supervisor's tests:
// it listens, prints the two lines the supervisor reads, answers hello with
// the version it was given, and leaves when asked. Never used by the app.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(process.env.STUB_WS_FROM ?? import.meta.url);
const { WebSocketServer } = require("ws");

const version = process.env.STUB_VERSION ?? "0.0.0";
const tokenPath = process.env.STUB_TOKEN_PATH;
const token = process.env.STUB_TOKEN ?? "stub-token";

if (process.env.STUB_EXIT_IMMEDIATELY === "1") {
  console.error("stub host: refusing to start");
  process.exit(3);
}

mkdirSync(dirname(tokenPath), { recursive: true });
writeFileSync(tokenPath, `${token}\n`);

const port = Number((process.env.TAU_HOST_LISTEN ?? "127.0.0.1:0").split(":").pop());
const server = new WebSocketServer({ host: "127.0.0.1", port });
server.on("listening", () => {
  console.log(`tau-host listening on ws://127.0.0.1:${server.address().port}`);
  console.log(`token: ${tokenPath} (stub)`);
});
server.on("error", (error) => {
  console.error(`stub host: ${error.message}`);
  process.exit(4);
});
server.on("connection", (socket) => {
  socket.on("message", (data) => {
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
    if (method === "host.shutdown") setTimeout(() => process.exit(0), 10);
  });
});
