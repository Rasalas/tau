import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { loadBundledKitDesktopHalves } from "../src/main/bundled-kits";
import type { DesktopExtensionBundle } from "../src/shared/contracts";
import { trustedDesktopBundles } from "../src/shared/trusted-desktop-bundles";
import { localCatalogue, trustedKits } from "./trusted-kits";

describe("native client's shipped kit catalogue", () => {
  it("recognizes every shipped kit across mobile build and installed host paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-client-kit-paths-"));
    const repository = resolve(import.meta.dirname, "..");
    const checkout = join(root, "checkout");
    const installed = join(root, "installed/app.asar");
    try {
      await mkdir(join(checkout, "mobile"), { recursive: true });
      await symlink(join(repository, "src"), join(checkout, "src"));
      await symlink(join(repository, "kits"), join(checkout, "kits"));
      await symlink(join(repository, "node_modules"), join(root, "node_modules"));
      const runner = join(root, "catalogue.mjs");
      await build({
        stdin: { contents: 'import { localCatalogue } from "./vite/trusted-kits"; process.stdout.write(await localCatalogue(process.argv[2]));', resolveDir: repository },
        outfile: runner, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent",
      });
      const catalogue = async (cwd: string): Promise<DesktopExtensionBundle[]> => {
        const { stdout } = await promisify(execFile)(process.execPath, [runner, checkout], { cwd, maxBuffer: 20 * 1024 * 1024 });
        return JSON.parse(stdout.slice("export default ".length, -1));
      };
      const desktop = await catalogue(checkout);
      const mobile = await catalogue(join(checkout, "mobile"));
      expect(desktop.some((bundle) => bundle.id === "tau.terminal")).toBe(true);
      for (const bundle of desktop) {
        const directory = join(installed, "dist-kits", bundle.id);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "desktop.js"), bundle.code);
        if (bundle.styles !== undefined) await writeFile(join(directory, "styles.css"), bundle.styles);
        await writeFile(join(directory, "tau-extension.json"), JSON.stringify({
          id: bundle.id, name: bundle.id, desktop: "./desktop.js",
          ...(bundle.styles !== undefined ? { styles: "./styles.css" } : {}),
        }));
      }
      const remote = await loadBundledKitDesktopHalves({ appPath: installed, sharedExports: {} });
      expect(remote.errors).toEqual([]);
      const accepted = await trustedDesktopBundles(remote, mobile, async (source) => createHash("sha256").update(source).digest("hex"));
      expect(accepted.errors).toEqual([]);
      expect(accepted.bundles).toEqual(mobile);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("reads only the installation's kits and fails a build without them", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-client-kits-"));
    try {
      await mkdir(join(root, "src/renderer"), { recursive: true });
      await writeFile(join(root, "src/renderer/extension-api.ts"), "export const fixture = true;");
      await expect(localCatalogue(root)).rejects.toThrow("needs its shipped desktop extensions");
      const kit = join(root, "dist-kits/test.shipped");
      await mkdir(kit, { recursive: true });
      await writeFile(join(kit, "tau-extension.json"), JSON.stringify({ id: "test.shipped", name: "Shipped", desktop: "./desktop.js" }));
      await writeFile(join(kit, "desktop.js"), "export default { id: 'test.shipped', name: 'Shipped', activate() {} };");
      const source = await localCatalogue(root);
      expect(source).toContain("test.shipped");
      expect(source).toContain("activate() {}");
      expect(source).not.toContain("https://");
      expect(trustedKits(root).name).toBe("tau-trusted-kits");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fails the build for an unreadable shipped entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-client-kits-"));
    try {
      await mkdir(join(root, "src/renderer"), { recursive: true });
      await writeFile(join(root, "src/renderer/extension-api.ts"), "export const fixture = true;");
      const kit = join(root, "dist-kits/test.shipped");
      await mkdir(kit, { recursive: true });
      await writeFile(join(kit, "tau-extension.json"), JSON.stringify({ id: "test.shipped", name: "Shipped", desktop: "./missing.js" }));
      await expect(localCatalogue(root)).rejects.toThrow("missing.js");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
