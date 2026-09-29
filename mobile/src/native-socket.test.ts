import { describe, expect, it } from "vitest";
import { NativeSocket, OPEN_SOCKETS_KEY, trackedBridge, type NativeSocketEvent, type NativeSocketRequest, type SocketBridge } from "./native-socket";

function fakeBridge(options: { refuseOpen?: boolean; forgetOnClose?: boolean } = {}) {
  const listeners = new Map<string, (event: NativeSocketEvent) => void>();
  const opened: NativeSocketRequest[] = [];
  const sent: Array<[string, string]> = [];
  const closed: string[] = [];
  const bridge: SocketBridge = {
    open: async (request) => { opened.push(request); if (options.refuseOpen) throw new Error("no such host"); },
    send: async (id, data) => { sent.push([id, data]); },
    close: async (id) => { closed.push(id); if (options.forgetOnClose) throw new Error("unknown socket"); },
    subscribe: (id, listener) => { listeners.set(id, listener); return () => listeners.delete(id); },
  };
  type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
  const emit = (event: WithoutId<NativeSocketEvent>) => { const [id, listener] = [...listeners.entries()][0]!; listener({ ...event, id } as NativeSocketEvent); };
  return { bridge, opened, sent, closed, listeners, emit };
}

describe("NativeSocket", () => {
  it("opens through the plugin with the pin and reports what the host presented", () => {
    const fake = fakeBridge();
    const socket = new NativeSocket(fake.bridge, "wss://host:7788/", { publicKey: "EF:01", fingerprint: "AB:CD", headers: { "User-Agent": "phone" } });
    expect(fake.opened[0]).toMatchObject({ url: "wss://host:7788/", publicKey: "EF:01", fingerprint: "AB:CD", headers: { "User-Agent": "phone" } });
    const seen: string[] = [];
    socket.addEventListener("open", () => seen.push("open"));
    socket.onmessage = (event) => seen.push(`message ${String(event.data)}`);
    fake.emit({ type: "open", fingerprint: "AB:CD", publicKey: "EF:01" });
    fake.emit({ type: "message", data: "frame" });
    expect(socket.readyState).toBe(NativeSocket.OPEN);
    expect(socket.fingerprint).toBe("AB:CD");
    expect(socket.publicKey).toBe("EF:01");
    socket.send("hello");
    expect(fake.sent).toEqual([[fake.opened[0]!.id, "hello"]]);
    expect(seen).toEqual(["open", "message frame"]);
  });

  it("refuses to send before it is open, as a browser socket does", () => {
    const socket = new NativeSocket(fakeBridge().bridge, "wss://host/");
    expect(() => socket.send("early")).toThrow(/not open/u);
  });

  it("reports a failed connect as an error and a close, with the pin mismatch", () => {
    const fake = fakeBridge();
    const socket = new NativeSocket(fake.bridge, "wss://host/");
    const seen: string[] = [];
    socket.addEventListener("error", () => seen.push("error"));
    socket.addEventListener("close", (event) => seen.push(`close ${event.code}`));
    fake.emit({ type: "close", code: 1006, pinMismatch: true });
    expect(seen).toEqual(["error", "close 1006"]);
    expect(socket.pinMismatch).toBe(true);
    expect(socket.untrustedCertificate).toBe(false);
    // Unsubscribed: nothing more arrives for a closed socket.
    expect(fake.listeners.size).toBe(0);
  });

  it("reports a certificate the platform did not trust when nothing was pinned", () => {
    const fake = fakeBridge();
    const socket = new NativeSocket(fake.bridge, "wss://mac.tail0000.ts.net/");
    fake.emit({ type: "close", code: 1006, untrusted: true });
    expect(socket.untrustedCertificate).toBe(true);
    expect(socket.pinMismatch).toBe(false);
  });

  it("carries the host's close code, so a refused token stays final", () => {
    const fake = fakeBridge();
    const socket = new NativeSocket(fake.bridge, "wss://host/");
    let closed: { code?: number; reason?: string } | undefined;
    socket.onclose = (event) => { closed = event; };
    fake.emit({ type: "open" });
    fake.emit({ type: "close", code: 4401, reason: "revoked" });
    expect(closed).toEqual({ code: 4401, reason: "revoked" });
  });

  it("closes by itself when the plugin cannot open or no longer knows the socket", async () => {
    const refused = new NativeSocket(fakeBridge({ refuseOpen: true }).bridge, "wss://nowhere/");
    await Promise.resolve();
    await Promise.resolve();
    expect(refused.readyState).toBe(NativeSocket.CLOSED);

    const fake = fakeBridge({ forgetOnClose: true });
    const forgotten = new NativeSocket(fake.bridge, "wss://host/");
    fake.emit({ type: "open" });
    forgotten.close(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(forgotten.readyState).toBe(NativeSocket.CLOSED);
  });
});

describe("trackedBridge", () => {
  const memory = () => {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  };

  it("closes on the next page the sockets the last one left open, and all of its own when the page goes", async () => {
    const store = memory();
    const first = fakeBridge();
    const tracked = trackedBridge(first.bridge, store);
    const a = new NativeSocket(tracked, "wss://mac.test/");
    const b = new NativeSocket(tracked, "wss://rex.test/");
    await Promise.resolve();
    const [idA, idB] = first.opened.map((request) => request.id);
    // One closed by itself; the other is still open when the page reloads without a word.
    first.listeners.get(idA!)!({ id: idA!, type: "close", code: 1000 });
    expect(JSON.parse(store.getItem(OPEN_SOCKETS_KEY)!)).toEqual([idB]);
    const next = fakeBridge();
    const again = trackedBridge(next.bridge, store);
    expect(next.closed).toEqual([idB]);
    expect(JSON.parse(store.getItem(OPEN_SOCKETS_KEY)!)).toEqual([]);
    const c = new NativeSocket(again, "wss://mac.test/");
    await Promise.resolve();
    again.closeAll();
    expect(next.closed).toEqual([idB, next.opened[0]!.id]);
    void a; void b; void c;
  });
});
