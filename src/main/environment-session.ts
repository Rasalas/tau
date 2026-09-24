import type { Session } from "electron";
import { certificateFingerprint } from "./host-tls.js";

/** What the page's session needs to know about the saved machines; `WindowEnvironments` answers. */
export interface EnvironmentSessionPolicy {
  certificateVerdict(hostname: string, presentedFingerprint: string): number;
  isSavedSocket(url: string): boolean;
}

/**
 * Lets the workbench page reach saved machines from Chromium (ADR 0025): their
 * pinned certificates are accepted for their host names, and the page's own
 * sockets to them carry no `Origin`, which a host lets in over loopback only.
 */
export function installEnvironmentSession(session: Session, policy: EnvironmentSessionPolicy, pageId: () => number | undefined): void {
  session.setCertificateVerifyProc((request, callback) => {
    let presented: string;
    try { presented = certificateFingerprint(request.certificate.data); }
    catch { presented = "(unreadable)"; }
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
