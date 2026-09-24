import type { PairingResult } from "../workbench/host-pairing";

/** Where a paired browser keeps its token: its own after pairing, or the host token its owner pasted. One host per origin, so one key. */
export const WEB_TOKEN_KEY = "tau.web.host-token";

export interface PairingPage {
  location: { hash: string; pathname: string; search: string; protocol: string; host: string };
  history: { replaceState(state: unknown, title: string, url: string): void };
}

/**
 * Takes the pairing code out of the address bar and puts the address back
 * without it. The code lives in the fragment, so it never reached the server;
 * this makes sure it does not outlive the handshake in a bookmark, a
 * screenshot or a link the user pastes to someone else.
 */
export function takePairingCode(page: PairingPage): string | undefined {
  const code = new URLSearchParams(page.location.hash.replace(/^#/u, "")).get("pair");
  if (!code) return undefined;
  page.history.replaceState(null, "", `${page.location.pathname}${page.location.search}`);
  return code;
}

/** The host that served this page is the host this page talks to. */
export function hostSocketUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/`;
}

/** What the page says when pairing did not let it in. */
export function pairingNotice(result: Exclude<PairingResult, { state: "approved" }>): string {
  switch (result.state) {
    case "denied": return "The host’s owner declined this device.";
    case "expired": return "Nobody answered on the host in time. Try again, and allow the device there.";
    case "refused":
      if (result.reason === "unknown-code") return "This pairing link was already used or has expired. Ask for a new one.";
      if (result.reason === "busy") return "The host has other requests waiting. Try again in a few minutes.";
      if (result.reason === "rate-limited") return "Too many attempts from this device. Wait a moment and try again.";
      return "The host did not understand the request.";
    case "failed": return result.message;
  }
}
