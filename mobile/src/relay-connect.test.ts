import { afterEach, describe, expect, it, vi } from "vitest";
import { pairingUrl } from "../../src/shared/connections";
import { encodeConnectOffer } from "../../src/shared/managed-connections";
import { connectHost, openCandidate } from "./connect";
import { HostBook, type SavedHost } from "./hosts";
import { OPEN_SOCKETS_KEY, trackedBridge, type NativeSocketEvent, type NativeSocketRequest, type SocketBridge } from "./native-socket";
import { pairDevice } from "./pairing";
import { connectCandidate, parseMobilePairingPayload, type MobileConnect } from "./relay-connect";
import { linkRoute, routeSearch } from "./routes";

const KEY = "EF:".repeat(31) + "EF";
const FP = "AB:".repeat(31) + "AB";
const ROUTE = "5ac82912-9b31-4c2f-8b94-3cb0bdc8a991";
const TOKEN = "r".repeat(43);
const connect: MobileConnect = { relay: "https://relay.example", id: ROUTE, token: TOKEN, url: "wss://127.0.0.1:7788/tau/socket?ticket=host-ticket" };
const host: SavedHost = { id: "host-1", name: "Studio", publicKey: KEY, endpoints: [{ url: "https://127.0.0.1:7788/tau/socket?ticket=host-ticket" }], access: "full", addedAt: "2026-09-30T12:00:00Z", connect: true };
const offer = (link = pairingUrl("https://127.0.0.1:7788/tau/socket?ticket=host-ticket", { code: "pair-code", publicKey: KEY, hostId: host.id })) => encodeConnectOffer({ version: 1, relay: connect.relay, id: ROUTE, token: TOKEN, link });

function memoryStore() {
  const data = new Map<string, string>();
  return { data, get: async (key: string) => data.get(key), set: async (key: string, value: string) => { data.set(key, value); }, remove: async (key: string) => { data.delete(key); } };
}

