import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseKeyring, sealHandle } from "./handle.js";
import { HANDLE_MAX_AGE_MS, createRelay, type Delivery, type RelayRequest } from "./relay.js";

const IOS_TOKEN = "ab".repeat(32);
const ANDROID_TOKEN = "fcm:APA91b-registration-token";
const SEALED = `1.${"k".repeat(22)}.${randomBytes(200).toString("base64url")}`;

function relay(options: { answer?: Delivery; ios?: boolean } = {}) {
  let now = 1_700_000_000_000;
  const log = vi.fn();
  const android = vi.fn(async () => options.answer ?? { ok: true } as Delivery);
  const ios = vi.fn(async () => options.answer ?? { ok: true } as Delivery);
  const ring = parseKeyring(`1:${randomBytes(32).toString("base64")}`);
  const handle = createRelay({ keyring: ring, senders: { android, ...(options.ios === false ? {} : { ios }) }, log, now: () => now });
  const call = async (path: string, body: unknown, extra: Partial<RelayRequest> = {}) => {
    const response = await handle({ method: "POST", path, body: body === undefined || typeof body === "string" ? body : Buffer.from(JSON.stringify(body)), ip: "203.0.113.7", ...extra });
    return { ...response, json: response.body ? JSON.parse(response.body) as Record<string, unknown> : undefined };
  };
  const register = async (platform: string, token: string) => (await call("/register", { platform, token })).json!.handle as string;
  return { call, register, android, ios, log, ring, tick: (ms: number) => { now += ms; } };
}

