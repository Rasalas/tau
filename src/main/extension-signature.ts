import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { packagesHome } from "./extension-sources.js";
import { readPersistedJson } from "./persisted-json.js";
import { tauHomeDir } from "./app-identity.js";

export const SIGNATURE_FILE = "tau-extension.sig";
const TRUSTED_PUBLISHERS_FILE = "trusted-publishers.json";
const TRUSTED_PUBLISHERS_VERSION = 1;
/** DER prefix of an Ed25519 SubjectPublicKeyInfo, so a raw 32-byte key can be read too. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface ExtensionSignatureDocument {
  publisher: string;
  algorithm: "ed25519";
  /** Base64 signature over the canonical payload of `files`, `id` and `version`. */
  signature: string;
  /** sha256 of every file of the package, by path relative to the package folder. */
  files: Record<string, string>;
}

/** What a package's signature turned out to be; only `tampered` stops it from loading. */
export type SignatureState =
  | { state: "unsigned" }
  | { state: "signed"; publisher: string; publisherName?: string }
  | { state: "untrusted"; publisher: string; reason: string }
  | { state: "tampered"; publisher?: string; reason: string };

export interface TrustedPublisher {
  id: string;
  name?: string;
  /** A PEM public key, or the raw Ed25519 key in base64. */
  key: string;
}

export function parseExtensionSignature(source: string): ExtensionSignatureDocument {
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { throw new Error(`${SIGNATURE_FILE} is not valid JSON`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${SIGNATURE_FILE} must be an object`);
  const { publisher, algorithm, signature, files } = raw as Record<string, unknown>;
  if (typeof publisher !== "string" || !publisher.trim()) throw new Error(`"publisher" must be a non-empty string`);
  if (algorithm !== "ed25519") throw new Error(`"algorithm" must be "ed25519"`);
  if (typeof signature !== "string" || !signature.trim()) throw new Error(`"signature" must be a base64 string`);
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error(`"files" must be an object of path to sha256`);
  const hashes: Record<string, string> = {};
  for (const [path, hash] of Object.entries(files as Record<string, unknown>)) {
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/u.test(hash)) throw new Error(`"files.${path}" must be a sha256 hex digest`);
    if (path.startsWith("/") || path.split("/").includes("..")) throw new Error(`"files.${path}" must be a relative path inside the package`);
    hashes[path] = hash;
  }
  return { publisher: publisher.trim(), algorithm, signature: signature.trim(), files: hashes };
}

/** Object keys in sorted order and no whitespace: signer and verifier hash the same bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The bytes a publisher signs: the file hashes bound to the package they belong to. */
export function signaturePayload(id: string, version: string | undefined, files: Record<string, string>): string {
  return canonicalJson({ files, id, version: version ?? "" });
}

/** sha256 of every file in the package folder, `.git` and the signature itself excluded. */
export async function hashPackageFiles(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      if (entry.name === ".git") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile()) continue;
      const key = relative(directory, path).split(sep).join("/");
      if (key === SIGNATURE_FILE) continue;
      files[key] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  };
  await walk(directory);
  return files;
}

export function trustedPublishersPath(home: string = packagesHome()): string {
  return join(tauHomeDir(home), TRUSTED_PUBLISHERS_FILE);
}

function decodePublishers(value: unknown): TrustedPublisher[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const publishers = (value as { publishers?: unknown }).publishers;
  if (Array.isArray(publishers)) {
    return publishers.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const { id, name, key } = entry as Record<string, unknown>;
      if (typeof id !== "string" || !id.trim() || typeof key !== "string" || !key.trim()) return [];
      return [{ id: id.trim(), key: key.trim(), ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}) }];
    });
  }
  // The short form: a plain map of key id to public key.
  if (publishers && typeof publishers === "object") {
    return Object.entries(publishers as Record<string, unknown>)
      .filter(([, key]) => typeof key === "string" && key.trim())
      .map(([id, key]) => ({ id, key: (key as string).trim() }));
  }
  return undefined;
}

export async function readTrustedPublishers(path: string = trustedPublishersPath()): Promise<TrustedPublisher[]> {
  const read = await readPersistedJson<TrustedPublisher[]>(path, {
    expectedVersion: TRUSTED_PUBLISHERS_VERSION,
    decode: decodePublishers,
  });
  return read?.data ?? [];
}

/** Reads a stored public key, PEM or raw Ed25519 base64. */
export function publicKeyFrom(key: string): KeyObject {
  if (key.includes("-----BEGIN")) return createPublicKey({ key, format: "pem" });
  const raw = Buffer.from(key, "base64");
  if (raw.length !== 32) throw new Error("a raw Ed25519 public key is 32 bytes of base64");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export interface SignatureCheckInput {
  id: string;
  version?: string;
}

/**
 * Verifies a package folder against its `tau-extension.sig`. The file hashes are
 * checked before the key is looked up, so a tampered file is caught even when
 * nothing trusts the publisher.
 */
export async function verifyExtensionSignature(
  directory: string,
  manifest: SignatureCheckInput,
  publishers: readonly TrustedPublisher[],
): Promise<SignatureState> {
  let source: string;
  try {
    source = await readFile(join(directory, SIGNATURE_FILE), "utf8");
  } catch {
    return { state: "unsigned" };
  }
  let document: ExtensionSignatureDocument;
  try {
    document = parseExtensionSignature(source);
  } catch (error) {
    return { state: "tampered", reason: error instanceof Error ? error.message : String(error) };
  }
  const actual = await hashPackageFiles(directory);
  for (const [path, hash] of Object.entries(document.files)) {
    if (actual[path] === undefined) return { state: "tampered", publisher: document.publisher, reason: `${path} is signed but missing` };
    if (actual[path] !== hash) return { state: "tampered", publisher: document.publisher, reason: `${path} does not match its signed hash` };
  }
  const extra = Object.keys(actual).filter((path) => document.files[path] === undefined).sort();
  if (extra.length > 0) {
    return { state: "tampered", publisher: document.publisher, reason: `${extra[0]} is not covered by the signature` };
  }
  const publisher = publishers.find((entry) => entry.id === document.publisher);
  if (!publisher) {
    return { state: "untrusted", publisher: document.publisher, reason: `no trusted key for publisher "${document.publisher}"` };
  }
  let matched = false;
  try {
    matched = verify(
      null,
      Buffer.from(signaturePayload(manifest.id, manifest.version, document.files), "utf8"),
      publicKeyFrom(publisher.key),
      Buffer.from(document.signature, "base64"),
    );
  } catch (error) {
    return { state: "untrusted", publisher: document.publisher, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!matched) {
    return { state: "tampered", publisher: document.publisher, reason: "the signature does not match this package" };
  }
  return { state: "signed", publisher: publisher.id, ...(publisher.name ? { publisherName: publisher.name } : {}) };
}

/** One line for the settings UI and the CLI-shaped `list` output. */
export function describeSignature(state: SignatureState): string {
  switch (state.state) {
    case "signed": return `signed by ${state.publisherName ?? state.publisher}`;
    case "untrusted": return "signature not trusted";
    case "tampered": return `signature broken: ${state.reason}`;
    default: return "unsigned";
  }
}
