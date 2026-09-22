import { dialog, type BrowserWindow, type Session } from "electron";
import { join } from "node:path";
import type { HostLogger } from "./host-log.js";
import { certificateFingerprint } from "./host-tls.js";
import {
  CERTIFICATE_REJECT,
  HostTrustError,
  KnownHosts,
  certificateRefusalMessage,
  certificateVerdict,
  establishHostTrust,
  type HostTrust,
  type PresentedCertificate,
} from "./host-tls-trust.js";

export interface RemoteHostTrustOptions {
  userData: string;
  /** `TAU_HOST_FINGERPRINT`, when the operator pinned the certificate up front. */
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
  /** What the uplink pins, for a pinned host. */
  fingerprint?: string;
  /** The pinned host showed another certificate somewhere else (the uplink). */
  refuse(presented: string): void;
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
  options.logger.info("remote-host.trust", trust.kind === "pinned" ? { url, kind: trust.kind, source: trust.source, fingerprint: trust.fingerprint } : { url, kind: trust.kind });

  let refused = false;
  const refuse = (presented: string): void => {
    if (refused) return;
    refused = true;
    options.logger.error("remote-host.certificate-refused", { url, presented });
    options.onRefused(certificateRefusalMessage(url, trust, presented, knownHosts.path));
  };
  if (trust.kind === "pinned") {
    options.session.setCertificateVerifyProc((request, callback) => {
      let presented: string;
      try { presented = certificateFingerprint(request.certificate.data); }
      catch { presented = "(unreadable)"; }
      const verdict = certificateVerdict(trust, request.hostname, presented);
      if (verdict === CERTIFICATE_REJECT) refuse(presented);
      callback(verdict);
    });
  }
  return { trust, ...(trust.kind === "pinned" ? { fingerprint: trust.fingerprint } : {}), refuse };
}

async function confirmCertificate(parent: BrowserWindow, hostKey: string, presented: PresentedCertificate): Promise<boolean> {
  const { response } = await dialog.showMessageBox(parent, {
    type: "warning",
    title: "Trust this host?",
    message: `Trust the host at ${hostKey}?`,
    detail: [
      "Its certificate is not signed by an authority this machine trusts, which is normal for a Tau host's own certificate.",
      "",
      `SHA-256: ${presented.fingerprint}`,
      "",
      "Compare it with the fingerprint the host printed when it started. Trust it only if they match: Tau then remembers it for this host and refuses any other certificate.",
    ].join("\n"),
    buttons: ["Trust and Connect", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return response === 0;
}
