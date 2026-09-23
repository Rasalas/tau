#!/usr/bin/env node
// A stand-in `opencode` for the spawn path: `--version`, and `serve` with the
// ready line, Basic auth from OPENCODE_SERVER_PASSWORD and the config it got.
import { createServer } from "node:http";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_OPENCODE_VERSION ?? "1.18.32"}\n`);
  process.exit(0);
}
if (process.env.FAKE_SERVE_FAIL) {
  process.stderr.write("Error: database is locked\n");
  process.exit(3);
}
const expected = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD ?? ""}`).toString("base64")}`;
const server = createServer((request, response) => {
  if (request.headers.authorization !== expected) {
    response.writeHead(401);
    response.end();
    return;
  }
  const body = request.url?.startsWith("/global/health")
    ? { healthy: true, version: "1.18.32" }
    : { config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}"), args, cwd: process.cwd(), xdg: process.env.XDG_DATA_HOME ?? null };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
});
server.listen(0, "127.0.0.1", () => {
  process.stderr.write("Warning: something on stderr first\n");
  process.stdout.write(`opencode server listening on http://127.0.0.1:${server.address().port}\n`);
});
process.on("SIGTERM", () => process.exit(0));
