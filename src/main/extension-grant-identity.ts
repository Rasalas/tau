import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findOwnPackage } from "./own-packages.js";
import { canonicalJson, hashPackageFiles, publicKeyFrom, readTrustedPublishers, SIGNATURE_FILE, verifyExtensionSignature, type SignatureCheckInput, type TrustedPublisher } from "./extension-signature.js";

export interface PackageGrantIdentity {
  contentHash: string;
  signer?: string;
  trustedSigner?: boolean;
  /** The host's own record says `tau_new_package` wrote this folder (ADR 0036, 2026-10-19). */
  own?: boolean;
}

/** Consent covers every package file, including its manifest and signature. */
export async function readPackageGrantIdentity(
  directory: string,
  manifest: SignatureCheckInput,
  publishers?: readonly TrustedPublisher[],
  ownPackagesFile?: string,
): Promise<PackageGrantIdentity> {
  const keys = publishers ?? await readTrustedPublishers();
  const files = await hashPackageFiles(directory);
  const signatureSource = await readFile(join(directory, SIGNATURE_FILE), "utf8").catch(() => undefined);
  const checked = await verifyExtensionSignature(directory, manifest, keys, { files, source: signatureSource });
  if (checked.state === "tampered") throw new Error(checked.reason);
  const contentHash = createHash("sha256").update(canonicalJson({ files, signature: signatureSource ?? "" })).digest("hex");
  const publisher = checked.state === "signed" ? keys.find((key) => key.id === checked.publisher) : undefined;
  const signer = publisher
    ? createHash("sha256").update(publicKeyFrom(publisher.key).export({ format: "der", type: "spki" })).digest("hex")
    : checked.state === "untrusted" ? checked.publisher : undefined;
  const own = ownPackagesFile !== undefined && await findOwnPackage(ownPackagesFile, manifest.id, directory) !== undefined;
  return { contentHash, ...(signer ? { signer } : {}), ...(publisher ? { trustedSigner: true } : {}), ...(own ? { own } : {}) };
}
