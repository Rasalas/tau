import { dialog, type BrowserWindow, type Session } from "electron";
import { X509Certificate } from "node:crypto";
import { join } from "node:path";
import type { HostLogger } from "./host-log.js";
import {
  CERTIFICATE_REJECT,
  HostTrustError,
  KnownHosts,
  certificateRefusalMessage,
  certificateVerdict,
  establishHostTrust,
  hostEndpoint,
  migratedKnownHostPin,
  presentedIdentity,
  type EndpointTrust,
  type HostTrust,
  type PresentedCertificate,
  type PresentedIdentity,
  type ReachedCertificate,
} from "./host-tls-trust.js";

export interface RemoteHostTrustOptions {
  userData: string;
  /** `TAU_HOST_PUBLIC_KEY`, when the operator pinned the key up front. */
  publicKey?: string;
  /** `TAU_HOST_FINGERPRINT`: the certificate, or in `sha256/<base64>` form the key. */
  fingerprint?: string;
  session: Session;
  logger: HostLogger;
  /** The trust question is a sheet on this window, never a free-floating alert. */
  parent: BrowserWindow;
  /** Called once with the reason, written for the user; the window shows it and does not connect. */
  onRefused(message: string): void;
}

export interface RemoteHostTrust {
  trust: HostTrust;
  /** What the uplink pins, for a pinned host; a migration updates it in place. */
  endpoint?: EndpointTrust;
  /** The pinned host showed another certificate somewhere else (the uplink). */
  refuse(presented: string): void;
  /** The uplink's hello succeeded: a known-hosts certificate pin moves to the key it let in. */
  reached(certificate: ReachedCertificate | undefined): void;
}

/**
 * The window's side of TLS for `TAU_HOST_URL`: decides how the host is
 * trusted (asking the user once for an unknown self-signed certificate) and
 * makes Chromium, which runs the renderer's socket, accept exactly the pinned
 * certificate for that host name and nothing else.
 */
export async function trustRemoteHost(url: string, options: RemoteHostTrustOptions): Promise<RemoteHostTrust | undefined> {
  const knownHosts = new KnownHosts(join(options.userData, "known-hosts.json"), options.logger);
  let trust: HostTrust;
  try {
    trust = await establishHostTrust(url, {
      ...(options.publicKey ? { publicKey: options.publicKey } : {}),
      ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
      knownHosts,
      confirm: ({ endpoint, presented }) => confirmCertificate(options.parent, endpoint.key, presented),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    options.logger.warn("remote-host.trust.failed", { url, reason: error instanceof HostTrustError ? error.reason : "error", message });
    options.onRefused(message);
    return undefined;
  }
  options.logger.info("remote-host.trust", trust.kind === "pinned" ? { url, kind: trust.kind, source: trust.source, ...trust.pin } : { url, kind: trust.kind });

  const endpoint: EndpointTrust | undefined = trust.kind === "pinned" ? { pin: trust.pin } : undefined;
  let refused = false;
  const refuse = (presented: PresentedIdentity | string): void => {
    if (refused) return;
    refused = true;
    options.logger.error("remote-host.certificate-refused", { url, presented });
    options.onRefused(certificateRefusalMessage(url, trust, presented, knownHosts.path));
  };
  let migrating = false;
  const reached = (certificate: ReachedCertificate | undefined): void => {
    const pin = migratedKnownHostPin(trust, certificate);
    if (!pin || migrating || trust.kind !== "pinned") return;
    migrating = true;
    // Both of the window's connections accept the key from here on, so a renewal mid-session is kept.
    trust = { ...trust, pin };
    endpoint!.pin = pin;
    void knownHosts.remember(hostEndpoint(url).key, pin).then(
      () => options.logger.info("remote-host.pin-migrated", { url, publicKey: pin.publicKey }),
      (error: unknown) => options.logger.warn("remote-host.pin-migration.failed", { url, message: error instanceof Error ? error.message : String(error) }),
    );
  };
  if (trust.kind === "pinned") {
    options.session.setCertificateVerifyProc((request, callback) => {
      let presented: PresentedIdentity | undefined;
      try { presented = presentedIdentity(new X509Certificate(request.certificate.data)); }
      catch { presented = undefined; }
      const verdict = certificateVerdict(trust, request.hostname, presented ?? UNREADABLE);
      if (verdict === CERTIFICATE_REJECT) refuse(presented ?? "(unreadable)");
      callback(verdict);
    });
  }
  return { trust, ...(endpoint ? { endpoint } : {}), refuse, reached };
}

/** Matches no pin: an unreadable certificate is refused for the pinned name and left to Chromium for others. */
const UNREADABLE: PresentedIdentity = { fingerprint: "", publicKey: "" };

async function confirmCertificate(parent: BrowserWindow, hostKey: string, presented: PresentedCertificate): Promise<boolean> {
  const { response } = await dialog.showMessageBox(parent, {
    type: "warning",
    title: "Trust this host?",
    message: `Trust the host at ${hostKey}?`,
    detail: [
      "Its certificate is not signed by an authority this machine trusts, which is normal for a Tau host's own certificate.",
      "",
      `Public key SHA-256: ${presented.publicKey}`,
      "",
      "Compare it with the \"tls public key\" line the host printed when it started. Trust it only if they match: Tau then remembers the key for this host and refuses any other.",
    ].join("\n"),
    buttons: ["Trust and Connect", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return response === 0;
}
