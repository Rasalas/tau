import { afterEach, describe, expect, it, vi } from "vitest";
import { ApnsClient } from "../../kits/push/apns.js";
import { startFakeApns, throwawayApnsKey } from "../../src/main/test-support/push-fakes.js";
import { APNS_TOPIC, GENERIC_ALERT, apnsSender, fcmSender, type MessagingPort } from "./senders.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

const SEALED = "1.kkkkkkkkkkkkkkkkkkkkkk.c2VhbGVk";

describe("the relay's senders", () => {
  it("hand FCM a high-priority data message with nothing readable in it", async () => {
    const send = vi.fn<MessagingPort["send"]>(async () => "projects/tau-push-e3c95/messages/1");
    await expect(fcmSender({ send })("fcm-token", { sealed: SEALED, collapseId: "tag" })).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith({ token: "fcm-token", data: { sealed: SEALED }, android: { priority: "high", ttl: 86_400_000, collapseKey: "tag" } });
  });

  it("call a token FCM no longer knows gone, and keep firebase-admin's message out", async () => {
    const failing = (code: string) => fcmSender({ send: async () => { throw Object.assign(new Error("Requested entity was not found for token fcm-token"), { code }); } });
    await expect(failing("messaging/registration-token-not-registered")("fcm-token", { sealed: SEALED })).resolves.toEqual({ ok: false, gone: true, reason: "registration-token-not-registered" });
    await expect(failing("messaging/internal-error")("fcm-token", { sealed: SEALED })).resolves.toEqual({ ok: false, gone: false, reason: "internal-error" });
  });

  it("send APNs a generic alert the app may rewrite, and try the sandbox for a development build's token", async () => {
    const production = await startFakeApns(() => ({ status: 400, reason: "BadDeviceToken" }));
    const sandbox = await startFakeApns();
    cleanups.push(production.close, sandbox.close);
    const client = new ApnsClient({
      credentials: { keyId: "ABC123DEFG", teamId: "TEAM123456", key: throwawayApnsKey().pem },
      origin: (environment) => (environment === "production" ? production.origin : sandbox.origin),
    });
    cleanups.push(() => client.close());
    await expect(apnsSender(client)("ab".repeat(32), { sealed: SEALED, collapseId: "tag" })).resolves.toEqual({ ok: true });
    expect(production.requests).toHaveLength(1);
    const [request] = sandbox.requests;
    expect(request!.headers["apns-topic"]).toBe(APNS_TOPIC);
    expect(request!.headers["apns-collapse-id"]).toBe("tag");
    expect(JSON.parse(request!.body)).toEqual({ aps: { alert: GENERIC_ALERT, sound: "default", "mutable-content": 1, "thread-id": "tag" }, sealed: SEALED });
  });

  it("call a token APNs dropped gone", async () => {
    const apple = await startFakeApns(() => ({ status: 410, reason: "Unregistered" }));
    cleanups.push(apple.close);
    const client = new ApnsClient({ credentials: { keyId: "ABC123DEFG", teamId: "TEAM123456", key: throwawayApnsKey().pem }, origin: () => apple.origin });
    cleanups.push(() => client.close());
    await expect(apnsSender(client)("ab".repeat(32), { sealed: SEALED })).resolves.toEqual({ ok: false, gone: true, reason: "Unregistered" });
  });
});

it("sends ciphertext as ActivityKit content-state with its own token/topic and no visible alert", async () => {
  const send = vi.fn(async () => ({ ok: true as const }));
  const activity = { event: "end" as const, timestamp: 1_700_000_000, expiresAt: 1_700_000_900 };
  await apnsSender({ send })("activity-token", { sealed: SEALED, activity });
  expect(send).toHaveBeenCalledWith({ token: "activity-token", topic: `${APNS_TOPIC}.push-type.liveactivity`, pushType: "liveactivity", expiration: activity.expiresAt, payload: { aps: { timestamp: activity.timestamp, event: "end", "content-state": { sealed: SEALED }, "stale-date": activity.expiresAt, "dismissal-date": activity.expiresAt } } }, "production");
});

it("constructs push-to-start with only opaque attributes and a generic alert", async () => {
  const send = vi.fn(async () => ({ ok: true as const }));
  const sender = apnsSender({ send });
  await sender("ab".repeat(32), { sealed: "2.key.cipher", activity: { event: "start", inputPushToken: true, timestamp: 1700000000, expiresAt: 1700000900, activityId: "a".repeat(22), bootstrap: "2.key.cipher" } });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ topic: "de.tbuck.tau.push-type.liveactivity", pushType: "liveactivity", expiration: 1700000060,
    payload: { aps: { timestamp: 1700000000, event: "start", "content-state": { sealed: "2.key.cipher" }, "stale-date": 1700000900, "attributes-type": "TauActivityAttributes", attributes: { activityId: "a".repeat(22), bootstrap: "2.key.cipher" }, alert: { title: "Tau", body: "Agent work started" }, "input-push-token": 1 } } }), "production");
});
