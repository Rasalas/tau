import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SIGNATURE_FILE,
  canonicalJson,
  describeSignature,
  hashPackageFiles,
  parseExtensionSignature,
  readTrustedPublishers,
  signaturePayload,
  verifyExtensionSignature,
  type TrustedPublisher,
} from "./extension-signature.js";

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tau-sig-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const manifest = { id: "acme.hello", version: "1.0.0" };

async function writePackage(): Promise<string> {
  const dir = join(await scratch(), "hello");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "tau-extension.json"), JSON.stringify({ ...manifest, name: "Hello", host: "./src/host.ts" }));
  await writeFile(join(dir, "src", "host.ts"), "export default { activate() {} }");
  return dir;
}

async function signPackage(dir: string, key: KeyObject, publisher = "acme"): Promise<void> {
  const files = await hashPackageFiles(dir);
  const signature = sign(null, Buffer.from(signaturePayload(manifest.id, manifest.version, files), "utf8"), key).toString("base64");
  await writeFile(join(dir, SIGNATURE_FILE), JSON.stringify({ publisher, algorithm: "ed25519", signature, files }));
}

describe("extension signatures", () => {
  const keys = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const pem = String(keys.publicKey.export({ type: "spki", format: "pem" }));
  const trusted: TrustedPublisher[] = [{ id: "acme", name: "ACME", key: pem }];

  it("sorts keys so signer and verifier hash the same bytes", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
    expect(signaturePayload("acme.hello", undefined, { "a.ts": "0" })).toBe('{"files":{"a.ts":"0"},"id":"acme.hello","version":""}');
  });

  it("accepts a package signed by a trusted publisher", async () => {
    const dir = await writePackage();
    await signPackage(dir, keys.privateKey);
    const state = await verifyExtensionSignature(dir, manifest, trusted);
    expect(state).toEqual({ state: "signed", publisher: "acme", publisherName: "ACME" });
    expect(describeSignature(state)).toBe("signed by ACME");
  });

  it("calls an unsigned package unsigned", async () => {
    const dir = await writePackage();
    expect(await verifyExtensionSignature(dir, manifest, trusted)).toEqual({ state: "unsigned" });
  });

  it("does not trust a signature made with another key", async () => {
    const dir = await writePackage();
    await signPackage(dir, other.privateKey);
    const state = await verifyExtensionSignature(dir, manifest, trusted);
    expect(state).toEqual({ state: "tampered", publisher: "acme", reason: "the signature does not match this package" });
  });

  it("does not trust a publisher it has no key for", async () => {
    const dir = await writePackage();
    await signPackage(dir, keys.privateKey, "someone-else");
    const state = await verifyExtensionSignature(dir, manifest, trusted);
    expect(state.state).toBe("untrusted");
    expect(describeSignature(state)).toBe("signature not trusted");
  });

  it("catches a changed, an added and a missing file", async () => {
    const changed = await writePackage();
    await signPackage(changed, keys.privateKey);
    await writeFile(join(changed, "src", "host.ts"), "export default { activate() { steal() } }");
    expect(await verifyExtensionSignature(changed, manifest, trusted))
      .toMatchObject({ state: "tampered", reason: "src/host.ts does not match its signed hash" });

    const added = await writePackage();
    await signPackage(added, keys.privateKey);
    await writeFile(join(added, "extra.ts"), "console.log('extra')");
    expect(await verifyExtensionSignature(added, manifest, trusted))
      .toMatchObject({ state: "tampered", reason: "extra.ts is not covered by the signature" });

    const missing = await writePackage();
    await signPackage(missing, keys.privateKey);
    await rm(join(missing, "src", "host.ts"));
    expect(await verifyExtensionSignature(missing, manifest, trusted))
      .toMatchObject({ state: "tampered", reason: "src/host.ts is signed but missing" });
  });

  it("rejects a signature document it cannot read", () => {
    expect(() => parseExtensionSignature("{")).toThrow(/not valid JSON/u);
    expect(() => parseExtensionSignature(JSON.stringify({ publisher: "a", algorithm: "rsa", signature: "x", files: {} }))).toThrow(/ed25519/u);
    expect(() => parseExtensionSignature(JSON.stringify({ publisher: "a", algorithm: "ed25519", signature: "x", files: { "../x": "0".repeat(64) } })))
      .toThrow(/relative path inside the package/u);
  });

  it("reads trusted publishers as a list or as a plain map", async () => {
    const home = await scratch();
    await mkdir(join(home, ".tau"), { recursive: true });
    const path = join(home, ".tau", "trusted-publishers.json");
    await writeFile(path, JSON.stringify({ version: 1, publishers: { acme: pem } }));
    expect(await readTrustedPublishers(path)).toEqual([{ id: "acme", key: pem.trim() }]);
    await writeFile(path, JSON.stringify({ version: 1, publishers: [{ id: "acme", name: "ACME", key: pem }] }));
    expect(await readTrustedPublishers(path)).toEqual([{ id: "acme", key: pem.trim(), name: "ACME" }]);
    expect(await readTrustedPublishers(join(home, "missing.json"))).toEqual([]);
  });

  it("reads a raw base64 public key as well as a PEM one", async () => {
    const dir = await writePackage();
    await signPackage(dir, keys.privateKey);
    const raw = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    expect(await verifyExtensionSignature(dir, manifest, [{ id: "acme", key: raw }])).toMatchObject({ state: "signed" });
  });
});
