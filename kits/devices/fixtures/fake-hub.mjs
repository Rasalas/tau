// A loopback-only fixture. It never invokes platform tooling.
import { createServer } from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const devices = [
  { id: "ios-phone", platform: "ios", name: "iPhone test", version: "18.0", booted: true },
  { id: "android-phone", platform: "android", name: "Pixel test", version: "35", booted: true },
];
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  const json = (value) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); };
  if (path === "/api/devices") return json({ simulators: devices.filter((device) => device.platform === "ios"), emulators: devices.filter((device) => device.platform === "android") });
  if (path.endsWith("/api/screenshot")) { response.setHeader("Content-Type", "image/png"); response.end(png); return; }
  let text = ""; for await (const chunk of request) text += chunk;
  const body = text ? JSON.parse(text) : {};
  if (path === "/api/devices/boot" || path === "/api/devices/shutdown" || path.endsWith("/grid/api/shutdown")) {
    const device = devices.find((entry) => entry.id === (body.id ?? body.udid));
    if (!device) return json({ ok: false, error: "unknown device" });
    device.booted = path.endsWith("/boot"); return json({ ok: true });
  }
  if (path.endsWith("/grid/api/start")) return json({ ok: true });
  if (path.endsWith("/api/fold")) return json({ ok: body.posture === "closed" || body.posture === "opened", fold: { posture: body.posture } });
  response.statusCode = 404; json({ ok: false, error: "unknown fixture route" });
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
