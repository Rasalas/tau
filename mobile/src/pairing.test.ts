import { describe, expect, it } from "vitest";
import { pairingVerificationCode } from "../../src/shared/pairing";
import type { SocketCandidate } from "./endpoints";
import { pairDevice, pairingBinding, pairingFailureMessage, sameAddress } from "./pairing";

const FP = "AB:".repeat(31) + "AB";
const KEY = "EF:".repeat(31) + "EF";
const DEVICE = { platform: "ios" as const, virtual: false, name: "iPhone" };
const HOST_NONCE = "h".repeat(43);

type Behaviour = "host" | "unreachable" | "mismatch" | "untrusted";

/**
 * A socket per address that behaves like a host for pairing: challenge,
 * then the digits it computes from the key (or certificate) it serves, then approval.
 */
function hostSockets(behaviour: Record<string, Behaviour>, served = FP, servedKey = KEY) {
  const opened: string[] = [];
  const openSocket = (candidate: SocketCandidate) => {
    opened.push(candidate.url);
    const listeners: Record<string, Array<(event: never) => void>> = {};
    const fire = (type: string, event: object = {}) => { for (const listener of listeners[type] ?? []) (listener as (event: object) => void)(event); };
    let commitment = "";
    let byKey = false;
    const socket = {
      readyState: 0,
      fingerprint: undefined as string | undefined,
      publicKey: undefined as string | undefined,
      pinMismatch: false,
      untrustedCertificate: false,
      addEventListener: (type: string, listener: (event: never) => void) => { (listeners[type] ??= []).push(listener); },
      close: () => { if (socket.readyState === 3) return; socket.readyState = 3; fire("close", { code: 1000 }); },
      send: (text: string) => {
        const frame = JSON.parse(text) as { type: string; id: string; pair?: { commitment?: string; code?: string; name?: string; binding?: string }; nonce?: string };
        const reply = (value: object) => queueMicrotask(() => fire("message", { data: JSON.stringify({ type: "pair-reply", id: frame.id, reply: value }) }));
        if (frame.type === "pair") {
          commitment = frame.pair?.commitment ?? "";
          byKey = frame.pair?.binding === "key";
          reply({ state: "challenge", requestId: "r1", hostNonce: HOST_NONCE });
        }
        if (frame.type === "pair-reveal") {
          const tls = candidate.url.startsWith("wss:") && !candidate.proxied;
          void pairingVerificationCode({ ...(byKey ? { publicKey: tls ? servedKey : "" } : { fingerprint: tls ? served : "" }), deviceNonce: frame.nonce!, hostNonce: HOST_NONCE }).then((verification) => {
            reply({ state: "waiting", requestId: "r1", verification, expiresAt: "2026-09-24T12:00:00.000Z" });
            reply({ state: "approved", token: `token-for-${commitment.length}`, clientId: "c1", access: "full" });
          });
        }
      },
    };
    queueMicrotask(() => {
      const kind = behaviour[candidate.url] ?? "unreachable";
      if (kind === "host") {
        socket.readyState = 1;
        if (candidate.url.startsWith("wss:")) {
          // Behind a CA-vouched proxy the phone sees the proxy's certificate, not the host's.
          socket.fingerprint = candidate.proxied ? "11:22" : served;
          socket.publicKey = candidate.proxied ? "33:44" : servedKey;
        }
        fire("open");
        return;
      }
      socket.pinMismatch = kind === "mismatch";
      socket.untrustedCertificate = kind === "untrusted";
      socket.readyState = 3;
      fire("error");
      fire("close", { code: 1006 });
    });
    return socket;
  };
  return { openSocket, opened };
}

