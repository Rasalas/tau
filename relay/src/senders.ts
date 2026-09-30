import type { ApnsClient, ApnsRequest } from "../../kits/push/apns.js";
import type { Delivery, Sender } from "./relay.js";

/** The store app's bundle identifier; the relay pushes to no other app. */
export const APNS_TOPIC = "de.tbuck.tau";

/** What an iPhone shows until a Notification Service Extension can open the sealed text. */
export const GENERIC_ALERT = { title: "Tau", body: "A thread needs your attention" } as const;

/** Push time-to-live: a day later the news is stale. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** The part of firebase-admin's `Messaging` the relay uses. */
export interface MessagingPort {
  send(message: {
    token: string;
    data: Record<string, string>;
    android: { priority: "high"; ttl: number; collapseKey?: string };
  }): Promise<string>;
}

const GONE_FCM = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token"]);

/** FCM through firebase-admin: a data message the Android app opens and shows itself. */
export function fcmSender(messaging: MessagingPort): Sender {
  return async (token, { sealed, collapseId }): Promise<Delivery> => {
    try {
      await messaging.send({ token, data: { sealed }, android: { priority: "high", ttl: TTL_MS, ...(collapseId ? { collapseKey: collapseId } : {}) } });
      return { ok: true };
    } catch (error) {
      // Only the code: firebase-admin's message may repeat the token.
      const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "messaging/unknown";
      return { ok: false, gone: GONE_FCM.has(code), reason: code.replace(/^messaging\//u, "") };
    }
  };
}

/**
 * APNs over HTTP/2 with the team's .p8 key: a generic visible alert that the
 * app may rewrite (`mutable-content`), the sealed text in its own field.
 */
export function apnsSender(client: Pick<ApnsClient, "send">, topic = APNS_TOPIC): Sender {
  return async (token, { sealed, collapseId, activity }): Promise<Delivery> => {
    const request: ApnsRequest = {
      token,
      topic: activity ? `${topic}.push-type.liveactivity` : topic,
      ...(activity ? { pushType: "liveactivity" as const, expiration: activity.expiresAt } : {}),
      payload: activity ? { aps: { timestamp: activity.timestamp, event: activity.event, "content-state": { sealed }, "stale-date": activity.expiresAt, ...(activity.event === "end" ? { "dismissal-date": activity.expiresAt } : {}) } } : {
        aps: { alert: GENERIC_ALERT, sound: "default", "mutable-content": 1, ...(collapseId ? { "thread-id": collapseId } : {}) },
        sealed,
      },
      ...(collapseId ? { collapseId } : {}),
    };
    let outcome = await client.send(request, "production");
    // A build from Xcode has a sandbox token; production calls it a bad one.
    if (!outcome.ok && outcome.reason === "BadDeviceToken") outcome = await client.send(request, "sandbox");
    return outcome.ok ? { ok: true } : { ok: false, gone: outcome.gone, reason: outcome.reason };
  };
}
