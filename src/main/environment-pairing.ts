import { WebSocket, type ClientOptions } from "ws";
import { authorityName, parsePairingPayload, type PairingEndpoint, type PairingPayload } from "../shared/connections.js";
import { addressPageUrl, orderEndpoints, refreshEndpoints, socketUrl } from "../shared/environments.js";
import { pairWithHost, type PairingSocket } from "../shared/host-pairing.js";
import { HOST_TRANSPORT_VERSION, decodeHostServerFrame, type HostHelloReply } from "../shared/host-transport.js";
import type { SavedEnvironment } from "./environment-catalog.js";
import { hostTlsConnect, probeHostCertificate, type EndpointTrust, type HostPin, type PresentedCertificate } from "./host-tls-trust.js";

/** A machine a Bonjour search found: its record's host id and fingerprint, and the addresses it resolved to. */
export interface NearbyMachine {
  hostId: string;
  name: string;
  fingerprint: string;
  endpoints: PairingEndpoint[];
}

export interface PairEnvironmentOptions {
  /** A pairing link, the text of its QR code, or an address such as `studio.local:7788`. */
  text?: string;
  /** Instead of `text`: asks a found machine without a link, pinning the fingerprint its record carried. */
  nearby?: NearbyMachine;
  /** How this window names itself to the owner. */
  deviceName: string;
  onConnecting?(address: string): void;
  onWaiting?(waiting: { address: string; verification: string; expiresAt: string }): void;
  signal?: AbortSignal;
  probe?(url: string): Promise<PresentedCertificate>;
  createSocket?(url: string, trust: EndpointTrust | undefined): PairingSocket;
  now?(): Date;
}

export type PairEnvironmentResult =
  | { state: "approved"; environment: SavedEnvironment }
  | { state: "denied" | "expired" | "cancelled" }
  | { state: "failed"; message: string };

function defaultSocket(url: string, trust: EndpointTrust | undefined): PairingSocket {
  const options: ClientOptions = url.startsWith("wss:")
    ? { createConnection: hostTlsConnect(trust) as unknown as ClientOptions["createConnection"] }
    : {};
  return new WebSocket(url, options) as unknown as PairingSocket;
}

const REFUSALS: Record<string, string> = {
  "unknown-code": "The machine did not accept that pairing link: it was used already, expired, or was revoked. Make a new one there.",
  busy: "The machine has too many requests waiting. Try again in a minute.",
  "rate-limited": "The machine asked this window to wait before asking again.",
  invalid: "The machine did not understand the request; it may run an older Tau.",
};

/**
 * Asks another machine's host to let this window in (ADR 0024, ADR 0025) and
 * waits for its owner. A link brings the host's key; a bare address has its
 * certificate read first and its key pinned for the attempt, and the six
 * digits both screens show are bound to it. An address a CA vouches for
 * (Tailscale Serve) is checked by chain and name instead, and its digits are
 * unbound: the proxy ends TLS. Only an approved machine comes back to be saved.
 */
