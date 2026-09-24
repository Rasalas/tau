import type { HostClient } from "../../src/workbench/host-client";
import type { SavedHost } from "./hosts";
import { linkRoute, type AppRoute } from "./routes";

/**
 * Push notifications (F08). The app calls `register` once a host's workbench
 * is connected; the registrar asks the platform for an APNs or FCM token and
 * hands it to that host's Push Kit, which sends directly with the user's own
 * keys (plan, decision 3). A tap on a notification opens its
 * `tau://thread?host=…&thread=…` link.
 */
export interface PushRegistrar {
  register(context: { host: SavedHost; client: Pick<HostClient, "invokeHostExtension"> }): Promise<PushRegistration>;
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

export function createPushRegistrar(port: PushPort): PushRegistrar {
  let token: Promise<string> | undefined;
  return {
    async register({ host, client }) {
      if (!(await port.available())) return { state: "unavailable" };
      let permission = await port.permission();
      // Asked once, from the first host the phone opens; iOS and Android remember the answer.
      if (permission === "prompt") permission = await port.requestPermission();
      if (permission !== "granted") return { state: "denied" };
      token ??= port.token().catch((error: unknown) => { token = undefined; throw error; });
      const [value, topic] = await Promise.all([token, port.topic()]);
      try {
        await client.invokeHostExtension(PUSH_KIT, "register", { platform: port.platform, token: value, host: host.id, ...(topic ? { topic } : {}) });
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

let registrar: PushRegistrar | undefined;

export function setPushRegistrar(next: PushRegistrar | undefined): void {
  registrar = next;
}

export function pushRegistrar(): PushRegistrar | undefined {
  return registrar;
}
