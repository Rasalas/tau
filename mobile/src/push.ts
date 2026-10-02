import { PUSH_RELAY_URL, type PushRegisterAnswer, type PushRelayRegistration } from "../../kits/push/protocol";
import type { HostClient } from "../../src/workbench/host-client";
import type { SavedHost } from "./hosts";
import { openSealedPush } from "./push-crypto";
import type { PushKeys } from "./push-keys";
import { linkRoute, type AppRoute } from "./routes";

/**
 * Push notifications (F08). The app calls `register` once a host's workbench
 * is connected; the registrar asks the platform for an APNs or FCM token, asks
 * Tau's relay to seal it into a handle for that host alone, and hands the
 * handle to the host's Push Kit with a key for that host alone. The token goes
 * to the host only when it sends with keys of its own and asks for it
 * (docs/push.md). A tap on a notification opens its `tau://thread?host=…&thread=…` link.
 */
export interface PushRegistrar {
  register(context: { host: SavedHost; client: Pick<HostClient, "invokeHostExtension"> }): Promise<PushRegistration>;
  /** The phone forgot the host: its pushes no longer open here. */
  forget(hostId: string): Promise<void>;
}

/** Tau's relay: seals this phone's token into a handle. `push-native.ts` has the real one. */
export interface PushRelayPort {
  register(platform: "ios" | "android", token: string): Promise<string>;
}

export type PushRegistration =
  | { state: "registered" }
  /** `unavailable`: an Android build without a Firebase project; `denied`: the user said no; `refused`: the host would not take it. */
  | { state: "unavailable" | "denied" | "refused"; detail?: string };

/** What the registrar needs of the platform; `push-native.ts` is the real one. */
export interface PushPort {
  platform: "ios" | "android";
  available(): Promise<boolean>;
  permission(): Promise<"granted" | "denied" | "prompt">;
  requestPermission(): Promise<"granted" | "denied">;
  /** The device token, once the platform handed it out. */
  token(): Promise<string>;
  /** iOS: the bundle identifier, the APNs topic. */
  topic(): Promise<string | undefined>;
  onTap(listener: (data: Record<string, unknown>) => void): () => void;
}

const PUSH_KIT = "tau.push";
const RELAY_TIMEOUT_MS = 10_000;
const HANDLE = /^[A-Za-z0-9_-]{40,6000}$/u;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The relay refuses a handle after 60 days; the app renews a host's at half that. */
const HANDLE_RENEW_MS = 30 * DAY_MS;
const HANDLE_MAX_AGE_MS = 60 * DAY_MS;
/** A host older than the relay refuses a registration without a token; it only sends with keys of its own. */
const PRE_RELAY_HOST = /not an (?:APNs device|FCM registration) token/u;

/** `POST <relay>/register` from the web view; index.html's CSP lets it reach the relay and nothing else. */
export function createRelayPort(url = PUSH_RELAY_URL, fetcher: typeof fetch = (...args) => fetch(...args)): PushRelayPort {
  return {
    async register(platform, token) {
      const response = await fetcher(`${url}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform, token }),
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
      const body = await response.json().catch(() => ({})) as { handle?: unknown; error?: unknown };
      if (!response.ok || typeof body.handle !== "string" || !HANDLE.test(body.handle)) throw new Error(`Tau's relay refused the token (${typeof body.error === "string" ? body.error : `HTTP ${response.status}`}).`);
      return body.handle;
    },
  };
}

export function createPushRegistrar(port: PushPort, options: { relay?: PushRelayPort; keys?: PushKeys; now?(): number; onRoute?(hostId: string, route: "direct" | "relay"): void } = {}): PushRegistrar {
  const now = options.now ?? Date.now;
  let token: Promise<string> | undefined;
  /** A host's own handle, kept across runs; renewed when it ages, the token changes or the host asks. */
  const handleFor = async (relay: PushRelayPort, keys: PushKeys, hostId: string, value: string, renew: boolean): Promise<string | undefined> => {
    const saved = await keys.handle(hostId);
    const current = saved?.token === value && !renew ? saved : undefined;
    if (current && now() - current.at < HANDLE_RENEW_MS) return current.handle;
    try {
      const handle = await relay.register(port.platform, value);
      await keys.saveHandle(hostId, { handle, token: value, at: now() });
      return handle;
    } catch {
      // Out of reach: the saved one still works until the relay's 60 days are up.
      return current && now() - current.at < HANDLE_MAX_AGE_MS ? current.handle : undefined;
    }
  };
  /** Without the relay the host can still send with keys of its own. */
  const relayFor = async (host: SavedHost, value: string, renew = false): Promise<PushRelayRegistration | undefined> => {
    const { relay, keys } = options;
    if (!relay || !keys) return undefined;
    try {
      const [handle, key] = await Promise.all([handleFor(relay, keys, host.id, value, renew), keys.forHost(host.id)]);
      return handle ? { handle, ...key } : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    forget: async (hostId) => { await options.keys?.forget(hostId); },
    async register({ host, client }) {
      if (!(await port.available())) return { state: "unavailable" };
      let permission = await port.permission();
      // Asked once, from the first host the phone opens; iOS and Android remember the answer.
      if (permission === "prompt") permission = await port.requestPermission();
      if (permission !== "granted") return { state: "denied" };
      token ??= port.token().catch((error: unknown) => { token = undefined; throw error; });
      const [value, topic] = await Promise.all([token, port.topic()]);
      const call = async (relay: PushRelayRegistration | undefined, withToken: boolean) => await client.invokeHostExtension(PUSH_KIT, "register", {
        platform: port.platform,
        ...(withToken ? { token: value } : {}),
        host: host.id,
        ...(topic ? { topic } : {}),
        ...(relay ? { relay } : {}),
      }) as Partial<PushRegisterAnswer> | undefined;
      try {
        let relay = await relayFor(host, value);
        let answer = await call(relay, false).catch((error: unknown) => {
          if (error instanceof Error && PRE_RELAY_HOST.test(error.message)) return call(undefined, true);
          throw error;
        });
        if (answer?.renewHandle) {
          relay = await relayFor(host, value, true);
          answer = await call(relay, false);
        }
        if (answer?.needsToken) await call(relay, true);
        if (answer?.route === "direct" || answer?.route === "relay") options.onRoute?.(host.id, answer.route);
        return { state: "registered" };
      } catch (error) {
        // A host without Push Kit, or a Read-only device: the app works as before.
        return { state: "refused", detail: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/** A tapped notification's link, if it is one of ours. */
export function tapRoute(data: Record<string, unknown>): AppRoute | undefined {
  return typeof data.url === "string" ? linkRoute(data.url) : undefined;
}

/** A tapped relay push (iOS shows it generic): its link is in the sealed text. */
export async function sealedTapRoute(data: Record<string, unknown>, keys: Pick<PushKeys, "key">): Promise<AppRoute | undefined> {
  const opened = await openSealedPush(data.sealed, (keyId) => keys.key(keyId));
  return opened?.url ? linkRoute(opened.url) : undefined;
}

let registrar: PushRegistrar | undefined;

export function setPushRegistrar(next: PushRegistrar | undefined): void {
  registrar = next;
}

export function pushRegistrar(): PushRegistrar | undefined {
  return registrar;
}
