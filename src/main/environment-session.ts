import { X509Certificate } from "node:crypto";
import type { Session } from "electron";
import { CERTIFICATE_REJECT, presentedIdentity, type PresentedIdentity } from "./host-tls-trust.js";

/** What the page's session needs to know about the saved machines; `WindowEnvironments` answers. */
export interface EnvironmentSessionPolicy {
  certificateVerdict(hostname: string, presented: PresentedIdentity): number;
  isSavedSocket(url: string): boolean;
}

/**
 * Lets the workbench page reach saved machines from Chromium (ADR 0025): their
 * pinned keys are accepted for their host names, and the page's own
 * sockets to them carry no `Origin`, which a host lets in over loopback only.
 */
export function installEnvironmentSession(session: Session, policy: EnvironmentSessionPolicy, pageId: () => number | undefined): void {
  session.setCertificateVerifyProc((request, callback) => {
    let presented: PresentedIdentity;
    try { presented = presentedIdentity(new X509Certificate(request.certificate.data)); }
    catch { callback(CERTIFICATE_REJECT); return; }
    callback(policy.certificateVerdict(request.hostname, presented));
  });
  session.webRequest.onBeforeSendHeaders({ urls: ["ws://*/*", "wss://*/*"] }, (details, callback) => {
    if (details.webContentsId === undefined || details.webContentsId !== pageId() || !policy.isSavedSocket(details.url)) {
      callback({});
      return;
    }
    callback({ requestHeaders: withoutOrigin(details.requestHeaders) });
  });
}

export function withoutOrigin(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "origin"));
}
