import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DEFAULT_PACKAGE_ISOLATION, type ExtensionIsolation } from "../shared/extension-permissions.js";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ExtensionGrant {
  id: string;
  version?: string;
  permissions: string[];
  /** The isolation the user approved; missing means the default, a worker. */
  isolation?: ExtensionIsolation;
  grantedAt: number;
}

export interface ExtensionGrantsFile {
  grants: ExtensionGrant[];
}

export function defaultGrantsFilePath(home = homedir()): string {
  return join(home, ".tau", "extension-grants.json");
}

export async function readExtensionGrants(filePath = defaultGrantsFilePath()): Promise<ExtensionGrantsFile> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { grants?: unknown }).grants)) {
      const grants = (parsed as { grants: unknown[] }).grants.filter(
        (g): g is ExtensionGrant => Boolean(
          g && typeof g === "object" && typeof (g as ExtensionGrant).id === "string" && Array.isArray((g as ExtensionGrant).permissions),
        ),
      );
      return { grants };
    }
    return { grants: [] };
  } catch {
    return { grants: [] };
  }
}

export async function writeExtensionGrants(grants: ExtensionGrantsFile, filePath = defaultGrantsFilePath()): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(grants, null, 2), "utf8");
}

export function isPackageGranted(
  manifest: { id: string; permissions?: readonly string[]; isolation?: ExtensionIsolation },
  grants: readonly ExtensionGrant[],
): boolean {
  const existing = grants.find((g) => g.id === manifest.id);
  if (!existing) return false;
  // Running inside the host process is a privilege of its own: a package that
  // leaves the worker after it was approved has to be approved again.
  if ((manifest.isolation ?? DEFAULT_PACKAGE_ISOLATION) !== (existing.isolation ?? DEFAULT_PACKAGE_ISOLATION)) return false;
  const current = [...(manifest.permissions ?? [])].sort();
  const granted = [...(existing.permissions ?? [])].sort();
  if (current.length !== granted.length) return false;
  return current.every((p, i) => p === granted[i]);
}

export async function grantPackage(
  manifest: { id: string; version?: string; permissions?: readonly string[]; isolation?: ExtensionIsolation },
  granted: boolean,
  filePath = defaultGrantsFilePath(),
): Promise<void> {
  const file = await readExtensionGrants(filePath);
  const remaining = file.grants.filter((g) => g.id !== manifest.id);
  if (granted) {
    remaining.push({
      id: manifest.id,
      ...(manifest.version ? { version: manifest.version } : {}),
      permissions: [...(manifest.permissions ?? [])].sort(),
      isolation: manifest.isolation ?? DEFAULT_PACKAGE_ISOLATION,
      grantedAt: Date.now(),
    });
  }
  await writeExtensionGrants({ grants: remaining }, filePath);
}
