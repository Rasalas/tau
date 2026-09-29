#!/usr/bin/env node
// Uploads an Android App Bundle to a Google Play track through the Play
// Developer API, with a service account's JSON key from the environment.
// Plain REST and node:crypto, so the release job needs no npm install.
//
//   PLAY_SERVICE_ACCOUNT_JSON='{…}' node scripts/packaging/play-upload.mjs <app.aab> --version <1.2.3> [--track internal] [--package de.tbuck.tau]
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { androidVersionCode } from "./mobile-version.mjs";
import { isMain, main } from "./release.mjs";

export const PACKAGE_NAME = "de.tbuck.tau";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const UPLOAD_API = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications";

const base64url = (value) => Buffer.from(value).toString("base64url");

/** The signed JWT a service account trades for an access token (RFC 7523). */
export function serviceAccountAssertion(account, now = Date.now()) {
  if (!account?.client_email || !account?.private_key) throw new Error("The service account JSON lacks client_email or private_key.");
  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: account.token_uri ?? "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 }));
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(account.private_key).toString("base64url");
  return `${header}.${claims}.${signature}`;
}

async function call(fetchUrl, url, init, what) {
  const response = await fetchUrl(url, init);
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`${what} failed (${response.status}): ${text.slice(0, 500)}`), { status: response.status, body: text });
  return text ? JSON.parse(text) : {};
}

export async function accessToken(account, { fetchUrl = fetch, now } = {}) {
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountAssertion(account, now) });
  const answer = await call(fetchUrl, account.token_uri ?? "https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, "The token request");
  if (!answer.access_token) throw new Error("Google answered the token request without an access token.");
  return answer.access_token;
}

/**
 * One edit: skips a bundle whose versionCode Play already has (a re-run),
 * otherwise uploads it, puts it on `track` and commits. An app Play still
 * holds as a draft takes only draft releases; those are then made instead.
 * Returns what happened, for the job's summary.
 */
export async function uploadBundle({ account, bundle, version, track = "internal", packageName = PACKAGE_NAME, fetchUrl = fetch, log = console.log, now }) {
  const versionCode = androidVersionCode(version);
  const token = await accessToken(account, { fetchUrl, now });
  const auth = { authorization: `Bearer ${token}` };
  const app = `${API}/${encodeURIComponent(packageName)}`;
  const edit = await call(fetchUrl, `${app}/edits`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" }, "Opening an edit");
  const editUrl = `${app}/edits/${encodeURIComponent(edit.id)}`;
  const { bundles = [] } = await call(fetchUrl, `${editUrl}/bundles`, { headers: auth }, "Listing the bundles");
  if (bundles.some((entry) => Number(entry.versionCode) === versionCode)) {
    await call(fetchUrl, editUrl, { method: "DELETE", headers: auth }, "Closing the edit");
    log(`Play already has versionCode ${versionCode} (${version}); nothing uploaded.`);
    return { uploaded: false, versionCode };
  }
  const uploaded = await call(fetchUrl, `${UPLOAD_API}/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(edit.id)}/bundles?uploadType=media`, {
    method: "POST", headers: { ...auth, "content-type": "application/octet-stream" }, body: bundle,
  }, "Uploading the bundle");
  if (Number(uploaded.versionCode) !== versionCode) throw new Error(`The bundle is versionCode ${uploaded.versionCode}, not ${versionCode} for ${version}.`);
  const release = (status) => ({ method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ track, releases: [{ name: version, versionCodes: [String(versionCode)], status }] }) });
  let status = "completed";
  try {
    await call(fetchUrl, `${editUrl}/tracks/${encodeURIComponent(track)}`, release(status), `Putting ${version} on ${track}`);
  } catch (error) {
    if (!/draft app/iu.test(error.body ?? "")) throw error;
    status = "draft";
    await call(fetchUrl, `${editUrl}/tracks/${encodeURIComponent(track)}`, release(status), `Putting ${version} on ${track} as a draft`);
  }
  await call(fetchUrl, `${editUrl}:commit`, { method: "POST", headers: auth }, "Committing the edit");
  log(status === "draft"
    ? `Uploaded ${version} (versionCode ${versionCode}) to ${track} as a draft: the app is still a draft in Play, so roll it out in the Play Console.`
    : `Uploaded ${version} (versionCode ${versionCode}) to ${track}.`);
  return { uploaded: true, versionCode, status };
}

export function parseArgs(argv) {
  const options = { bundle: undefined, version: undefined, track: "internal", packageName: PACKAGE_NAME };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--version") options.version = value();
    else if (arg === "--track") options.track = value();
    else if (arg === "--package") options.packageName = value();
    else if (!arg.startsWith("--") && !options.bundle) options.bundle = arg;
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (!options.bundle || !options.version) throw new Error("usage: play-upload.mjs <app.aab> --version <1.2.3> [--track internal] [--package de.tbuck.tau]");
  return options;
}

if (isMain(import.meta.url)) {
  main(async () => {
    const options = parseArgs(process.argv.slice(2));
    const json = process.env.PLAY_SERVICE_ACCOUNT_JSON;
    if (!json) throw new Error("PLAY_SERVICE_ACCOUNT_JSON is not set.");
    await uploadBundle({ ...options, account: JSON.parse(json), bundle: readFileSync(options.bundle) });
  });
}
