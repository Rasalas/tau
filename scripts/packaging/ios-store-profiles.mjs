#!/usr/bin/env node
// App IDs and App Store profiles for the app and TauWidgets, through the App Store Connect API.
//
//   node scripts/packaging/ios-store-profiles.mjs status
//   node scripts/packaging/ios-store-profiles.mjs prepare                      registers the widget App ID, turns on APP_GROUPS
//   node scripts/packaging/ios-store-profiles.mjs profiles [--certificate <id>] [--out <dir>]
//
// Needs APPLE_API_KEY_ID and APPLE_API_ISSUER; the key is read from APPLE_API_KEY_PATH or
// ~/.appstoreconnect/private_keys/AuthKey_<id>.p8. Only creates; never deletes or revokes.
// The App Group itself is assigned by hand in the developer portal (K164): the API has no endpoint for it.
import { createPrivateKey, sign } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GROUP = "group.de.tbuck.tau";
export const TARGETS = [
  { secret: "IOS_PROFILE", identifier: "de.tbuck.tau", name: "Tau" },
  { secret: "IOS_WIDGET_PROFILE", identifier: "de.tbuck.tau.widgets", name: "Tau Widgets" },
];
const API = "https://api.appstoreconnect.apple.com";

function token({ keyId, issuer, key }) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = `${part({ alg: "ES256", kid: keyId, typ: "JWT" })}.${part({ iss: issuer, iat: now, exp: now + 600, aud: "appstoreconnect-v1" })}`;
  return `${head}.${sign("sha256", Buffer.from(head), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

function client(env = process.env) {
  const keyId = env.APPLE_API_KEY_ID;
  const issuer = env.APPLE_API_ISSUER;
  if (!keyId || !issuer) throw new Error("Set APPLE_API_KEY_ID and APPLE_API_ISSUER.");
  const key = createPrivateKey(readFileSync(env.APPLE_API_KEY_PATH || path.join(homedir(), ".appstoreconnect/private_keys", `AuthKey_${keyId}.p8`)));
  return async (method, route, data) => {
    const response = await fetch(API + route, {
      method,
      headers: { authorization: `Bearer ${token({ keyId, issuer, key })}`, "content-type": "application/json" },
      body: data ? JSON.stringify({ data }) : undefined,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = body.errors?.[0];
      throw new Error(`${method} ${route.split("?")[0]}: ${response.status} ${error?.code ?? ""} ${error?.detail ?? ""}`.trim());
    }
    return body;
  };
}

/** The entitlements of a signed .mobileprovision; its plist is stored unencrypted inside the CMS envelope. */
export function profileEntitlements(bytes) {
  const text = Buffer.from(bytes).toString("latin1");
  const plist = text.slice(text.indexOf("<?xml"), text.indexOf("</plist>") + 8);
  const block = /<key>Entitlements<\/key>\s*<dict>([\s\S]*?)<\/dict>/u.exec(plist)?.[1] ?? "";
  const groups = /<key>com\.apple\.security\.application-groups<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(block)?.[1] ?? "";
  return {
    applicationIdentifier: /<key>application-identifier<\/key>\s*<string>([^<]*)<\/string>/u.exec(block)?.[1],
    appGroups: [...groups.matchAll(/<string>([^<]*)<\/string>/gu)].map((match) => match[1]),
  };
}

/** The one valid distribution certificate, or the one named; Apple Distribution certificates are `DISTRIBUTION`. */
export function pickCertificate(certificates, wanted, now = new Date()) {
  const valid = certificates.filter((entry) => ["DISTRIBUTION", "IOS_DISTRIBUTION"].includes(entry.attributes.certificateType) && new Date(entry.attributes.expirationDate) > now);
  if (wanted) {
    const named = valid.find((entry) => entry.id === wanted || entry.attributes.serialNumber === wanted);
    if (!named) throw new Error(`No valid distribution certificate ${wanted}.`);
    return named;
  }
  if (valid.length !== 1) throw new Error(`${valid.length} valid distribution certificates; pass --certificate <id> (see status).`);
  return valid[0];
}

async function bundleIds(api) {
  const found = await api("GET", "/v1/bundleIds?limit=200&include=bundleIdCapabilities&fields[bundleIds]=identifier,name,platform,bundleIdCapabilities");
  const capabilities = new Map((found.included ?? []).filter((entry) => entry.type === "bundleIdCapabilities").map((entry) => [entry.id, entry.attributes.capabilityType]));
  return new Map(found.data.filter((entry) => TARGETS.some((target) => target.identifier === entry.attributes.identifier)).map((entry) => [
    entry.attributes.identifier,
    { id: entry.id, capabilities: (entry.relationships?.bundleIdCapabilities?.data ?? []).map((link) => capabilities.get(link.id)).filter(Boolean) },
  ]));
}

async function status(api) {
  const ids = await bundleIds(api);
  for (const { identifier } of TARGETS) {
    const entry = ids.get(identifier);
    console.log(entry ? `${identifier} (${entry.id}): ${entry.capabilities.join(", ") || "no capabilities"}` : `${identifier}: not registered`);
  }
  const certificates = await api("GET", "/v1/certificates?limit=200&fields[certificates]=name,certificateType,serialNumber,expirationDate");
  for (const entry of certificates.data) {
    const { name, certificateType, serialNumber, expirationDate } = entry.attributes;
    console.log(`certificate ${entry.id}: ${certificateType} "${name}" serial ${serialNumber}, expires ${expirationDate.slice(0, 10)}`);
  }
  const profiles = await api("GET", "/v1/profiles?limit=200&include=bundleId&fields[profiles]=name,profileType,profileState,uuid,expirationDate,bundleId&fields[bundleIds]=identifier");
  const owners = new Map((profiles.included ?? []).map((entry) => [entry.id, entry.attributes.identifier]));
  for (const entry of profiles.data) {
    const { name, profileType, profileState, uuid, expirationDate } = entry.attributes;
    console.log(`profile "${name}": ${profileType} ${profileState} for ${owners.get(entry.relationships?.bundleId?.data?.id) ?? "?"}, ${uuid}, expires ${expirationDate.slice(0, 10)}`);
  }
}

async function prepare(api) {
  let ids = await bundleIds(api);
  for (const { identifier, name } of TARGETS) {
    if (ids.has(identifier)) continue;
    const created = await api("POST", "/v1/bundleIds", { type: "bundleIds", attributes: { identifier, name, platform: "IOS" } });
    console.log(`Registered App ID ${identifier} (${created.data.id}).`);
  }
  ids = await bundleIds(api);
  for (const { identifier } of TARGETS) {
    const entry = ids.get(identifier);
    if (entry.capabilities.includes("APP_GROUPS")) {
      console.log(`${identifier} already has APP_GROUPS.`);
      continue;
    }
    await api("POST", "/v1/bundleIdCapabilities", {
      type: "bundleIdCapabilities",
      attributes: { capabilityType: "APP_GROUPS" },
      relationships: { bundleId: { data: { type: "bundleIds", id: entry.id } } },
    });
    console.log(`Turned on APP_GROUPS for ${identifier}.`);
  }
  console.log(`Next, by hand: assign ${GROUP} to both App IDs in the developer portal, then run "profiles".`);
  console.log("Changing an App ID marks its existing profiles Invalid; replace IOS_PROFILE soon after.");
}

async function createProfiles(api, wanted, out) {
  const ids = await bundleIds(api);
  for (const { identifier } of TARGETS) {
    if (!ids.get(identifier)?.capabilities.includes("APP_GROUPS")) throw new Error(`${identifier} lacks APP_GROUPS; run "prepare" first.`);
  }
  const certificates = await api("GET", "/v1/certificates?limit=200&fields[certificates]=name,certificateType,serialNumber,expirationDate");
  const certificate = pickCertificate(certificates.data, wanted);
  const dir = out ?? mkdtempSync(path.join(tmpdir(), "tau-ios-profiles-"));
  const day = new Date().toISOString().slice(0, 10);
  // The app first: when the group is not assigned yet, it stops before a widget profile exists.
  for (const { secret, identifier } of TARGETS) {
    const created = await api("POST", "/v1/profiles", {
      type: "profiles",
      attributes: { name: `Tau App Store ${identifier} ${day}`, profileType: "IOS_APP_STORE" },
      relationships: {
        bundleId: { data: { type: "bundleIds", id: ids.get(identifier).id } },
        certificates: { data: [{ type: "certificates", id: certificate.id }] },
      },
    });
    const { name, uuid, profileContent } = created.data.attributes;
    const bytes = Buffer.from(profileContent, "base64");
    if (!profileEntitlements(bytes).appGroups.includes(GROUP)) {
      throw new Error(`Created "${name}" (${uuid}), but it does not allow ${GROUP}: assign the group to ${identifier} in the developer portal, then run this again.`);
    }
    const file = path.join(dir, `${secret}.b64`);
    writeFileSync(file, profileContent);
    chmodSync(file, 0o600);
    console.log(`${secret}: "${name}" (${uuid}) → ${file}`);
    console.log(`  gh secret set ${secret} --repo Rasalas/tau --env release < ${file}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const run = { status: (api) => status(api), prepare: (api) => prepare(api), profiles: (api) => createProfiles(api, option("--certificate"), option("--out")) }[command];
  if (!run) {
    console.error("usage: ios-store-profiles.mjs status | prepare | profiles [--certificate <id>] [--out <dir>]");
    process.exit(2);
  }
  run(client()).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
