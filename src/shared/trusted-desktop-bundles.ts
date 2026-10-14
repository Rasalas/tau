import type { DesktopExtensionBundle, DesktopExtensionLoadResult } from "./contracts.js";

export type BundleDigest = (source: string) => Promise<string>;

export const DESKTOP_BUNDLE_REJECTION_MESSAGES = {
  missing: "This machine's extension is not included in this app.",
  changed: "This machine runs another version of this extension; install the same Tau version on both.",
} as const;

/** Maps carry installation paths, so only the final map directive is omitted. */
export function desktopBundleIdentity(bundle: Pick<DesktopExtensionBundle, "code" | "styles">): string {
  const code = bundle.code.replace(/\n\/\/# sourceMappingURL=[^\r\n\u2028\u2029]*\r?\n?$/u, "");
  return JSON.stringify([code, bundle.styles ?? ""]);
}

/** Remote metadata and URLs never decide what executes in the client's realm. */
export async function trustedDesktopBundles(
  result: DesktopExtensionLoadResult,
  local: readonly DesktopExtensionBundle[],
  digest: BundleDigest,
): Promise<DesktopExtensionLoadResult> {
  const known = new Map(await Promise.all(local.map(async (bundle) =>
    [bundle.id, { bundle, hash: await digest(desktopBundleIdentity(bundle)) }] as const)));
  const bundles: DesktopExtensionBundle[] = [];
  const errors = [...result.errors];
  for (const remote of result.bundles) {
    if (remote.granted === false) continue;
    const shipped = known.get(remote.id);
    if (!remote.cached && shipped && await digest(desktopBundleIdentity(remote)) === shipped.hash) {
      bundles.push(shipped.bundle);
    } else {
      errors.push({ path: remote.path, message: DESKTOP_BUNDLE_REJECTION_MESSAGES[shipped ? "changed" : "missing"] });
    }
  }
  return { ...result, bundles, errors };
}