describe("pairDevice", () => {
  it("pairs over the best address that answers, with the digits bound to the pinned certificate", async () => {
    const sockets = hostSockets({ "wss://192.168.1.2:7788/": "unreachable", "wss://100.64.1.2:7788/": "host" });
    const waiting: string[] = [];
    const outcome = await pairDevice({
      hostId: "h-1",
      name: "Mac mini",
      fingerprint: FP,
      code: "code",
      endpoints: [{ url: "https://192.168.1.2:7788/", kind: "lan" }, { url: "https://100.64.1.2:7788/", kind: "tailscale" }],
    }, { device: DEVICE, openSocket: sockets.openSocket, now: () => new Date("2026-09-24T10:00:00.000Z"), race: { graceMs: 0 } }, {
      onWaiting: ({ verification }) => waiting.push(verification),
    });
    expect(outcome).toMatchObject({
      state: "approved",
      token: "token-for-64",
      host: { id: "h-1", name: "Mac mini", fingerprint: FP, access: "full", lastEndpoint: { kind: "tailscale" }, addedAt: "2026-09-24T10:00:00.000Z" },
    });
    // The device computed the digits itself; they matched the host's, so no failure.
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatch(/^\d{6}$/u);
  });

  it("pins the host's key when the link names it, binds the digits to it, and keeps only the key", async () => {
    const sockets = hostSockets({ "wss://192.168.1.2:7788/": "host" });
    const outcome = await pairDevice({ hostId: "h-1", name: "Mac", publicKey: KEY, fingerprint: FP, endpoints: [{ url: "https://192.168.1.2:7788/", kind: "lan" }] }, { device: DEVICE, openSocket: sockets.openSocket });
    expect(outcome).toMatchObject({ state: "approved", host: { publicKey: KEY } });
    expect(outcome.state === "approved" && outcome.host.fingerprint).toBeUndefined();
  });

  it("pairs through a CA-vouched address without the pin, with digits bound to nothing", async () => {
    const sockets = hostSockets({ "wss://mac.tail0000.ts.net/": "host" });
    const outcome = await pairDevice({
      hostId: "h-1", name: "Mac", publicKey: KEY,
      endpoints: [{ url: "https://mac.tail0000.ts.net/", kind: "magicdns", trustedCertificate: true }],
    }, { device: DEVICE, openSocket: sockets.openSocket });
    expect(outcome).toMatchObject({ state: "approved", host: { publicKey: KEY, endpoints: [{ trustedCertificate: true }] } });
  });

  it("refuses a host whose digits disagree: something between them is not the host", async () => {
    const other = "CD:".repeat(31) + "CD";
    // The phone pinned FP and sees it, but the far end computes with another certificate (a relay).
    const sockets = hostSockets({ "wss://192.168.1.2:7788/": "host" }, other);
    const outcome = await pairDevice({ hostId: "h", name: "Mac", fingerprint: other, endpoints: [{ url: "https://192.168.1.2:7788/", kind: "lan" }] }, { device: DEVICE, openSocket: (candidate) => {
      const socket = sockets.openSocket(candidate);
      // What the phone saw: the pinned certificate, not the relay's.
      socket.addEventListener("open", () => { socket.fingerprint = FP; });
      return socket;
    } });
    expect(outcome.state).toBe("failed");
  });

  it("says why nothing was sent: no address for a phone, nothing answered, another certificate", async () => {
    const none = await pairDevice({ hostId: "h", name: "Mac", endpoints: [{ url: "http://127.0.0.1:1/", kind: "loopback" }] }, { device: DEVICE, openSocket: hostSockets({}).openSocket });
    expect(none).toEqual({ state: "failed", message: pairingFailureMessage({ reason: "no-address" }) });
    const silent = await pairDevice({ hostId: "h", name: "Mac", fingerprint: FP, endpoints: [{ url: "https://10.0.0.2:7788/" }] }, { device: DEVICE, openSocket: hostSockets({}).openSocket });
    expect(silent).toEqual({ state: "failed", message: pairingFailureMessage({ reason: "unreachable" }) });
    expect(silent.state === "failed" && silent.message).toMatch(/did not answer/u);
    const sockets = hostSockets({ "wss://10.0.0.2:7788/": "mismatch" });
    const mismatch = await pairDevice({ hostId: "h", name: "Mac", fingerprint: FP, endpoints: [{ url: "https://10.0.0.2:7788/" }] }, { device: DEVICE, openSocket: sockets.openSocket });
    expect(mismatch).toEqual({ state: "failed", message: "10.0.0.2:7788 answered with another certificate than the one in the code. This phone did not send it anything." });
    // One probe, and no pairing socket after it: the phone sent that host nothing.
    expect(sockets.opened).toEqual(["wss://10.0.0.2:7788/"]);
  });

  it("names the address whose certificate the phone does not trust, instead of saying nothing answered", async () => {
    const sockets = hostSockets({ "wss://mac.tail0000.ts.net/": "untrusted" });
    const outcome = await pairDevice({
      hostId: "h", name: "Mac", publicKey: KEY,
      endpoints: [{ url: "https://192.168.1.2:7788/", kind: "lan" }, { url: "https://mac.tail0000.ts.net/", kind: "magicdns", trustedCertificate: true }],
    }, { device: DEVICE, openSocket: sockets.openSocket, race: { graceMs: 0 } });
    expect(outcome.state === "failed" && outcome.message).toMatch(/^mac\.tail0000\.ts\.net showed a certificate this phone does not trust/u);
    expect(sockets.opened).toHaveLength(2);
  });

  it("pairs with a loopback host from a simulator, digits bound to no certificate", async () => {
    const sockets = hostSockets({ "ws://127.0.0.1:60303/": "host" });
    const outcome = await pairDevice({ hostId: "h", name: "Dev", endpoints: [{ url: "http://127.0.0.1:60303/", kind: "loopback" }] }, { device: { ...DEVICE, virtual: true }, openSocket: sockets.openSocket });
    expect(outcome.state).toBe("approved");
  });
});

