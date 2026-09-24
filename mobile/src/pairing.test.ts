import { describe, expect, it } from "vitest";
import { pairingVerificationCode } from "../../src/shared/pairing";
import type { SocketCandidate } from "./endpoints";
import { bindingFingerprint, pairDevice, pairingFailure, sameAddress } from "./pairing";

const FP = "AB:".repeat(31) + "AB";
const DEVICE = { platform: "ios" as const, virtual: false, name: "iPhone" };
const HOST_NONCE = "h".repeat(43);

type Behaviour = "host" | "unreachable" | "mismatch";

/**
 * A socket per address that behaves like a host for pairing: challenge,
 * then the digits it computes from the certificate it serves, then approval.
 */
function hostSockets(behaviour: Record<string, Behaviour>, served = FP) {
  const opened: string[] = [];
  const openSocket = (candidate: SocketCandidate) => {
    opened.push(candidate.url);
    const listeners: Record<string, Array<(event: never) => void>> = {};
    const fire = (type: string, event: object = {}) => { for (const listener of listeners[type] ?? []) (listener as (event: object) => void)(event); };
    let commitment = "";
    const socket = {
      readyState: 0,
      fingerprint: undefined as string | undefined,
      pinMismatch: false,
      addEventListener: (type: string, listener: (event: never) => void) => { (listeners[type] ??= []).push(listener); },
      close: () => { if (socket.readyState === 3) return; socket.readyState = 3; fire("close", { code: 1000 }); },
      send: (text: string) => {
        const frame = JSON.parse(text) as { type: string; id: string; pair?: { commitment?: string; code?: string; name?: string }; nonce?: string };
        const reply = (value: object) => queueMicrotask(() => fire("message", { data: JSON.stringify({ type: "pair-reply", id: frame.id, reply: value }) }));
        if (frame.type === "pair") {
          commitment = frame.pair?.commitment ?? "";
          reply({ state: "challenge", requestId: "r1", hostNonce: HOST_NONCE });
        }
        if (frame.type === "pair-reveal") {
          void pairingVerificationCode({ fingerprint: candidate.url.startsWith("wss:") ? served : "", deviceNonce: frame.nonce!, hostNonce: HOST_NONCE }).then((verification) => {
            reply({ state: "waiting", requestId: "r1", verification, expiresAt: "2026-09-24T12:00:00.000Z" });
            reply({ state: "approved", token: `token-for-${commitment.length}`, clientId: "c1", access: "full" });
          });
        }
      },
    };
    queueMicrotask(() => {
      const kind = behaviour[candidate.url] ?? "unreachable";
      if (kind === "host") { socket.readyState = 1; socket.fingerprint = candidate.url.startsWith("wss:") ? served : undefined; fire("open"); return; }
      socket.pinMismatch = kind === "mismatch";
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
    expect(none).toEqual({ state: "failed", message: pairingFailure["no-address"] });
    const silent = await pairDevice({ hostId: "h", name: "Mac", fingerprint: FP, endpoints: [{ url: "https://10.0.0.2:7788/" }] }, { device: DEVICE, openSocket: hostSockets({}).openSocket });
    expect(silent).toEqual({ state: "failed", message: pairingFailure.unreachable });
    const sockets = hostSockets({ "wss://10.0.0.2:7788/": "mismatch" });
    const mismatch = await pairDevice({ hostId: "h", name: "Mac", fingerprint: FP, endpoints: [{ url: "https://10.0.0.2:7788/" }] }, { device: DEVICE, openSocket: sockets.openSocket });
    expect(mismatch).toEqual({ state: "failed", message: pairingFailure["certificate-mismatch"] });
    // One probe, and no pairing socket after it: the phone sent that host nothing.
    expect(sockets.opened).toEqual(["wss://10.0.0.2:7788/"]);
  });

  it("pairs with a loopback host from a simulator, digits bound to no certificate", async () => {
    const sockets = hostSockets({ "ws://127.0.0.1:60303/": "host" });
    const outcome = await pairDevice({ hostId: "h", name: "Dev", endpoints: [{ url: "http://127.0.0.1:60303/", kind: "loopback" }] }, { device: { ...DEVICE, virtual: true }, openSocket: sockets.openSocket });
    expect(outcome.state).toBe("approved");
  });
});

describe("bindingFingerprint", () => {
  const candidate = (url: string, extra: Partial<SocketCandidate> = {}): SocketCandidate => ({ url, rank: 0, allowAuthority: false, ...extra });
  it("binds to the pin when the host showed it, and to nothing otherwise", () => {
    expect(bindingFingerprint(candidate("wss://a/", { fingerprint: FP }), FP)).toBe(FP);
    // Tailscale Serve: a trusted certificate that is not the pin, TLS ended by the proxy.
    expect(bindingFingerprint(candidate("wss://m.ts.net/", { fingerprint: FP, allowAuthority: true }), "CD")).toBe("");
    expect(bindingFingerprint(candidate("ws://127.0.0.1:1/"), undefined)).toBe("");
    // A link without a pin: the certificate the host's own listener showed.
    expect(bindingFingerprint(candidate("wss://10.0.0.2/"), "EF")).toBe("EF");
    expect(bindingFingerprint(candidate("wss://host.example/", { allowAuthority: true }), "EF")).toBe("");
  });

  it("matches an endpoint to the socket address, the emulator alias included", () => {
    expect(sameAddress("https://192.168.1.2:7788/", "wss://192.168.1.2:7788/")).toBe(true);
    expect(sameAddress("http://127.0.0.1:60303/", "ws://10.0.2.2:60303/")).toBe(true);
    expect(sameAddress("https://192.168.1.2:7788/", "wss://192.168.1.3:7788/")).toBe(false);
  });
});
