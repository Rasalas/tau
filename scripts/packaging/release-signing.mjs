// Signs a release's update feeds (`latest*.yml`) and checks them the way an
// installed Tau does (src/main/release-feed.ts, bin/tau-update-helper.mjs):
// `<file>.sig` holds one base64 Ed25519 signature per line over the file's
// exact bytes. See docs/host-updates.md, "Release signing".
//
//   TAU_RELEASE_SIGNING_KEY="$(cat key.pem)" node scripts/packaging/release-signing.mjs sign <file>...
//   node scripts/packaging/release-signing.mjs verify <file> <file.sig> <public key or its file>
//   node scripts/packaging/release-signing.mjs check <file>...   (against the keys this checkout ships)
//   node scripts/packaging/release-signing.mjs keygen <private.pem>
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { RELEASE_PUBLIC_KEYS, verifySignature } from "../../bin/tau-update-helper.mjs";
import { isMain, main } from "./release.mjs";

export const SIGNING_KEY_ENV = "TAU_RELEASE_SIGNING_KEY";

const USAGE = `usage:
  ${SIGNING_KEY_ENV}=<PKCS#8 PEM> release-signing.mjs sign <file>...
  release-signing.mjs verify <file> <signature file> <public key (raw base64 or PEM) or a file holding it>
  release-signing.mjs check <file>...
  release-signing.mjs keygen <private key file>`;

/** Every Ed25519 private key in `text`; during a rotation the secret holds the old and the new. */
export function signingKeys(text) {
  const blocks = String(text ?? "").match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/gu) ?? [];
  return blocks.map((pem) => {
    const key = createPrivateKey({ key: pem, format: "pem" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error(`${SIGNING_KEY_ENV} holds a ${key.asymmetricKeyType} key; release keys are Ed25519.`);
    return key;
  });
}

/** The raw base64 form the key lists carry, of a private or public key. */
export function rawPublicKey(key) {
  const publicKey = key.type === "public" ? key : createPublicKey(key);
  return publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
}

/**
 * The host verifies the text it read (`Response.text()`), which drops a BOM
 * and replaces bad UTF-8. Signing such a file would sign bytes no host checks.
 */
export function feedText(bytes, name = "the file") {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${name} is not UTF-8; a host would read other bytes than the ones signed.`);
  }
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) throw new Error(`${name} starts with a byte order mark; a host would read other bytes than the ones signed.`);
  return text;
}

/** The `.sig` for a feed: one line per key. */
export function signFeed(bytes, keys, name) {
  if (keys.length === 0) throw new Error("No signing key.");
  const text = Buffer.from(feedText(bytes, name), "utf8");
  return `${keys.map((key) => sign(null, text, key).toString("base64")).join("\n")}\n`;
}

/** Whether a host trusting `keys` accepts this feed and signature. */
export function verifyFeed(bytes, signature, keys) {
  return verifySignature(new TextDecoder().decode(bytes), signature, keys);
}

function signFiles(files, env) {
  if (files.length === 0) throw new Error(USAGE);
  const keys = signingKeys(env[SIGNING_KEY_ENV]);
  if (keys.length === 0) throw new Error(`${SIGNING_KEY_ENV} holds no private key (PKCS#8 PEM); nothing was signed.`);
  const publicKeys = keys.map(rawPublicKey);
  for (const file of files) {
    const bytes = readFileSync(file);
    const signature = signFeed(bytes, keys, file);
    if (!publicKeys.every((key) => verifyFeed(bytes, signature, [key]))) throw new Error(`${file}: the signature does not verify; nothing was written.`);
    writeFileSync(`${file}.sig`, signature);
    console.log(`signed ${file} with ${publicKeys.join(", ")}`);
  }
}

function checkFiles(files, keys = RELEASE_PUBLIC_KEYS) {
  if (files.length === 0) throw new Error(USAGE);
  if (keys.length === 0) throw new Error("This checkout lists no release key (src/shared/release-keys.ts); its hosts would not check a signature.");
  const failed = [];
  for (const file of files) {
    const signature = existsSync(`${file}.sig`) ? readFileSync(`${file}.sig`, "utf8") : undefined;
    if (signature === undefined) failed.push(`${file}: no ${file}.sig`);
    else if (!verifyFeed(readFileSync(file), signature, keys)) failed.push(`${file}: not signed by a key this build trusts (${keys.join(", ")})`);
    else console.log(`${file}: signed by a listed release key`);
  }
  if (failed.length > 0) throw new Error(`An installed Tau would refuse these feeds:\n${failed.join("\n")}`);
}

function verifyFile(file, signatureFile, key) {
  if (!file || !signatureFile || !key) throw new Error(USAGE);
  const publicKey = existsSync(key) ? readFileSync(key, "utf8").trim() : key;
  if (!verifyFeed(readFileSync(file), readFileSync(signatureFile, "utf8"), [publicKey])) throw new Error(`${file} is not signed by that key.`);
  console.log(`${file}: good signature`);
}

function keygen(target) {
  if (!target) throw new Error(USAGE);
  if (existsSync(target)) throw new Error(`${target} exists; a key is never overwritten.`);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(target, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  console.log(`private key: ${target} (the secret's value; keep it offline)`);
  console.log(`public key:  ${rawPublicKey(publicKey)} (for src/shared/release-keys.ts and bin/tau-update-helper.mjs)`);
}

export function run(argv, env = process.env) {
  const [command, ...rest] = argv;
  if (command === "sign") signFiles(rest, env);
  else if (command === "check") checkFiles(rest);
  else if (command === "verify") verifyFile(...rest);
  else if (command === "keygen") keygen(rest[0]);
  else throw new Error(USAGE);
}

if (isMain(import.meta.url)) main(() => run(process.argv.slice(2)));
