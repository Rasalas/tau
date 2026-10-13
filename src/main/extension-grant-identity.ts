import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, hashPackageFiles, publicKeyFrom, readTrustedPublishers, SIGNATURE_FILE, verifyExtensionSignature, type SignatureCheckInput, type TrustedPublisher } from "./extension-signature.js";

export interface PackageGrantIdentity {
  contentHash: string;
  signer?: string;
  trustedSigner?: boolean;
}

/** Consent covers every package file, including its manifest and signature. */
export async function readPackageGrantIdentity(
  directory: string,
  manifest: SignatureCheckInput,
  publishers?: readonly TrustedPublisher[],
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
  return { contentHash, ...(signer ? { signer } : {}), ...(publisher ? { trustedSigner: true } : {}) };
}