describe("the push relay", () => {
  it("turns a phone's token into a handle and a host's handle into a push", async () => {
    const { call, register, android, ios } = relay();
    const registered = await call("/register", { platform: "android", token: ANDROID_TOKEN });
    expect(registered.status).toBe(200);
    expect(registered.headers["access-control-allow-origin"]).toBe("*");
    const handle = registered.json!.handle as string;
    expect(handle).not.toContain(ANDROID_TOKEN);
    const sent = await call("/send", { handle, payload: SEALED, collapseId: "c0llapse" });
    expect(sent).toMatchObject({ status: 200, json: { ok: true } });
    expect(android).toHaveBeenCalledWith(ANDROID_TOKEN, { sealed: SEALED, collapseId: "c0llapse" });
    await call("/send", { handle: await register("ios", IOS_TOKEN), payload: SEALED });
    expect(ios).toHaveBeenCalledWith(IOS_TOKEN, { sealed: SEALED });
  });

  it("answers the web view's preflight for /register, and only there", async () => {
    const { call } = relay();
    const preflight = await call("/register", undefined, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-headers"]).toBe("content-type");
    expect((await call("/send", undefined, { method: "OPTIONS" })).status).toBe(405);
    expect((await call("/register", undefined, { method: "GET" })).status).toBe(405);
    expect((await call("/tokens", {})).status).toBe(404);
  });

  it("checks format and size before anything reaches FCM or APNs", async () => {
    const { call, register, android } = relay();
    expect((await call("/register", { platform: "ios", token: "nope" })).status).toBe(400);
    expect((await call("/register", { platform: "web", token: ANDROID_TOKEN })).status).toBe(400);
    expect((await call("/register", "not json")).status).toBe(400);
    const handle = await register("android", ANDROID_TOKEN);
    expect((await call("/send", { handle, payload: "x".repeat(3073) })).status).toBe(400);
    expect((await call("/send", { handle, payload: "<script>" })).status).toBe(400);
    expect((await call("/send", { handle, payload: SEALED, collapseId: "c".repeat(65) })).status).toBe(400);
    expect((await call("/send", JSON.stringify({ handle, payload: "x".repeat(9000) }))).status).toBe(413);
    expect(android).not.toHaveBeenCalled();
  });

  it("says gone for a handle it cannot open and for a token FCM or APNs dropped", async () => {
    const other = relay();
    const foreign = await other.register("android", ANDROID_TOKEN);
    const { call, register } = relay({ answer: { ok: false, gone: true, reason: "registration-token-not-registered" } });
    expect(await call("/send", { handle: foreign, payload: SEALED })).toMatchObject({ status: 410, json: { error: "gone", reason: "unknown-handle" } });
    const handle = await register("android", ANDROID_TOKEN);
    expect(await call("/send", { handle, payload: SEALED })).toMatchObject({ status: 410, json: { error: "gone", reason: "registration-token-not-registered" } });
  });

  it("says gone for a handle older than 60 days", async () => {
    const { call, register, tick, android } = relay();
    const handle = await register("android", ANDROID_TOKEN);
    tick(HANDLE_MAX_AGE_MS);
    expect((await call("/send", { handle, payload: SEALED })).status).toBe(200);
    tick(1_000);
    expect(await call("/send", { handle, payload: SEALED })).toMatchObject({ status: 410, json: { error: "gone", reason: "expired-handle" } });
    expect(android).toHaveBeenCalledOnce();
  });

  it("reports a failure upstream as such, and iPhones as unavailable until APNs is set up", async () => {
    const failing = relay({ answer: { ok: false, gone: false, reason: "TooManyProviderTokenUpdates" } });
    expect(await failing.call("/send", { handle: await failing.register("ios", IOS_TOKEN), payload: SEALED })).toMatchObject({ status: 502, json: { error: "upstream", reason: "TooManyProviderTokenUpdates" } });
    const noApns = relay({ ios: false });
    expect(await noApns.call("/send", { handle: await noApns.register("ios", IOS_TOKEN), payload: SEALED })).toMatchObject({ status: 503, json: { reason: "apns-not-configured" } });
  });

  it("limits sends per handle and registrations per address", async () => {
    const { call, register, tick } = relay();
    const handle = await register("android", ANDROID_TOKEN);
    // Each call takes from the bucket before its first await, in order.
    const burst = await Promise.all(Array.from({ length: 30 }, () => call("/send", { handle, payload: SEALED })));
    expect(burst.every((response) => response.status === 200)).toBe(true);
    const limited = await call("/send", { handle, payload: SEALED });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // Another handle is not held up.
    expect((await call("/send", { handle: await register("ios", IOS_TOKEN), payload: SEALED })).status).toBe(200);
    tick(6_000);
    expect((await call("/send", { handle, payload: SEALED })).status).toBe(200);
    await Promise.all(Array.from({ length: 8 }, () => call("/register", { platform: "ios", token: IOS_TOKEN })));
    expect((await call("/register", { platform: "ios", token: IOS_TOKEN })).status).toBe(429);
    expect((await call("/register", { platform: "ios", token: IOS_TOKEN }, { ip: "198.51.100.1" })).status).toBe(200);
  });

  it("limits sends per phone too, however many handles it has", async () => {
    const { call, ring, tick } = relay();
    // Handles minted straight from the keyring: the register limit would stop these first.
    const handles = Array.from({ length: 3 }, () => sealHandle(ring, { platform: "android", token: ANDROID_TOKEN }, 1_700_000_000_000));
    const burst = await Promise.all(handles.flatMap((handle) => Array.from({ length: 20 }, () => call("/send", { handle, payload: SEALED }))));
    expect(burst.every((response) => response.status === 200)).toBe(true);
    const fourth = sealHandle(ring, { platform: "android", token: ANDROID_TOKEN }, 1_700_000_000_000);
    expect((await call("/send", { handle: fourth, payload: SEALED })).status).toBe(429);
    tick(3_000);
    expect((await call("/send", { handle: fourth, payload: SEALED })).status).toBe(200);
  });

  it("logs events and codes, never a token, handle, payload or address", async () => {
    const { call, register, log } = relay({ answer: { ok: false, gone: false, reason: "internal-error" } });
    const handle = await register("android", ANDROID_TOKEN);
    await call("/send", { handle, payload: SEALED });
    const logged = JSON.stringify(log.mock.calls);
    expect(log).toHaveBeenCalledWith("send", { platform: "android", ok: false, reason: "internal-error", gone: false });
    for (const secret of [ANDROID_TOKEN, handle, SEALED, "203.0.113.7"]) expect(logged).not.toContain(secret);
  });
});