export async function pairEnvironment(options: PairEnvironmentOptions): Promise<PairEnvironmentResult> {
  const nearby = options.nearby;
  const text = options.text ?? "";
  const payload: PairingPayload | undefined = nearby
    ? { code: "", endpoints: nearby.endpoints, fingerprint: nearby.fingerprint, hostId: nearby.hostId, hostName: nearby.name }
    : parsePairingPayload(text);
  const typed = payload ? undefined : addressPageUrl(text);
  if (!payload && !typed) return { state: "failed", message: "Paste a pairing link or type an address such as studio.local:7788." };
  const endpoints: PairingEndpoint[] = payload ? orderEndpoints(payload.endpoints) : [{ url: typed! }];
  if (endpoints.length === 0) return { state: "failed", message: "The pairing link names no address." };
  const createSocket = options.createSocket ?? defaultSocket;
  let lastProblem = "The machine could not be reached at any of its addresses.";

  for (const endpoint of endpoints) {
    if (options.signal?.aborted) return { state: "cancelled" };
    const url = socketUrl(endpoint.url);
    options.onConnecting?.(url);
    let pin: HostPin | undefined;
    // What the digits are bound to: the key both sides see, or nothing through a proxy.
    let bindKey: string | undefined;
    let bindCertificate: string | undefined;
    if (url.startsWith("wss:")) {
      if (endpoint.trustedCertificate && authorityName(endpoint.url)) {
        bindKey = "";
      } else if (payload?.publicKey) {
        pin = { publicKey: payload.publicKey };
        bindKey = payload.publicKey;
      } else if (payload?.fingerprint) {
        // A link from a host before key pins: the certificate is pinned and bound, as that host expects.
        pin = { fingerprint: payload.fingerprint };
        bindCertificate = payload.fingerprint;
      } else {
        let presented: PresentedCertificate;
        try { presented = await (options.probe ?? probeHostCertificate)(url); }
        catch (error: unknown) { lastProblem = `${endpoint.url} could not be reached: ${error instanceof Error ? error.message : String(error)}`; continue; }
        // A certificate an authority vouches for is renewed under the same name; pin only a self-signed one.
        pin = presented.authorized ? undefined : { publicKey: presented.publicKey };
        bindKey = presented.publicKey;
      }
    }
    const trust: EndpointTrust | undefined = url.startsWith("wss:") ? (pin ? { pin } : {}) : undefined;
    const result = await pairWithHost({
      url,
      ...(payload?.code ? { code: payload.code } : {}),
      name: options.deviceName,
      // Bound digits need a key both sides see; a plaintext loopback socket has none, which both sides agree on.
      ...(bindCertificate !== undefined ? { fingerprint: bindCertificate } : { publicKey: bindKey ?? "" }),
      createSocket: (target) => createSocket(target, trust),
      onWaiting: ({ verification, expiresAt }) => options.onWaiting?.({ address: url, verification, expiresAt }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (options.signal?.aborted) return { state: "cancelled" };
    if (result.state === "failed") {
      lastProblem = result.message;
      // Reached, but refused on the digits: another address will not make that better.
      if (/code differs/u.test(result.message)) return { state: "failed", message: result.message };
      continue;
    }
    if (result.state === "denied" || result.state === "expired") return { state: result.state };
    if (result.state === "refused") return { state: "failed", message: REFUSALS[result.reason] ?? `The machine refused: ${result.reason}.` };
    const reply = await helloOnce(url, result.token, trust, createSocket).catch(() => undefined);
    const fallbackName = payload?.hostName ?? new URL(endpoint.url).hostname;
    const environment: SavedEnvironment = {
      id: reply?.host?.id ?? payload?.hostId ?? `address:${new URL(endpoint.url).host}`,
      name: reply?.host?.name || fallbackName,
      // A machine reached at one address names the others its listeners have now.
      endpoints: refreshEndpoints(payload ? payload.endpoints : [endpoint], reply?.host?.endpoints ?? [], endpoint.url),
      ...(payload?.publicKey ? { publicKey: payload.publicKey } : pin?.publicKey ? { publicKey: pin.publicKey } : {}),
      ...(!payload?.publicKey && payload?.fingerprint ? { fingerprint: payload.fingerprint } : {}),
      token: result.token,
      addedAt: (options.now?.() ?? new Date()).toISOString(),
      lastUrl: endpoint.url,
      ...(result.access === "read-only" ? { readOnly: true } : {}),
    };
    return { state: "approved", environment };
  }
  return { state: "failed", message: lastProblem };
}

/** One hello with a fresh token: which machine this is, as it names itself. */
function helloOnce(url: string, token: string, trust: EndpointTrust | undefined, createSocket: (url: string, trust: EndpointTrust | undefined) => PairingSocket): Promise<HostHelloReply> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(url, trust);
    const timer = setTimeout(() => { socket.close(); reject(new Error("no hello reply")); }, 10_000);
    const done = (error?: Error, reply?: HostHelloReply) => {
      clearTimeout(timer);
      socket.close();
      if (reply) resolve(reply);
      else reject(error ?? new Error("closed"));
    };
    socket.addEventListener("open", () => socket.send(JSON.stringify({
      type: "hello",
      id: "hello",
      hello: { protocol: HOST_TRANSPORT_VERSION, token, auxiliary: true, subscription: { threads: [], topics: [] } },
    })));
    socket.addEventListener("message", (event) => {
      let parsed: unknown;
      try { parsed = JSON.parse(String(event.data)); } catch { return; }
      const frame = decodeHostServerFrame(parsed);
      if (frame?.type === "hello-reply") done(undefined, frame.reply);
    });
    socket.addEventListener("error", () => done(new Error("socket error")));
    socket.addEventListener("close", () => done(new Error("closed")));
  });
}
