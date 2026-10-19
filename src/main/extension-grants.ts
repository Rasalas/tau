import { readFile } from "node:fs/promises";
import { DEFAULT_PACKAGE_ISOLATION, type ExtensionIsolation } from "../shared/extension-permissions.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { tauHomeDir } from "./app-identity.js";
import { writePersistedJson } from "./persisted-json.js";
import type { PackageGrantIdentity } from "./extension-grant-identity.js";
import type { ExtensionPackageSummary } from "../shared/contracts.js";

/** Only a native dialog's answer may authorize a new package grant. */
export async function confirmExtensionGrant(
  pkg: ExtensionPackageSummary,
  ask: (prompt: { type: "warning"; title: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number }) => Promise<{ response: number }>,
): Promise<boolean> {
  const isolation = pkg.isolation ?? DEFAULT_PACKAGE_ISOLATION;
  const detail = [pkg.id, pkg.directory, `Permissions: ${(pkg.permissions ?? []).join(", ") || "none"}`, `Isolation: ${isolation}`];
  if (pkg.desktop) detail.push("The desktop half can use the workbench's host connection.");
  if (isolation === "in-process") detail.push("This package can do everything the host process can.");
  if (isolation === "worker") {
    detail.push("It runs in a process of its own: it reads its own files, writes only to its own data folder, and cannot reach the network, start programs or load compiled code without the matching permission.");
    if (pkg.permissions?.some((permission) => permission === "process" || permission === "native")) {
      detail.push("With the permission to start programs or load compiled code it could get around these limits.");
    }
  }
  const answer = await ask({ type: "warning", title: "Allow extension", message: `Allow ${pkg.name}?`, detail: detail.join("\n\n"), buttons: ["Cancel", "Allow"], defaultId: 0, cancelId: 0 });
  return answer.response === 1;
}

export interface ExtensionGrant {
  id: string;
  version?: string;
  contentHash?: string;
  signer?: string;
  permissions: string[];
  /** The isolation the user approved; missing means the default, a worker. */
  isolation?: ExtensionIsolation;
  /** Whether the approved package had a window half and a host half; a grant from before this lacks them. */
  desktop?: boolean;
  host?: boolean;
  /** The host wrote this package for the user (`tau_new_package`): an edit does not need a new grant, a change of permissions or isolation does. */
  own?: boolean;
  /** The thread that last started an own package: its access level decides whether an edit to the permissions restarts it. */
  thread?: string;
  grantedAt: number;
}

export interface ExtensionGrantsFile {
  grants: ExtensionGrant[];
}

/** `TAU_EXTENSION_GRANTS_FILE` keeps a test instance's approvals out of the user's own file. */
export function defaultGrantsFilePath(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return env.TAU_EXTENSION_GRANTS_FILE?.trim() || join(tauHomeDir(home), "extension-grants.json");
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
  await writePersistedJson(filePath, 1, { grants: grants.grants });
}

/** The entries a manifest names: the window's side, and the side that runs apart from it. */
export interface PackageHalves {
  desktop?: string;
  window?: string;
  host?: string;
  pi?: string;
}

/** What the user approves by halves: code in Tau's window, and code that runs apart from it. */
export function packageHalves(manifest: PackageHalves): { desktop: boolean; host: boolean } {
  return { desktop: Boolean(manifest.desktop || manifest.window), host: Boolean(manifest.host || manifest.pi) };
}

export function isPackageGranted(
  manifest: { id: string; permissions?: readonly string[]; isolation?: ExtensionIsolation } & PackageHalves,
  grants: readonly ExtensionGrant[],
  identity?: PackageGrantIdentity,
): boolean {
  const existing = grants.find((g) => g.id === manifest.id);
  if (!existing || !identity?.contentHash || !existing.contentHash) return false;
  if (existing.signer !== identity.signer) return false;
  if (existing.contentHash !== identity.contentHash && !identity.trustedSigner && !(existing.own && identity.own)) return false;
  // Running inside the host process is a privilege of its own: a package that
  // leaves the worker after it was approved has to be approved again.
  if ((manifest.isolation ?? DEFAULT_PACKAGE_ISOLATION) !== (existing.isolation ?? DEFAULT_PACKAGE_ISOLATION)) return false;
  // A half the user never saw has to be allowed too; an older grant did not record them.
  const halves = packageHalves(manifest);
  if ((halves.desktop && existing.desktop === false) || (halves.host && existing.host === false)) return false;
  const current = [...(manifest.permissions ?? [])].sort();
  const granted = [...(existing.permissions ?? [])].sort();
  if (current.length !== granted.length) return false;
  return current.every((p, i) => p === granted[i]);
}

export async function grantPackage(
  manifest: { id: string; version?: string; permissions?: readonly string[]; isolation?: ExtensionIsolation } & PackageHalves,
  granted: boolean,
  filePath = defaultGrantsFilePath(),
  identity?: PackageGrantIdentity,
  own?: { thread?: string },
): Promise<void> {
  const file = await readExtensionGrants(filePath);
  const remaining = file.grants.filter((g) => g.id !== manifest.id);
  if (granted) {
    remaining.push({
      id: manifest.id,
      ...(identity ? { contentHash: identity.contentHash, ...(identity.signer ? { signer: identity.signer } : {}) } : {}),
      ...(manifest.version ? { version: manifest.version } : {}),
      permissions: [...(manifest.permissions ?? [])].sort(),
      isolation: manifest.isolation ?? DEFAULT_PACKAGE_ISOLATION,
      // A manifest naming no half is a bare stub or a theme: nothing to remember.
      ...(manifest.desktop || manifest.window || manifest.host || manifest.pi ? packageHalves(manifest) : {}),
      ...(own ? { own: true, ...(own.thread ? { thread: own.thread } : {}) } : {}),
      grantedAt: Date.now(),
    });
  }
  await writeExtensionGrants({ grants: remaining }, filePath);
}
