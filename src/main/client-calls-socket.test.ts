import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { HOST_TRANSPORT_VERSION, decodeHostServerFrame, type HostHello, type HostServerFrame } from "../shared/host-transport.js";
import { ClientCalls } from "./client-calls.js";
import { HostJobRunner } from "./host-jobs.js";
import { createHostMethods, type HostMethodTable } from "./host-methods.js";
import { runAsCaller } from "./host-invocation.js";
import { HostPushLog } from "./host-push-log.js";
import { startSocketHostTransport, type SocketHostTransport } from "./host-transport-socket.js";

const TOKEN = "b".repeat(64);

let transport: SocketHostTransport | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await transport?.close();
  transport = undefined;
});

/** The headless host's wiring: `client-call-result` from the real table, and one method that opens the folder picker. */
async function host(): Promise<{ port: number; calls: ClientCalls }> {
  const calls = new ClientCalls((connection, call) => transport?.sendCall(connection, call) ?? false, 10_000);
  const unsupported = () => { throw new Error("not in this test"); };
  const table = createHostMethods({
    clientCalls: calls,
    bootstrap: unsupported, requireHost: unsupported, host: () => undefined,
    jobs: new HostJobRunner(() => undefined),
    platform: {
      copyText: unsupported, copyImage: unsupported, readImagePreview: unsupported,
      inspectExtensions: unsupported, loadDesktopExtensions: unsupported, rebuildWorkbench: unsupported,
      workbenchSource: unsupported, relaunchWorkbench: unsupported, installUpdate: unsupported,
      notify: unsupported, setBadge: unsupported,
    },
  });
  const methods: HostMethodTable = {
    "client-call-result": table["client-call-result"]!,
    // What a kit command does when the host runs it for a client (`HostExtensionRegistry.invoke`).
    "pick": (_params, context) => runAsCaller(context.principal, () => calls.pickDirectory()),
  };
  transport = await startSocketHostTransport({
    listen: "127.0.0.1:0", methods, pushLog: new HostPushLog(), hostVersion: "test", capabilities: [], token: TOKEN, calls,
  });
  return { port: transport.port, calls };
}

interface Peer {
  frames: HostServerFrame[];
  request(method: string, params?: unknown[]): Promise<unknown>;
}

async function peer(port: number, hello: Omit<HostHello, "protocol" | "token">): Promise<Peer> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
  const frames: HostServerFrame[] = [];
  const waiting = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  socket.on("message", (data) => {
    const frame = decodeHostServerFrame(JSON.parse(String(data)) as unknown);
    if (!frame) return;
    frames.push(frame);
    if (frame.type !== "response" && frame.type !== "hello-reply") return;
    const id = frame.type === "response" ? frame.response.id : frame.id;
    const waiter = waiting.get(id);
    if (!waiter) return;
    waiting.delete(id);
    if (frame.type === "hello-reply") waiter.resolve(frame.reply);
    else if (frame.response.error) waiter.reject(new Error(frame.response.error.message));
    else waiter.resolve(frame.response.result);
  });
  let counter = 0;
  const send = (frame: object, id: string) => new Promise<unknown>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify(frame));
  });
  await send({ type: "hello", id: "h", hello: { ...hello, protocol: HOST_TRANSPORT_VERSION, token: TOKEN } }, "h");
  return {
    frames,
    request: (method, params = []) => {
      const id = `r${++counter}`;
      return send({ type: "request", request: { id, method, params } }, id);
    },
  };
}

const callsIn = (target: Peer) => target.frames.flatMap((frame) => (frame.type === "client-call" ? [frame.call] : []));

describe("calls into a window over the socket", () => {
  it("reach the caller's window alone, and only its answer counts", async () => {
    const { port } = await host();
    const window = await peer(port, { auxiliary: true, windowId: "w1", windowHalves: ["window"] });
    const page = await peer(port, { windowId: "w1", profile: "desktop" });
    const forger = await peer(port, { auxiliary: true, windowHalves: ["window"] });
    const browser = await peer(port, { profile: "web" });

    const picked = page.request("pick");
    await vi.waitFor(() => expect(callsIn(window)).toHaveLength(1));
    const [call] = callsIn(window);
    expect(call).toMatchObject({ extensionId: "window", command: "pick-directory" });
    expect(callsIn(forger)).toEqual([]);
    expect(callsIn(page)).toEqual([]);
    expect(callsIn(browser)).toEqual([]);

    // Suppose the id leaked: an answer from another connection changes nothing.
    await forger.request("client-call-result", [call!.callId, "/forged"]);
    await browser.request("client-call-result", [call!.callId, "/forged"]);
    await window.request("client-call-result", [call!.callId, "/chosen"]);
    await expect(picked).resolves.toBe("/chosen");
  });

  it("fails at once for a client without a window, and when the window is gone", async () => {
    const { port, calls } = await host();
    const browser = await peer(port, { profile: "web" });
    await expect(browser.request("pick")).rejects.toThrow(/no window that can answer/u);

    const window = await peer(port, { auxiliary: true, windowId: "w1", windowHalves: ["window"] });
    const page = await peer(port, { windowId: "w1" });
    const picked = page.request("pick");
    await vi.waitFor(() => expect(callsIn(window)).toHaveLength(1));
    // The window's own socket: opened before the page's.
    sockets.at(-2)!.close();
    await expect(picked).rejects.toThrow(/disconnected/u);
    await expect(page.request("pick")).rejects.toThrow(/no window that can answer/u);
    await expect(calls.call("tau.preview", "open-view")).rejects.toThrow(/No Tau window/u);
  });

  it("does not let a page claim window halves", async () => {
    const { port, calls } = await host();
    const page = await peer(port, { windowHalves: ["tau.preview"] });
    await expect(calls.call("tau.preview", "open-view")).rejects.toThrow(/No Tau window/u);
    expect(callsIn(page)).toEqual([]);
  });
});
