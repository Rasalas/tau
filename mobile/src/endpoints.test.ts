import { describe, expect, it } from "vitest";
import { RacingSocket, socketCandidates, type AttemptSocket, type RaceTimers, type SocketCandidate } from "./endpoints";

const FP = "AB:".repeat(31) + "AB";
const KEY = "EF:".repeat(31) + "EF";
const PHONE = { platform: "ios" as const, virtual: false };

describe("socketCandidates", () => {
  it("prefers the local network, then Tailscale, and pins every TLS address (an old certificate pin)", () => {
    const candidates = socketCandidates([
      { url: "https://mac.tail5e6f7a.ts.net:7788/", kind: "magicdns" },
      { url: "https://100.96.0.12:7788/", kind: "tailscale" },
      { url: "https://[fd00::5]:7788/", kind: "lan" },
      { url: "https://Mac-mini.local:7788/", kind: "mdns" },
      { url: "https://192.168.1.47:7788/", kind: "lan" },
    ], { fingerprint: FP }, PHONE);
    expect(candidates.map((candidate) => candidate.url)).toEqual([
      "wss://192.168.1.47:7788/",
      "wss://mac-mini.local:7788/",
      "wss://[fd00::5]:7788/",
      "wss://100.96.0.12:7788/",
      "wss://mac.tail5e6f7a.ts.net:7788/",
    ]);
    expect(candidates.every((candidate) => candidate.fingerprint === FP)).toBe(true);
    // Only a name a public CA can vouch for may pass on a trusted certificate instead of the pin.
    expect(candidates.filter((candidate) => candidate.allowAuthority).map((candidate) => candidate.kind)).toEqual(["magicdns"]);
  });

  it("pins the key strictly, and checks a CA-vouched address by chain and name without the pin", () => {
    const candidates = socketCandidates([
      { url: "https://192.168.1.47:7788/", kind: "lan" },
      { url: "https://mac.tail5e6f7a.ts.net:7788/", kind: "magicdns" },
      { url: "https://mac.tail5e6f7a.ts.net/", kind: "magicdns", trustedCertificate: true },
      // A flag on an address or a .local name is not honoured: those are pinned.
      { url: "https://100.96.0.12:7788/", kind: "tailscale", trustedCertificate: true },
      { url: "https://mac.local:7788/", kind: "mdns", trustedCertificate: true },
    ], { publicKey: KEY, fingerprint: FP }, PHONE);
    const byUrl = Object.fromEntries(candidates.map((candidate) => [candidate.url, candidate]));
    expect(byUrl["wss://192.168.1.47:7788/"]).toMatchObject({ trust: "pin", publicKey: KEY, allowAuthority: false });
    expect(byUrl["wss://192.168.1.47:7788/"]!.fingerprint).toBeUndefined();
    // The direct Tailscale bind under its MagicDNS name is self-signed: pinned, no CA fallback.
    expect(byUrl["wss://mac.tail5e6f7a.ts.net:7788/"]).toMatchObject({ trust: "pin", publicKey: KEY, allowAuthority: false });
    expect(byUrl["wss://mac.tail5e6f7a.ts.net/"]).toMatchObject({ trust: "authority", proxied: true, allowAuthority: false });
    expect(byUrl["wss://mac.tail5e6f7a.ts.net/"]!.publicKey).toBeUndefined();
    expect(byUrl["wss://100.96.0.12:7788/"]).toMatchObject({ trust: "pin", publicKey: KEY });
    expect(byUrl["wss://mac.local:7788/"]).toMatchObject({ trust: "pin", publicKey: KEY });
  });

  it("never offers plaintext beyond loopback, and loopback only in a simulator", () => {
    const endpoints = [{ url: "http://192.168.1.47:7788/", kind: "lan" as const }, { url: "http://127.0.0.1:60303/", kind: "loopback" as const }];
    expect(socketCandidates(endpoints, {}, PHONE)).toEqual([]);
    expect(socketCandidates(endpoints, {}, { platform: "ios", virtual: true }).map((candidate) => [candidate.url, candidate.trust])).toEqual([["ws://127.0.0.1:60303/", "plain"]]);
  });

  it("reaches the development machine from the Android emulator by its alias", () => {
    const [candidate] = socketCandidates([{ url: "http://127.0.0.1:60303/" }], {}, { platform: "android", virtual: true });
    expect(candidate).toMatchObject({ url: "ws://10.0.2.2:60303/", kind: "loopback" });
  });

  it("skips what is not an address and lists one address once", () => {
    const candidates = socketCandidates([{ url: "not a url" }, { url: "ftp://host/" }, { url: "https://host.example:1/" }, { url: "https://host.example:1/" }], {}, PHONE);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ url: "wss://host.example:1/", trust: "authority", allowAuthority: false });
    expect(candidates[0]!.fingerprint).toBeUndefined();
  });
});

