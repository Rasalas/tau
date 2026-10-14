import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DesktopExtensionBundle, DesktopExtensionLoadResult } from "./contracts.js";
import { desktopBundleIdentity, trustedDesktopBundles } from "./trusted-desktop-bundles.js";

const digest = async (source: string) => createHash("sha256").update(source).digest("hex");
const kit: DesktopExtensionBundle = { id: "test.shipped", manifestId: "test.shipped", path: "/local/desktop.js", scope: "bundled", code: "export default {};", styles: "body{}", permissions: [], granted: true };
const result = (bundles: DesktopExtensionBundle[]): DesktopExtensionLoadResult => ({ bundles, errors: [], skipped: [] });

describe("remote desktop bundles", () => {
  it("does not pass an unknown or modified bundle to an importer, even with a forged shipped digest", async () => {
    const importModule = vi.fn();
    const hash = await digest(desktopBundleIdentity(kit));
    const remote = [{ ...kit, code: "globalThis.stolen = true;", hash }, { ...kit, id: "test.unknown", manifestId: "test.unknown" }];
    const allowed = await trustedDesktopBundles(result(remote), [kit], digest);
    for (const bundle of allowed.bundles) importModule(bundle);
    expect(importModule).not.toHaveBeenCalled();
    expect(allowed.errors).toHaveLength(2);
    expect(allowed.errors.map((error) => error.message)).toEqual([
      "This machine runs another version of this extension; install the same Tau version on both.",
      "This machine's extension is not included in this app.",
    ]);
  });

  it("uses local code, styles and metadata after checking received bytes", async () => {
    const remote = { ...kit, path: "/remote/entry.js", url: "https://evil.test/code.js", stylesUrl: "https://evil.test/style.css", permissions: ["shell"], theme: true };
    expect((await trustedDesktopBundles(result([remote]), [kit], digest)).bundles).toEqual([kit]);
  });

  it("rejects changed styles, cached placeholders and unapproved modules", async () => {
    const remote = [{ ...kit, styles: "@import 'https://evil.test';" }, { ...kit, code: "", cached: true }, { ...kit, granted: false }];
    expect((await trustedDesktopBundles(result(remote), [kit], digest)).bundles).toEqual([]);
  });

  it("ignores only the final source map location and fails closed without local kits", async () => {
    const remote = { ...kit, code: `${kit.code}\n//# sourceMappingURL=https://remote.test/desktop.js.map\n` };
    const local = { ...kit, code: `${kit.code}\n//# sourceMappingURL=file:///local/desktop.js.map\n` };
    expect((await trustedDesktopBundles(result([remote]), [local], digest)).bundles).toEqual([local]);
    expect((await trustedDesktopBundles(result([remote]), [], digest)).bundles).toEqual([]);
  });
});
