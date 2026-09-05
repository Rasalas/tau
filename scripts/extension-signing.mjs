import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const SIGNATURE_FILE = "tau-extension.sig";
export const MANIFEST_FILE = "tau-extension.json";

/** Mirrors `canonicalJson` in src/main/extension-signature.ts; the two must agree byte for byte. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function signaturePayload(id, version, files) {
  return canonicalJson({ files, id, version: version ?? "" });
}

/** sha256 of every file in the package folder, `.git` and the signature itself excluded. */
export async function hashPackageFiles(directory) {
  const files = {};
  const walk = async (current) => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => (left.name < right.name ? -1 : 1))) {
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