describe("pairingBinding", () => {
  const candidate = (url: string, extra: Partial<SocketCandidate> = {}): SocketCandidate => ({ url, rank: 0, trust: "pin", allowAuthority: false, ...extra });
  it("binds to the pinned key, or an old pinned certificate, when the host showed it, and to nothing otherwise", () => {
    expect(pairingBinding(candidate("wss://a/", { publicKey: KEY }), { publicKey: KEY, fingerprint: FP })).toEqual({ publicKey: KEY });
    expect(pairingBinding(candidate("wss://a/", { fingerprint: FP }), { publicKey: KEY, fingerprint: FP })).toEqual({ fingerprint: FP });
    // An old pin that let a CA in (Tailscale Serve before the flag): TLS ended by the proxy.
    expect(pairingBinding(candidate("wss://m.ts.net/", { fingerprint: FP, allowAuthority: true }), { fingerprint: "CD" })).toEqual({ fingerprint: "" });
    expect(pairingBinding(candidate("wss://m.ts.net/", { trust: "authority", proxied: true }), { publicKey: "CD" })).toEqual({ publicKey: "" });
    expect(pairingBinding(candidate("ws://127.0.0.1:1/", { trust: "plain" }), {})).toEqual({ publicKey: "" });
    // A link without a pin: the key the host's own listener showed.
    expect(pairingBinding(candidate("wss://10.0.0.2/", { trust: "authority" }), { publicKey: "EF" })).toEqual({ publicKey: "EF" });
  });

  it("matches an endpoint to the socket address, the emulator alias included", () => {
    expect(sameAddress("https://192.168.1.2:7788/", "wss://192.168.1.2:7788/")).toBe(true);
    expect(sameAddress("http://127.0.0.1:60303/", "ws://10.0.2.2:60303/")).toBe(true);
    expect(sameAddress("https://192.168.1.2:7788/", "wss://192.168.1.3:7788/")).toBe(false);
  });
});
