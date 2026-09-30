import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseArgs, serviceAccountAssertion, uploadBundle } from "./play-upload.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ACCOUNT = {
  client_email: "tau-play-upload@tau-play-publishing.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  token_uri: "https://oauth2.googleapis.com/token",
};
const NOW = Date.UTC(2026, 8, 30, 12);
const APP = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/de.tbuck.tau";
const UPLOAD = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/de.tbuck.tau";

/** Google as far as the script sees it; `draftApp` answers a completed release like a never-published app does. */
function fakePlay({ bundles = [], draftApp = false, uploadedCode = 71600 } = {}) {
  const calls = [];
  const reply = (status, body) => ({ ok: status < 300, status, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
  const fetchUrl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, init });
    if (url === ACCOUNT.token_uri) return reply(200, { access_token: "ya29.token" });
    if (method === "POST" && url === `${APP}/edits`) return reply(200, { id: "e1" });
    if (method === "GET" && url === `${APP}/edits/e1/bundles`) return reply(200, { bundles });
    if (method === "DELETE" && url === `${APP}/edits/e1`) return reply(204);
    if (method === "POST" && url === `${UPLOAD}/edits/e1/bundles?uploadType=media`) return reply(200, { versionCode: uploadedCode, sha256: "x" });
    if (method === "PUT" && url === `${APP}/edits/e1/tracks/internal`) {
      const { releases } = JSON.parse(init.body);
      if (draftApp && releases[0].status !== "draft") return reply(400, { error: { message: "Only releases with status draft may be created on draft app." } });
      return reply(200, JSON.parse(init.body));
    }
    if (method === "POST" && url === `${APP}/edits/e1:commit`) return reply(200, { id: "e1" });
    return reply(404, { error: { message: `unexpected ${method} ${url}` } });
  };
  return { calls, fetchUrl };
}

const quiet = () => {};

describe("the service account's assertion", () => {
  it("is a JWT for the Play publisher scope, signed with the account's key", () => {
    const [header, claims, signature] = serviceAccountAssertion(ACCOUNT, NOW).split(".");
    expect(JSON.parse(Buffer.from(header, "base64url"))).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(claims, "base64url"))).toEqual({
      iss: ACCOUNT.client_email, scope: "https://www.googleapis.com/auth/androidpublisher", aud: ACCOUNT.token_uri, iat: NOW / 1000, exp: NOW / 1000 + 3600,
    });
    expect(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("refuses a key file that is not a service account's", () => {
    expect(() => serviceAccountAssertion({ type: "authorized_user" })).toThrow(/client_email or private_key/u);
  });
});

describe("an upload to Play", () => {
  it("uploads the bundle, releases it on the internal track and commits", async () => {
    const play = fakePlay();
    const bundle = Buffer.from("aab");
    expect(await uploadBundle({ account: ACCOUNT, bundle, version: "0.7.16", fetchUrl: play.fetchUrl, log: quiet, now: NOW })).toEqual({ uploaded: true, versionCode: 71600, status: "completed" });
    expect(play.calls.map((entry) => `${entry.method} ${entry.url.replace(/^https:\/\/[^/]+/u, "")}`)).toEqual([
      "POST /token",
      "POST /androidpublisher/v3/applications/de.tbuck.tau/edits",
      "GET /androidpublisher/v3/applications/de.tbuck.tau/edits/e1/bundles",
      "POST /upload/androidpublisher/v3/applications/de.tbuck.tau/edits/e1/bundles?uploadType=media",
      "PUT /androidpublisher/v3/applications/de.tbuck.tau/edits/e1/tracks/internal",
      "POST /androidpublisher/v3/applications/de.tbuck.tau/edits/e1:commit",
    ]);
    const upload = play.calls[3].init;
    expect(upload.body).toBe(bundle);
    expect(upload.headers).toMatchObject({ authorization: "Bearer ya29.token", "content-type": "application/octet-stream" });
    expect(JSON.parse(play.calls[4].init.body)).toEqual({ track: "internal", releases: [{ name: "0.7.16", versionCodes: ["71600"], status: "completed" }] });
  });

  it("leaves a versionCode Play already has alone", async () => {
    const play = fakePlay({ bundles: [{ versionCode: 71600 }] });
    expect(await uploadBundle({ account: ACCOUNT, bundle: Buffer.from("aab"), version: "0.7.16", fetchUrl: play.fetchUrl, log: quiet })).toEqual({ uploaded: false, versionCode: 71600 });
    expect(play.calls.at(-1)).toMatchObject({ method: "DELETE", url: `${APP}/edits/e1` });
    expect(play.calls.some((entry) => entry.url.startsWith(UPLOAD))).toBe(false);
  });

  it("makes a draft release while the app itself is still a draft", async () => {
    const play = fakePlay({ draftApp: true });
    const lines = [];
    expect(await uploadBundle({ account: ACCOUNT, bundle: Buffer.from("aab"), version: "0.7.16", fetchUrl: play.fetchUrl, log: (line) => lines.push(line) })).toMatchObject({ status: "draft" });
    expect(play.calls.at(-1).url).toBe(`${APP}/edits/e1:commit`);
    expect(lines[0]).toMatch(/as a draft/u);
  });

  it("stops when the bundle is not the version it was built as", async () => {
    const play = fakePlay({ uploadedCode: 71500 });
    await expect(uploadBundle({ account: ACCOUNT, bundle: Buffer.from("aab"), version: "0.7.16", fetchUrl: play.fetchUrl, log: quiet })).rejects.toThrow(/versionCode 71500, not 71600/u);
    expect(play.calls.some((entry) => entry.url.endsWith(":commit"))).toBe(false);
  });

  it("reads its arguments", () => {
    expect(parseArgs(["play/Tau-0.7.16.aab", "--version", "0.7.16"])).toEqual({ bundle: "play/Tau-0.7.16.aab", version: "0.7.16", track: "internal", packageName: "de.tbuck.tau" });
    expect(parseArgs(["x.aab", "--version", "1.0.0", "--track", "beta"]).track).toBe("beta");
    expect(() => parseArgs(["x.aab"])).toThrow(/usage/u);
    expect(() => parseArgs(["x.aab", "--version"])).toThrow(/needs a value/u);
  });
});
