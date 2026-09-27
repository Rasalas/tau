import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ApnsClient, readApnsKey } from "./apns.js";
import { readSignedJwt, startFakeApns, throwawayApnsKey } from "../../src/main/test-support/push-fakes.js";

const closers: Array<() => unknown> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

const TOKEN = "a".repeat(64);
const CREDENTIALS = { keyId: "ABC123DEFG", teamId: "TEAM123456" };

describe("APNs", () => {
  it("refuses a key that is not an EC P-256 key, without repeating it", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => readApnsKey({ ...CREDENTIALS, key: rsa })).toThrow(/EC P-256/u);
    expect(() => readApnsKey({ ...CREDENTIALS, key: "secret-looking text" })).toThrow(/not a \.p8 key/u);
    try { readApnsKey({ ...CREDENTIALS, key: "secret-looking text" }); } catch (error) { expect(String(error)).not.toContain("secret-looking"); }
    expect(() => readApnsKey({ ...CREDENTIALS, keyId: "short", key: rsa })).toThrow(/Key ID/u);
  });

  it("signs an ES256 provider token Apple can verify and posts the alert to the device", async () => {
    const { pem, publicKey } = throwawayApnsKey();
    const apple = await startFakeApns();
    closers.push(apple.close);
    const client = new ApnsClient({ credentials: { ...CREDENTIALS, key: pem }, origin: () => apple.origin, now: () => 1_700_000_000_000 });
    closers.push(() => client.close());
    const payload = { aps: { alert: { title: "Fix the build", body: "Done." } }, url: "tau://thread?host=h&thread=t" };
    await expect(client.send({ token: TOKEN, topic: "de.tbuck.tau", payload, collapseId: "t" }, "production")).resolves.toEqual({ ok: true });
    const [request] = apple.requests;
    expect(request!.path).toBe(`/3/device/${TOKEN}`);
    expect(request!.headers).toMatchObject({ ":method": "POST", "apns-topic": "de.tbuck.tau", "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": "t" });
    expect(JSON.parse(request!.body)).toEqual(payload);
    const jwt = request!.headers.authorization!.replace(/^bearer /u, "");
    expect(readSignedJwt(jwt, publicKey, true)).toEqual({ header: { alg: "ES256", kid: "ABC123DEFG" }, claims: { iss: "TEAM123456", iat: 1_700_000_000 } });
  });

  it("keeps its provider token for fifty minutes, then signs a new one", async () => {
    const { pem } = throwawayApnsKey();
    const apple = await startFakeApns();
    closers.push(apple.close);
    let now = 1_700_000_000_000;
    const client = new ApnsClient({ credentials: { ...CREDENTIALS, key: pem }, origin: () => apple.origin, now: () => now });
    closers.push(() => client.close());
    const send = () => client.send({ token: TOKEN, topic: "a.b", payload: {} }, "sandbox");
    await send();
    now += 49 * 60_000;
    await send();
    now += 2 * 60_000;
    await send();
    const tokens = apple.requests.map((entry) => entry.headers.authorization);
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[2]).not.toBe(tokens[1]);
  });

  it("says a token is gone when Apple says so, and retries once with a fresh provider token", async () => {
    const { pem } = throwawayApnsKey();
    let calls = 0;
    const apple = await startFakeApns((request) => {
      calls += 1;
      if (request.path.endsWith("dead")) return { status: 410, reason: "Unregistered" };
      return calls === 2 ? { status: 403, reason: "ExpiredProviderToken" } : { status: 200 };
    });
    closers.push(apple.close);
    const client = new ApnsClient({ credentials: { ...CREDENTIALS, key: pem }, origin: () => apple.origin });
    closers.push(() => client.close());
    await expect(client.send({ token: `${TOKEN}dead`, topic: "a.b", payload: {} }, "production")).resolves.toEqual({ ok: false, gone: true, status: 410, reason: "Unregistered" });
    await expect(client.send({ token: TOKEN, topic: "a.b", payload: {} }, "production")).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it("reports an unreachable service as a failure, not a gone device", async () => {
    const { pem } = throwawayApnsKey();
    const client = new ApnsClient({ credentials: { ...CREDENTIALS, key: pem }, origin: () => "http://127.0.0.1:9" });
    closers.push(() => client.close());
    await expect(client.send({ token: TOKEN, topic: "a.b", payload: {} }, "production")).resolves.toMatchObject({ ok: false, gone: false, status: 0 });
  });
});
