import type { DeviceAccess } from "./connections.js";
import { decodeHostServerFrame, type HostClientFrame } from "./host-transport.js";
import {
  pairingCommitment,
  pairingVerificationCode,
  randomPairingNonce,
  type HostPairReply,
  type PairRefusal,
} from "./pairing.js";

/** What a socket must offer; a browser's `WebSocket` does, and so does `ws` with a pinned connection. */
export interface PairingSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code?: number; reason?: string }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
}

export type PairingResult =
  | { state: "approved"; token: string; clientId: string; access: DeviceAccess }
  | { state: "denied" }
  | { state: "expired" }
  | { state: "refused"; reason: PairRefusal; retryAfterMs?: number }
  /** The socket failed, the host answered nonsense, or its digits were not the ones this device computed. */
  | { state: "failed"; message: string };

export interface PairWithHostOptions {
  /** The host's socket, `ws:` or `wss:`. */
  url: string;
  /** From a pairing link; without one the owner is asked all the same. */
  code?: string;
  /** How this device names itself to the owner. */
  name?: string;
  /**
   * The certificate fingerprint this device pinned for the connection. With
   * it the digits are bound to that certificate, so a relay presenting
   * another one shows the owner different digits. Leave it out where the
   * socket cannot pin (a browser).
   */
  fingerprint?: string;
  /** The digits to show, as soon as the owner sees the request too. */
  onWaiting?(waiting: { verification: string; expiresAt: string }): void;
  createSocket?(url: string): PairingSocket;
  signal?: AbortSignal;
}

/**
 * Asks a host to let this device in and waits for its owner's answer (ADR
 * 0024). Resolves once the owner allowed or denied it, or the request ran
 * out; the token of an allowed device then says hello on a socket of its own.
 */
export function pairWithHost(options: PairWithHostOptions): Promise<PairingResult> {
  const socket = options.createSocket?.(options.url) ?? (new WebSocket(options.url) as unknown as PairingSocket);
  const id = `pair-${Math.random().toString(36).slice(2)}`;
  const send = (frame: HostClientFrame) => socket.send(JSON.stringify(frame));
  return new Promise<PairingResult>((resolve) => {
    let settled = false;
    let nonce: string | undefined;
    let ownCode: string | undefined;
    const finish = (result: PairingResult) => {
      if (settled) return;
      settled = true;
      socket.close();
      resolve(result);
    };
    options.signal?.addEventListener("abort", () => finish({ state: "failed", message: "Pairing was cancelled." }));

    socket.addEventListener("open", () => {
      void (async () => {
        const bound = options.fingerprint !== undefined;
        if (bound) nonce = randomPairingNonce();
        send({
          type: "pair",
          id,
          pair: {
            ...(options.code ? { code: options.code } : {}),
            ...(options.name ? { name: options.name } : {}),
            ...(nonce ? { commitment: await pairingCommitment(nonce) } : {}),
          },
        });
      })().catch((error: unknown) => finish({ state: "failed", message: error instanceof Error ? error.message : String(error) }));
    });

    const onReply = async (reply: HostPairReply): Promise<void> => {
      switch (reply.state) {
        case "challenge": {
          if (!nonce) { finish({ state: "failed", message: "The host asked for a nonce this device never committed to." }); return; }
          ownCode = await pairingVerificationCode({ fingerprint: options.fingerprint ?? "", deviceNonce: nonce, hostNonce: reply.hostNonce });
          send({ type: "pair-reveal", id, nonce });
          return;
        }
        case "waiting":
          // Bound digits are this device's own; the host's copy only has to agree.
          if (ownCode && ownCode !== reply.verification) {
            finish({ state: "failed", message: "The host's code differs from this device's: something between them is not the host." });
            return;
          }
          options.onWaiting?.({ verification: ownCode ?? reply.verification, expiresAt: reply.expiresAt });
          return;
        default:
          finish(reply);
      }
    };

    socket.addEventListener("message", (event) => {
      let parsed: unknown;
      try { parsed = JSON.parse(String(event.data)); } catch { return; }
      const frame = decodeHostServerFrame(parsed);
      if (frame?.type !== "pair-reply" || frame.id !== id) return;
      void onReply(frame.reply).catch((error: unknown) => finish({ state: "failed", message: error instanceof Error ? error.message : String(error) }));
    });
    socket.addEventListener("error", () => finish({ state: "failed", message: "The host could not be reached." }));
    socket.addEventListener("close", () => finish({ state: "failed", message: "The host closed the connection." }));
  });
}
