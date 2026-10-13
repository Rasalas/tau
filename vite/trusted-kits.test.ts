import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localCatalogue, trustedKits } from "./trusted-kits";

describe("native client's shipped kit catalogue", () => {
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
