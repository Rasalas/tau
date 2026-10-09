import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { NO_BUNDLED_KITS, inspectBundledKits, loadBundledKitDesktopHalves, readKitDistribution } from "./bundled-kits.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const kit = { id: "acme.kit", name: "Acme", version: "1.0.0", engines: { api: "^1.0.0" }, permissions: [], desktop: "./desktop.js" };

/** An app root with one kit under `dist-kits/`, as `scripts/build-kits.mjs` writes it. */
async function appPath(index?: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tau-kits-"));
  roots.push(root);
  await mkdir(join(root, "dist-kits", kit.id), { recursive: true });
  await writeFile(join(root, "dist-kits", kit.id, "tau-extension.json"), JSON.stringify(kit), "utf8");
  if (index !== undefined) await writeFile(join(root, "dist-kits", "manifest.json"), JSON.stringify(index), "utf8");
  return root;
}

describe("the bundled distribution", () => {
  it("reports the name and version of the set beside the kits in it", async () => {
    const result = await inspectBundledKits({ appPath: await appPath({ name: "@tau/kits", version: "0.1.0", kits: [kit.id] }) });
    expect(result.distribution).toEqual({ name: "@tau/kits", version: "0.1.0" });
    expect(result.packages.map((entry) => entry.id)).toEqual([kit.id]);
    expect(result.packages[0].scope).toBe("bundled");
  });

  it("still loads the kits when the index is missing or unreadable", async () => {
    expect((await inspectBundledKits({ appPath: await appPath() })).distribution).toBeUndefined();
    const broken = await inspectBundledKits({ appPath: await appPath("{ not json") });
    expect(broken.distribution).toBeUndefined();
    expect(broken.packages).toHaveLength(1);
  });

  it("reads the sources' own package.json when nothing was prebuilt", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-kits-"));
    roots.push(root);
    await mkdir(join(root, "kits"), { recursive: true });
    await writeFile(join(root, "kits", "package.json"), JSON.stringify({ name: "@tau/kits", version: "9.9.9" }), "utf8");
    expect(await readKitDistribution({ directory: join(root, "kits"), prebuilt: false }))
      .toEqual({ name: "@tau/kits", version: "9.9.9" });
  });

  it("sends a prebuilt desktop half with a link to its map, not the map itself", async () => {
    const root = await appPath();
    const entry = join(root, "dist-kits", kit.id, "desktop.js");
    await writeFile(entry, "export default {};\n//# sourceMappingURL=desktop.js.map\n", "utf8");
    const { bundles } = await loadBundledKitDesktopHalves({ appPath: root, sharedExports: {} });
    expect(bundles[0].code).toBe(`export default {};\n//# sourceMappingURL=${pathToFileURL(`${entry}.map`).href}\n`);
  });

  it("sends the manifest's engines with a desktop half, for a client older than its host", async () => {
    const root = await appPath();
    await writeFile(join(root, "dist-kits", kit.id, "desktop.js"), "export default {};\n", "utf8");
    const { bundles } = await loadBundledKitDesktopHalves({ appPath: root, sharedExports: {} });
    expect(bundles[0].engines).toEqual({ api: "^1.0.0" });
  });

  it("says nothing about a distribution in safe mode", () => {
    expect(NO_BUNDLED_KITS).toEqual({ packages: [] });
  });
});
