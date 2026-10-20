// Throwaway, loopback-only server for the project-groups design study.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const html = "kits/workspace/project-groups-refined.prototype.html";
const original = "kits/workspace/project-groups.prototype.html";
const port = Number(process.env.TAU_PROTOTYPE_PORT ?? 4179);
createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const relative = path === "/" ? html : path.slice(1);
  if (relative !== html && relative !== original && relative !== "src/renderer/tokens.css" && !/^src\/renderer\/assets\/fonts\/figtree\/[a-z-]+\.woff2$/.test(relative)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(fileURLToPath(new URL(relative, root)));
    response.writeHead(200, { "content-type": relative.endsWith(".css") ? "text/css" : relative.endsWith(".woff2") ? "font/woff2" : "text/html; charset=utf-8" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Project groups prototype: http://127.0.0.1:${port}/?state=normal`);
});