function socketBridge() {
  const listeners = new Map<string, (event: NativeSocketEvent) => void>();
  const requests: NativeSocketRequest[] = [];
  const sends: string[] = [];
  const closes: string[] = [];
  const bridge: SocketBridge = {
    open: async (request) => { requests.push(request); },
    send: async (_id, data) => { sends.push(data); },
    close: async (id) => { closes.push(id); listeners.get(id)?.({ id, type: "close", code: 1000 }); },
    subscribe: (id, listener) => { listeners.set(id, listener); return () => { listeners.delete(id); }; },
  };
  return { bridge, requests, sends, closes, listeners, emit: (event: NativeSocketEvent) => listeners.get(event.id)?.(event) };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("phone Connect links", () => {
  it("retains the inner path and query, separates the relay token and pairing code, and retains the host pin", () => {
    const payload = parseMobilePairingPayload(offer());
    expect(payload).toMatchObject({ code: "pair-code", publicKey: KEY, hostId: host.id, connect });
    expect(payload?.endpoints[0]?.url).not.toContain(TOKEN);
    expect(payload?.connect?.url).not.toContain("pair-code");
    expect(parseMobilePairingPayload("  " + offer() + "  ")).toEqual(payload);
  });

  it("refuses missing host pins, insecure hosts and relay credentials embedded in URLs", () => {
    expect(parseMobilePairingPayload(offer("https://127.0.0.1:7788/#pair=code"))).toBeUndefined();
    expect(parseMobilePairingPayload(offer(pairingUrl("http://127.0.0.1:7788/", { code: "code", publicKey: KEY })))).toBeUndefined();
    expect(parseMobilePairingPayload(offer(pairingUrl("https://user:password@host.example/", { code: "code", publicKey: KEY })))).toBeUndefined();
    expect(parseMobilePairingPayload(encodeConnectOffer({ version: 1, relay: "https://relay.example?token=secret", id: ROUTE, token: TOKEN, link: "https://host.example/#pair=code" }))).toBeUndefined();
    expect(parseMobilePairingPayload("tau-connect:%broken")).toBeUndefined();
  });

  it("requires strict host pins through the relay, including legacy certificate pins", () => {
    expect(connectCandidate(connect, {})).toBeUndefined();
    expect(connectCandidate(connect, { fingerprint: FP })).toMatchObject({ fingerprint: FP, trust: "pin", allowAuthority: false });
    const candidate = connectCandidate(connect, { publicKey: KEY, fingerprint: FP })!;
    expect(candidate.fingerprint).toBeUndefined();
    expect(candidate).toMatchObject({ url: connect.url, publicKey: KEY, connect: { url: `wss://relay.example/v1/client/${ROUTE}`, token: TOKEN } });
    const fixture = socketBridge();
    openCandidate({ bridge: fixture.bridge }, candidate);
    expect(fixture.requests[0]).toMatchObject({ publicKey: KEY, url: connect.url, connect: candidate.connect });
    expect(fixture.requests[0]?.allowAuthority).toBeUndefined();
    expect(fixture.requests[0]?.headers?.Authorization).toBeUndefined();
  });

  it("opens a native deep link in Add host without putting credentials in the page route", () => {
    expect(linkRoute(offer())).toEqual({ view: "add", text: offer() });
    expect(routeSearch(linkRoute(offer())!)).toBe("?view=add");
  });
});

describe("saved relay credentials", () => {
  it("keeps host metadata, host access and relay access in separate secure records, and removes all three", async () => {
    const store = memoryStore();
    const book = new HostBook(store);
    await book.save(host, "host-client-token", connect);
    expect(await book.connect(host.id)).toEqual(connect);
    expect(await book.token(host.id)).toBe("host-client-token");
    expect(store.data.get("hosts.v1")).not.toContain(TOKEN);
    expect(store.data.get("hosts.v1")).not.toContain("host-client-token");
    await book.update(host.id, { name: "Studio renamed" });
    expect(await book.connect(host.id)).toEqual(connect);
    await book.remove(host.id);
    expect(await book.connect(host.id)).toBeUndefined();
    expect(await book.token(host.id)).toBeUndefined();
    expect(await book.get(host.id)).toBeUndefined();
  });

  it("forgets a transport when the device pairs again directly and consumes staged links once", async () => {
    const book = new HostBook(memoryStore());
    await book.save(host, "host-client-token", connect);
    await book.save({ ...host, connect: undefined }, "new-client-token");
    expect(await book.connect(host.id)).toBeUndefined();
    await book.stageConnectLink(offer());
    expect(await book.takeConnectLink()).toBe(offer());
    expect(await book.takeConnectLink()).toBeUndefined();
  });
});

describe("relay connection lifecycle", () => {
  it.each([0, 0.5, 0.999])("reopens with the relay credential, keeps hello tokens separate and stops when revoked, with jitter sample %s", async (sample) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(sample);
    const fixture = socketBridge();
    const revoked: string[] = [];
    const { connection } = connectHost(() => host, "paired-phone-token", { bridge: fixture.bridge, device: { platform: "ios", virtual: false }, connect }, {
      onUnauthorized: (reason) => revoked.push(reason), onCertificateRefused: () => undefined,
    });
    void connection.start("compact").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    const first = fixture.requests[0]!;
    fixture.emit({ id: first.id, type: "open", publicKey: KEY });
    fixture.emit({ id: first.id, type: "close", code: 1006 });
    await vi.advanceTimersByTimeAsync(300);
    const second = fixture.requests[1]!;
    expect(second.id).not.toBe(first.id);
    expect([first, second].map((request) => request.connect)).toEqual([connectCandidate(connect, host)!.connect, connectCandidate(connect, host)!.connect]);
    fixture.emit({ id: second.id, type: "open", publicKey: KEY });
    fixture.emit({ id: second.id, type: "close", code: 4401, reason: "revoked" });
    expect(fixture.sends).toHaveLength(2);
    expect(fixture.sends.every((frame) => frame.includes("paired-phone-token") && !frame.includes(TOKEN))).toBe(true);
    expect(revoked).toEqual(["revoked"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.requests).toHaveLength(2);
    connection.close();
  });

  it("sends no hello when the inner TLS pin is refused", async () => {
    const fixture = socketBridge();
    const refusals: unknown[] = [];
    const { connection } = connectHost(() => host, "paired-phone-token", { bridge: fixture.bridge, device: { platform: "android", virtual: false }, connect }, {
      onUnauthorized: () => undefined, onCertificateRefused: (refusal) => refusals.push(refusal),
    });
    void connection.start("compact").catch(() => undefined);
    const request = fixture.requests[0]!;
    fixture.emit({ id: request.id, type: "close", code: 1006, pinMismatch: true });
    expect(fixture.sends).toEqual([]);
    expect(refusals).toEqual([{ reason: "certificate-mismatch", addresses: ["127.0.0.1:7788"] }]);
    connection.close();
  });

  it("closes a pending relay probe when pairing is cancelled and clears the page's tracking record", async () => {
    const fixture = socketBridge();
    let record: string | null = null;
    const bridge = trackedBridge(fixture.bridge, { getItem: () => record, setItem: (key, value) => { expect(key).toBe(OPEN_SOCKETS_KEY); record = value; } });
    const signal = new AbortController();
    const pairing = pairDevice({ hostId: host.id, name: host.name, publicKey: KEY, endpoints: host.endpoints, connect }, {
      device: { platform: "ios", virtual: false, name: "Phone" }, openSocket: (candidate) => openCandidate({ bridge }, candidate),
    }, { signal: signal.signal });
    expect(fixture.requests).toHaveLength(1);
    signal.abort();
    expect(await pairing).toEqual({ state: "failed", message: "Pairing was cancelled." });
    expect(fixture.closes).toEqual([fixture.requests[0]!.id]);
    expect(fixture.listeners.size).toBe(0);
    expect(record).toBe("[]");
  });

  it("closes current and previous-page native relay sockets on a host switch", () => {
    const fixture = socketBridge();
    let record = '["previous-page"]';
    const bridge = trackedBridge(fixture.bridge, { getItem: () => record, setItem: (_key, value) => { record = value; } });
    const socket = openCandidate({ bridge }, connectCandidate(connect, host)!);
    bridge.closeAll();
    expect(fixture.closes).toEqual(["previous-page", fixture.requests[0]!.id]);
    expect(socket.readyState).toBe(3);
    expect(record).toBe("[]");
  });
});
