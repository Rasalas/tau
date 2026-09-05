#!/usr/bin/env node
// Ed25519 keypair for signing Tau extension packages.
// Usage: node scripts/keygen-extension.mjs <publisher-id> [output directory]
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [publisher, outputArg] = process.argv.slice(2);
if (!publisher || !/^[A-Za-z0-9][\w.-]*$/u.test(publisher)) {
  console.error("Usage: node scripts/keygen-extension.mjs <publisher-id> [output directory]");
  process.exit(2);
}
const output = resolve(outputArg ?? process.cwd());
await mkdir(output, { recursive: true });

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePath = join(output, `${publisher}.private.pem`);
const publicPath = join(output, `${publisher}.public.pem`);
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = publicKey.export({ type: "spki", format: "pem" });

await writeFile(privatePath, privatePem, { encoding: "utf8", mode: 0o600 });
await chmod(privatePath, 0o600);
await writeFile(publicPath, publicPem, "utf8");

console.log(`Private key: ${privatePath} (keep it out of the package)`);
console.log(`Public key:  ${publicPath}`);
console.log("\nAdd this to ~/.tau/trusted-publishers.json to trust it:\n");
console.log(JSON.stringify({ version: 1, publishers: [{ id: publisher, name: publisher, key: String(publicPem).trim() }] }, null, 2));
