import type { HostClient } from "../../src/workbench/host-client";
import { trustedDesktopBundles } from "../../src/shared/trusted-desktop-bundles";
import type { DesktopExtensionBundle } from "../../src/shared/contracts";

/** The native bridge is shared by trusted code; remote packages never enter it. */
export function withTrustedExtensions(client: HostClient, loadKits: () => Promise<DesktopExtensionBundle[]>): HostClient {
  return {
    ...client,
    loadDesktopExtensions: async (cwd, sharedExports, only) => {
      const [result, local] = await Promise.all([
        // Always ask for bytes. A remote cache digest is not proof of their identity.
        client.loadDesktopExtensions(cwd, sharedExports, only, []),
        loadKits(),
      ]);
      return trustedDesktopBundles(result, local, async (source) => {
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
        return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
      });
    },
  };
}
