#!/usr/bin/env node
// Writes tau-extension.sig for a package folder.
// Usage: node scripts/sign-extension.mjs <package dir> <private key pem> [publisher-id]
import { createPrivateKey, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { MANIFEST_FILE, SIGNATURE_FILE, hashPackageFiles, signaturePayload } from "./extension-signing.mjs";

const [directoryArg, keyArg, publisherArg] = process.argv.slice(2);
if (!directoryArg || !keyArg) {
  console.error("Usage: node scripts/sign-extension.mjs <package dir> <private key pem> [publisher-id]");
  process.exit(2);
}
const directory = resolve(directoryArg);
const keyPath = resolve(keyArg);
const publisher = publisherArg ?? basename(keyPath).replace(/\.(private\.)?pem$/u, "");

const manifest = JSON.parse(await readFile(join(directory, MANIFEST_FILE), "utf8"));
if (typeof manifest.id !== "string") {
  console.error(`${join(directory, MANIFEST_FILE)} has no "id".`);
  process.exit(1);
}

const files = await hashPackageFiles(directory);
const signature = sign(
  null,
  Buffer.from(signaturePayload(manifest.id, manifest.version, files), "utf8"),
  createPrivateKey({ key: await readFile(keyPath, "utf8"), format: "pem" }),
).toString("base64");

const document = { publisher, algorithm: "ed25519", signature, files };
await writeFile(join(directory, SIGNATURE_FILE), `${JSON.stringify(document, null, 2)}\n`, "utf8");
console.log(`Signed ${manifest.id}${manifest.version ? ` ${manifest.version}` : ""} as "${publisher}": ${Object.keys(files).length} files.`);
