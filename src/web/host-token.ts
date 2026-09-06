import type { ClientStorage } from "../workbench/client-storage";

/** Where a paired browser keeps the host's token. One host per origin, so one key. */
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

/**
 * Trades a single-use code for the host token. A refused code is not an error
 * to show: it usually means the link had already been opened once.
 */
export async function redeemPairingCode(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { token?: unknown };
    return typeof body.token === "string" && body.token.length > 0 ? body.token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The token this tab will say hello with: the one the link paired, else the one
 * a previous visit stored. Nothing else — a token typed into the paste field
 * comes back through `storage` on the reload that follows it.
 */
export async function resolveHostToken(
  storage: ClientStorage,
  code: string | undefined,
  fetchImpl?: typeof fetch,
): Promise<string | undefined> {
  if (code) {
    const paired = await redeemPairingCode(code, fetchImpl);
    if (paired) {
      storage.set(WEB_TOKEN_KEY, paired);
      return paired;
    }
  }
  return storage.get(WEB_TOKEN_KEY) ?? undefined;
}
