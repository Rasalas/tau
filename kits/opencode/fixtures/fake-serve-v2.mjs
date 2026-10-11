#!/usr/bin/env node
// A stand-in OpenCode 2 `opencode` for the spawn path: `--version`, and `serve`
// with the ready line (no "opencode " prefix, as 2.0.26 prints it). Like the
// real one it reads OPENCODE_PASSWORD only and ignores OPENCODE_SERVER_PASSWORD.
import { createServer } from "node:http";

const args = process.argv.slice(2);
const version = process.env.FAKE_OPENCODE_VERSION ?? "2.0.26";
if (args.includes("--version")) {
  process.stdout.write(`opencode v${version}\n`);
  process.exit(0);
}
if (process.env.FAKE_SERVE_FAIL) {
  process.stderr.write("Error: database is locked\n");
  process.exit(3);
}
const expected = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? ""}`).toString("base64")}`;
const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  // Everything outside /api is the web page, /global/health included.
  if (!path.startsWith("/api/")) {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><html><body>OpenCode</body></html>");
    return;
  }
  if (request.headers.authorization !== expected) return json(response, 401, { _tag: "UnauthorizedError", message: "Authentication required" });
  if (path === "/api/info") {
    if (process.env.FAKE_INFO_GARBAGE) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("this is not json");
      return;
    }
    return json(response, 200, { version, pid: process.pid, urls: [], paths: { tmp: "/tmp" }, capabilities: {} });
  }
  // What the process was given, for tests.
  if (path === "/api/fake/env") {
    return json(response, 200, {
      config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}"),
      args,
      cwd: process.cwd(),
      password: process.env.OPENCODE_PASSWORD ?? null,
      serverPassword: process.env.OPENCODE_SERVER_PASSWORD ?? null,
      username: process.env.OPENCODE_SERVER_USERNAME ?? null,
    });
  }
  json(response, 404, { _tag: "NotFound", message: `no route ${request.method} ${path}` });
});
server.listen(0, "127.0.0.1", () => {
  process.stderr.write(`pid ${process.pid}\n`);
  process.stdout.write(`server listening on http://127.0.0.1:${server.address().port}\n`);
});
process.on("SIGTERM", () => { if (!process.env.FAKE_IGNORE_TERM) process.exit(0); });
