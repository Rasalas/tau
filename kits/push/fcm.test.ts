import { afterEach, describe, expect, it } from "vitest";
import { FcmClient, readServiceAccount } from "./fcm.js";
import { readSignedJwt, startFakeFcm, throwawayServiceAccount } from "../../src/main/test-support/push-fakes.js";

const closers: Array<() => unknown> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

const TOKEN = "fcm-token:APA91b-abcdefghijklmnop";
const MESSAGE = { notification: { title: "Fix the build", body: "Done." }, data: { url: "tau://thread?host=h&thread=t" } };

describe("FCM", () => {
  it("refuses what is not a service account, and a token endpoint that is not https", () => {
    expect(() => readServiceAccount("not json")).toThrow(/not JSON/u);
    expect(() => readServiceAccount(JSON.stringify({ type: "authorized_user" }))).toThrow(/service_account/u);
    const { json } = throwawayServiceAccount("http://example.com/token");
    expect(() => readServiceAccount(json)).toThrow(/https/u);
    const broken = JSON.stringify({ ...JSON.parse(throwawayServiceAccount("https://oauth2.googleapis.com/token").json), private_key: "secret-looking text" });
    expect(() => readServiceAccount(broken)).toThrow(/private_key/u);
    try { readServiceAccount(broken); } catch (error) { expect(String(error)).not.toContain("secret-looking"); }
  });

  it("trades a signed assertion for an access token, keeps it, and sends through the v1 API", async () => {
    const google = await startFakeFcm();
    closers.push(google.close);
    const { json, publicKey } = throwawayServiceAccount(google.tokenUri);
    const client = new FcmClient({ serviceAccount: json, origin: google.origin, now: () => 1_700_000_000_000 });
    await expect(client.send(TOKEN, MESSAGE)).resolves.toEqual({ ok: true });
    await expect(client.send(TOKEN, MESSAGE)).resolves.toEqual({ ok: true });
    const [grant, first, second] = google.requests;
    expect(google.requests.filter((request) => request.path === "/token")).toHaveLength(1);
    const form = new URLSearchParams(grant!.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(readSignedJwt(form.get("assertion")!, publicKey, false)).toEqual({
      header: { alg: "RS256", typ: "JWT" },
      claims: { iss: "push@tau-test-project.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/firebase.messaging", aud: google.tokenUri, iat: 1_700_000_000, exp: 1_700_003_600 },
    });
    expect(first!.path).toBe("/v1/projects/tau-test-project/messages:send");
    expect(first!.headers.authorization).toBe("Bearer fake-access-1");
    expect(JSON.parse(first!.body)).toEqual({ message: { token: TOKEN, ...MESSAGE } });
    expect(second!.headers.authorization).toBe("Bearer fake-access-1");
  });

  it("says a token is gone when FCM calls it unregistered, and asks for a new access token after a 401", async () => {
    let sends = 0;
    const google = await startFakeFcm((request) => {
      sends += 1;
      if (request.body.includes("dead")) return { status: 404, body: { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } } };
      return sends === 2 ? { status: 401, body: { error: { status: "UNAUTHENTICATED" } } } : { status: 200, body: {} };
    });
    closers.push(google.close);
    const client = new FcmClient({ serviceAccount: throwawayServiceAccount(google.tokenUri).json, origin: google.origin });
    await expect(client.send(`${TOKEN}dead`, MESSAGE)).resolves.toEqual({ ok: false, gone: true, status: 404, reason: "UNREGISTERED" });
    await expect(client.send(TOKEN, MESSAGE)).resolves.toEqual({ ok: true });
    expect(google.requests.filter((request) => request.path === "/token")).toHaveLength(2);
  });
});
