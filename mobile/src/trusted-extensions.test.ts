import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DesktopExtensionBundle } from "../../src/shared/contracts";
import { desktopBundleIdentity } from "../../src/shared/trusted-desktop-bundles";
import type { HostClient } from "../../src/workbench/host-client";
import { withBundleStore, type BundleStore } from "../../src/web/bundle-cache";
import { withTrustedExtensions } from "./trusted-extensions";

const kit: DesktopExtensionBundle = { id: "test.shipped", manifestId: "test.shipped", path: "/local/kit.js", scope: "bundled", code: "export default {};", permissions: [] };

describe("native phone extension loader", () => {
  it("does not import a remote module claiming a shipped identity and cached digest", async () => {
    vi.stubGlobal("crypto", webcrypto);
    try {
      const hash = createHash("sha256").update(desktopBundleIdentity(kit)).digest("hex");
      const load = vi.fn(async () => ({ bundles: [{ ...kit, code: "stealNativeSecrets();", hash }], errors: [], skipped: [] }));
      const client = { loadDesktopExtensions: load } as unknown as HostClient;
      const store: BundleStore = { digests: async () => [hash], get: async () => kit, put: vi.fn(async () => {}), keep: vi.fn(async () => {}) };
      const native = withBundleStore(withTrustedExtensions(client, async () => [kit]), store);
      const loaded = await native.loadDesktopExtensions("workspace", {}, [kit.id]);
      expect(load).toHaveBeenCalledWith("workspace", {}, [kit.id], []);
      const importModule = vi.fn();
      for (const bundle of loaded.bundles) importModule(bundle);
      expect(importModule).not.toHaveBeenCalled();
      expect(loaded.errors[0]?.message).toContain("not included in this app");
    } finally { vi.unstubAllGlobals(); }
  });

  it("returns the shipped local module and refuses remote code when the catalogue cannot load", async () => {
    vi.stubGlobal("crypto", webcrypto);
    try {
      const client = { loadDesktopExtensions: async () => ({ bundles: [{ ...kit, url: "https://remote.test/kit.js" }], errors: [], skipped: [] }) } as unknown as HostClient;
      expect((await withTrustedExtensions(client, async () => [kit]).loadDesktopExtensions("workspace", {})).bundles).toEqual([kit]);
      await expect(withTrustedExtensions(client, async () => { throw new Error("catalogue unavailable"); }).loadDesktopExtensions("workspace", {})).rejects.toThrow("catalogue unavailable");
    } finally { vi.unstubAllGlobals(); }
  });
});
