import { canonicalFingerprint, parsePairingPayload } from "../../shared/connections";
import { decodeConnectOffer } from "../../shared/managed-connections";

export interface BrowserConnectRoute { relay: string; id: string; token: string; url: string; pin: string; key: boolean }
export interface BrowserConnectSession { route: BrowserConnectRoute; token: string; name?: string }

export function browserConnectOffer(text: string): { route: BrowserConnectRoute; code: string; name?: string } | undefined {
  const offer = decodeConnectOffer(text.trim());
  if (!offer) return undefined;
  const payload = parsePairingPayload(offer.link);
  if (!payload || (!payload.publicKey && !payload.fingerprint)) return undefined;
  try {
    const url = new URL(offer.link); const relay = new URL(offer.relay);
    if (url.protocol !== "https:" || url.username || url.password || relay.search || relay.hash) return undefined;
    url.protocol = "wss:"; url.hash = "";
    return { route: { relay: relay.origin, id: offer.id, token: offer.token, url: url.href, pin: payload.publicKey ?? payload.fingerprint!, key: Boolean(payload.publicKey) }, code: payload.code, ...(payload.hostName ? { name: payload.hostName } : {}) };
  } catch { return undefined; }
}

export function validBrowserConnectSession(value: unknown): value is BrowserConnectSession {
  const session = value as BrowserConnectSession | undefined;
  if (!session || typeof session.token !== "string" || !session.token || typeof session.route?.key !== "boolean" || typeof session.route?.pin !== "string" || !canonicalFingerprint(session.route.pin)) return false;
  try {
    const { route } = session; const relay = new URL(route.relay); const url = new URL(route.url);
    return relay.protocol === "https:" && relay.origin === route.relay && url.protocol === "wss:" && !url.username && !url.password && !url.hash
      && /^[a-f0-9-]{36}$/u.test(route.id) && /^[A-Za-z0-9_-]{43}$/u.test(route.token);
  } catch { return false; }
}

export function browserRelayUrl(route: BrowserConnectRoute): string { return `${route.relay.replace(/^https:/u, "wss:")}/v1/browser/${route.id}`; }