/** An attempt that opens or fails exactly when the test says. */
class FakeAttempt implements AttemptSocket {
  readyState = 0;
  fingerprint: string | undefined;
  pinMismatch = false;
  closed = false;
  readonly sent: string[] = [];
  private readonly listeners: Record<string, Array<(event: never) => void>> = {};
  constructor(readonly candidate: SocketCandidate) {}
  addEventListener(type: string, listener: (event: never) => void): void { (this.listeners[type] ??= []).push(listener); }
  send(data: string): void { this.sent.push(data); }
  close(): void { if (this.closed) return; this.closed = true; this.fire("close", { code: 1000 }); }
  open(fingerprint?: string): void { this.readyState = 1; this.fingerprint = fingerprint; this.fire("open", {}); }
  fail(pinMismatch = false): void { this.pinMismatch = pinMismatch; this.readyState = 3; this.fire("close", { code: 1006 }); }
  message(data: string): void { this.fire("message", { data }); }
  private fire(type: string, event: object): void { for (const listener of this.listeners[type] ?? []) (listener as (event: object) => void)(event); }
}

/** Timers the test fires by hand. */
function manualTimers(): RaceTimers & { fire(): void } {
  let pending: (() => void) | undefined;
  return {
    setTimeout: (callback) => { pending = callback; return 1; },
    clearTimeout: () => { pending = undefined; },
    fire: () => { const callback = pending; pending = undefined; callback?.(); },
  };
}

function race(urls: string[]) {
  const attempts: FakeAttempt[] = [];
  const timers = manualTimers();
  const candidates = urls.map((url, rank) => ({ url, rank, trust: "pin" as const, allowAuthority: false }));
  const socket = new RacingSocket(candidates, (candidate) => { const attempt = new FakeAttempt(candidate); attempts.push(attempt); return attempt; }, { timers });
  const events: string[] = [];
  socket.onopen = () => events.push(`open ${socket.winner?.url}`);
  socket.onclose = (event) => events.push(`close ${event?.code} ${event?.reason ?? ""}`.trim());
  socket.onmessage = (event) => events.push(`message ${String(event.data)}`);
  return { socket, attempts, timers, events };
}

describe("RacingSocket", () => {
  it("hands every frame of the chosen socket to onMessage before its own handler", () => {
    const attempts: FakeAttempt[] = [];
    const seen: unknown[] = [];
    const socket = new RacingSocket([{ url: "wss://lan/", rank: 0, trust: "pin", allowAuthority: false }], (candidate) => { const attempt = new FakeAttempt(candidate); attempts.push(attempt); return attempt; }, {
      timers: manualTimers(),
      onMessage: (data) => seen.push(`hook ${String(data)}`),
    });
    socket.onmessage = (event) => seen.push(`socket ${String(event.data)}`);
    attempts[0]!.open();
    attempts[0]!.message("{\"type\":\"hello-reply\"}");
    expect(seen).toEqual(["hook {\"type\":\"hello-reply\"}", "socket {\"type\":\"hello-reply\"}"]);
  });

  it("takes the best address at once when it opens first, and closes the rest", () => {
    const { attempts, events } = race(["wss://lan/", "wss://tailscale/"]);
    attempts[0]!.open();
    expect(events).toEqual(["open wss://lan/"]);
    expect(attempts[1]!.closed).toBe(true);
  });

  it("gives a better address the grace to answer before a worse one wins", () => {
    const { attempts, timers, events } = race(["wss://lan/", "wss://tailscale/"]);
    attempts[1]!.open();
    expect(events).toEqual([]);
    attempts[0]!.open();
    expect(events).toEqual(["open wss://lan/"]);
    timers.fire();
    expect(events).toEqual(["open wss://lan/"]);
  });

  it("takes the worse address once the grace runs out, or as soon as the better one fails", () => {
    const waited = race(["wss://lan/", "wss://tailscale/"]);
    waited.attempts[1]!.open();
    waited.timers.fire();
    expect(waited.events).toEqual(["open wss://tailscale/"]);
    expect(waited.attempts[0]!.closed).toBe(true);

    const failed = race(["wss://lan/", "wss://tailscale/"]);
    failed.attempts[1]!.open();
    failed.attempts[0]!.fail();
    expect(failed.events).toEqual(["open wss://tailscale/"]);
  });

  it("carries the winner's frames and its close, and sends through it", () => {
    const { socket, attempts, events } = race(["wss://lan/"]);
    attempts[0]!.open("AB:CD");
    expect(socket.fingerprint).toBe("AB:CD");
    socket.send("hello");
    attempts[0]!.message("reply");
    attempts[0]!.fail();
    expect(attempts[0]!.sent).toEqual(["hello"]);
    expect(events).toEqual(["open wss://lan/", "message reply", "close 1006"]);
    expect(socket.readyState).toBe(3);
  });

  it("fails when nothing answers, and says when every address showed another certificate", () => {
    const unreachable = race(["wss://a/", "wss://b/"]);
    unreachable.attempts[0]!.fail(true);
    unreachable.attempts[1]!.fail();
    expect(unreachable.events).toEqual(["close 1006 unreachable"]);

    const mismatch = race(["wss://a/", "wss://b/"]);
    mismatch.attempts[0]!.fail(true);
    mismatch.attempts[1]!.fail(true);
    expect(mismatch.socket.pinMismatch).toBe(true);
    expect(mismatch.events).toEqual(["close 1006 certificate-mismatch"]);
  });

  it("closes every attempt when closed before one won", () => {
    const { socket, attempts, events } = race(["wss://a/", "wss://b/"]);
    socket.close();
    expect(attempts.every((attempt) => attempt.closed)).toBe(true);
    expect(events).toEqual(["close 1000"]);
  });

  it("reports a race with nothing to try as a failure", async () => {
    const { events } = race([]);
    await Promise.resolve();
    expect(events).toEqual(["close 1006 unreachable"]);
  });
});
