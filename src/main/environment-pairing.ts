import { WebSocket, type ClientOptions } from "ws";
import { parsePairingPayload, type PairingEndpoint } from "../shared/connections.js";
import { addressPageUrl, orderEndpoints, socketUrl } from "../shared/environments.js";
import { pairWithHost, type PairingSocket } from "../shared/host-pairing.js";
import { HOST_TRANSPORT_VERSION, decodeHostServerFrame, type HostHelloReply } from "../shared/host-transport.js";
import type { SavedEnvironment } from "./environment-catalog.js";
import { pinnedTlsConnect, probeHostCertificate, type PresentedCertificate } from "./host-tls-trust.js";

export interface PairEnvironmentOptions {
  /** A pairing link, the text of its QR code, or an address such as `studio.local:7788`. */
  text: string;
  /** How this window names itself to the owner. */
  deviceName: string;
  onConnecting?(address: string): void;
  onWaiting?(waiting: { address: string; verification: string; expiresAt: string }): void;
  signal?: AbortSignal;
  probe?(url: string): Promise<PresentedCertificate>;
  createSocket?(url: string, fingerprint: string | undefined): PairingSocket;
  now?(): Date;
}

export type PairEnvironmentResult =
  | { state: "approved"; environment: SavedEnvironment }
  | { state: "denied" | "expired" | "cancelled" }
  | { state: "failed"; message: string };

function defaultSocket(url: string, fingerprint: string | undefined): PairingSocket {
  const options: ClientOptions = fingerprint && url.startsWith("wss:")
    ? { createConnection: pinnedTlsConnect(fingerprint) as unknown as ClientOptions["createConnection"] }
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
 * waits for its owner. A link brings its fingerprint; a bare address has its
 * certificate read first and pinned for the attempt, and the six digits both
 * screens show are bound to it. Only an approved machine comes back to be saved.
 */
export async function pairEnvironment(options: PairEnvironmentOptions): Promise<PairEnvironmentResult> {
  const payload = parsePairingPayload(options.text);
  const typed = payload ? undefined : addressPageUrl(options.text);
  if (!payload && !typed) return { state: "failed", message: "Paste a pairing link or type an address such as studio.local:7788." };
  const endpoints: PairingEndpoint[] = payload ? orderEndpoints(payload.endpoints) : [{ url: typed! }];
  if (endpoints.length === 0) return { state: "failed", message: "The pairing link names no address." };
  const createSocket = options.createSocket ?? defaultSocket;
  let lastProblem = "The machine could not be reached at any of its addresses.";

  for (const endpoint of endpoints) {
    if (options.signal?.aborted) return { state: "cancelled" };
    const url = socketUrl(endpoint.url);
    options.onConnecting?.(url);
    let pin: string | undefined;
    let bindTo: string | undefined;
    if (url.startsWith("wss:")) {
      if (payload?.fingerprint) {
        pin = payload.fingerprint;
      } else {
        let presented: PresentedCertificate;
        try { presented = await (options.probe ?? probeHostCertificate)(url); }
        catch (error: unknown) { lastProblem = `${endpoint.url} could not be reached: ${error instanceof Error ? error.message : String(error)}`; continue; }
        // A certificate an authority vouches for is renewed under the same name; pin only a self-signed one.
        pin = presented.authorized ? undefined : presented.fingerprint;
        bindTo = presented.fingerprint;
      }
    }
    const result = await pairWithHost({
      url,
      ...(payload?.code ? { code: payload.code } : {}),
      name: options.deviceName,
      // Bound digits need a certificate both sides see; a plaintext loopback socket has none, which both sides agree on.
      fingerprint: pin ?? bindTo ?? "",
      createSocket: (target) => createSocket(target, pin),
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
    const reply = await helloOnce(url, result.token, pin, createSocket).catch(() => undefined);
    const fallbackName = payload?.hostName ?? new URL(endpoint.url).hostname;
    const environment: SavedEnvironment = {
      id: reply?.host?.id ?? payload?.hostId ?? `address:${new URL(endpoint.url).host}`,
      name: reply?.host?.name || fallbackName,
      endpoints: payload ? payload.endpoints : [endpoint],
      ...(pin ? { fingerprint: pin } : {}),
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
function helloOnce(url: string, token: string, fingerprint: string | undefined, createSocket: (url: string, fingerprint: string | undefined) => PairingSocket): Promise<HostHelloReply> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(url, fingerprint);
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
