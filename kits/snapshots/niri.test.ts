import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { checkNiri, niriRequest, niriWindow, takeNiri } from "./niri.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const window = { id: 42, title: "Doc", app_id: "editor", pid: 12, layout: { window_size: [800, 600] } };
async function compositor(respond: (request: unknown, socket: Socket) => void) {
  const directory = await mkdtemp(join(tmpdir(), "tau-niri-wire-"));
  const path = join(directory, "ipc.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) { const line = pending.slice(0, end); pending = pending.slice(end + 1); respond(JSON.parse(line), socket); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  return path;
}
const send = (socket: Socket, value: unknown) => socket.write(`${JSON.stringify(value)}\n`);

it("checks the minimum API version without starting a screenshot", async () => {
  for (const version of ["25.11", "niri 26.4.0", "26.4.0 (revision)"]) {
    const request = vi.fn(async () => ({ Version: version }));
    await checkNiri("/tmp/niri.sock", request);
    expect(request).toHaveBeenCalledExactlyOnceWith("/tmp/niri.sock", "Version");
  }
  for (const version of ["25.10", "24.12", "garbage"]) await expect(checkNiri("/tmp/niri.sock", async () => ({ Version: version }))).rejects.toThrow(/25.11/u);
  expect(() => niriWindow({ ...window, id: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/metadata/u);
});

it("subscribes before capture and waits for the matching completion event", async () => {
  let events: Socket | undefined;
  let subscribed = false;
  const requests: unknown[] = [];
  const output = "/private/temporary/capture.png";
  const path = await compositor((request, socket) => {
    requests.push(request);
    if (request === "EventStream") { events = socket; send(socket, { Ok: "Handled" }); send(socket, { WindowsChanged: { windows: [window] } }); subscribed = true; }
    else if (request === "FocusedWindow") { expect(subscribed).toBe(true); send(socket, { Ok: { FocusedWindow: window } }); }
    else if (request === "Windows") send(socket, { Ok: { Windows: [window] } });
    else {
      expect(request).toEqual({ Action: { ScreenshotWindow: { id: 42, path: output, write_to_disk: true, show_pointer: false } } });
      send(socket, { Ok: "Handled" });
      send(events!, { ScreenshotCaptured: { path: "/unrelated/capture.png" } });
      send(events!, { ScreenshotCaptured: { path: output } });
    }
  });
  expect(await takeNiri(path, output)).toEqual(window);
  expect(requests[0]).toBe("EventStream");
});

it("drops window identity when the window changes or closes during capture", async () => {
  let events: Socket | undefined;
  const output = "/tmp/capture.png";
  const path = await compositor((request, socket) => {
    if (request === "EventStream") { events = socket; send(socket, { WindowsChanged: { windows: [window] } }); }
    else if (request === "FocusedWindow") send(socket, { Ok: { FocusedWindow: window } });
    else if (request === "Windows") send(socket, { Ok: { Windows: [{ ...window, pid: 13 }] } });
    else { send(socket, { Ok: "Handled" }); send(events!, { ScreenshotCaptured: { path: output } }); }
  });
  expect(await takeNiri(path, output)).toBeUndefined();
});

it("propagates compositor denial, disconnects and malformed/oversized replies", async () => {
  const denied = await compositor((_request, socket) => send(socket, { Err: "permission denied" }));
  await expect(niriRequest(denied, "Version")).rejects.toThrow(/permission denied/u);
  const disconnected = await compositor((_request, socket) => socket.destroy());
  await expect(niriRequest(disconnected, "Version")).rejects.toThrow(/disconnected/u);
  const malformed = await compositor((_request, socket) => socket.write("not-json\n"));
  await expect(niriRequest(malformed, "Version")).rejects.toThrow(/invalid/u);
  const oversized = await compositor((_request, socket) => socket.write("x".repeat(4 * 1024 * 1024 + 1)));
  await expect(niriRequest(oversized, "Version")).rejects.toThrow(/oversized/u);
});

it("fails capture without switching to a different window or reading unrelated screenshot paths", async () => {
  const path = await compositor((request, socket) => {
    if (request === "EventStream") send(socket, { WindowsChanged: { windows: [] } });
    else if (request === "FocusedWindow") send(socket, { Ok: { FocusedWindow: null } });
    else throw new Error("Unexpected capture action");
  });
  await expect(takeNiri(path, "/tmp/capture.png")).rejects.toThrow(/no focused/u);
});
