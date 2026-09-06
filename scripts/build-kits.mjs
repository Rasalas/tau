#!/usr/bin/env node
// Prebuilds every kit under `kits/` into `dist-kits/<id>/`, with the same
// esbuild options the package loaders use at runtime — the bundlers themselves
// are imported from the compiled main modules, so there is one implementation.
//
// The shipped app has no `kits/` and no toolchain: it reads `dist-kits/`.
import { build } from "esbuild";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = join(ROOT, "kits");
const OUTPUT = join(ROOT, "dist-kits");
const MAIN = join(ROOT, "dist-electron/main");
const watch = process.argv.includes("--watch");

const { MANIFEST_FILE, bundleHostExtension, parseExtensionManifest } = await import(join(MAIN, "extension-packages.js"));
const { bundleDesktopExtension } = await import(join(MAIN, "desktop-extensions.js"));
const { SHARED_MODULE_PACKAGES } = await import(join(ROOT, "dist-electron/shared/shared-modules.js"));

/**
 * Export names of the modules a desktop bundle imports by bare name. The
 * renderer reports these from its own copies at runtime; here they are read
 * from the same modules, so a prebuilt bundle binds exactly what a
 * compiled-on-the-fly one would.
 */
async function sharedExportNames() {
  const names = {};
  for (const specifier of SHARED_MODULE_PACKAGES) {
    names[specifier] = Object.keys(await import(specifier));
  }
  const result = await build({
    entryPoints: [join(ROOT, "src/renderer/extension-api.ts")],
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
    metafile: true, logLevel: "silent", external: [...SHARED_MODULE_PACKAGES],
    // Only the export names matter here. Vite resolves the icons and images the
    // API's components import; esbuild has no loader for them, so they stay out.
    plugins: [{
      name: "assets-are-external",
      setup(api) {
        api.onResolve({ filter: /\.(svg|png|jpe?g|webp|gif|css)(\?.*)?$/ }, (args) => ({ path: args.path, external: true }));
      },
    }],
  });
  names.tau = Object.values(result.metafile.outputs)[0].exports;
  return names;
}

async function kitDirectories() {
  const names = await readdir(SOURCE).catch(() => []);
  const found = [];
  for (const name of names.sort()) {
    if (name.startsWith(".") || name.startsWith("_") || name === "node_modules") continue;
    const directory = join(SOURCE, name);
    if (!await stat(directory).then((info) => info.isDirectory()).catch(() => false)) continue;
    const manifest = await readFile(join(directory, MANIFEST_FILE), "utf8").catch(() => undefined);
    if (manifest !== undefined) found.push({ directory, source: manifest });
  }
  return found;
}

async function buildKits() {
  const sharedExports = await sharedExportNames();
  const kits = await kitDirectories();
  await rm(OUTPUT, { recursive: true, force: true });
  for (const kit of kits) {
    const { manifest, hostEntry, desktopEntry, stylesEntry } = parseExtensionManifest(kit.directory, kit.source);
    const target = join(OUTPUT, manifest.id);
    await mkdir(target, { recursive: true });
    const shipped = { ...manifest };
    if (hostEntry) {
      await writeFile(join(target, "host.cjs"), await bundleHostExtension(hostEntry), "utf8");
      shipped.host = "./host.cjs";
    }
    if (desktopEntry) {
      await writeFile(join(target, "desktop.js"), await bundleDesktopExtension(desktopEntry, { sharedExports }), "utf8");
      shipped.desktop = "./desktop.js";
    }
    if (stylesEntry) {
      // Copied, not compiled: a kit's stylesheet is plain CSS the renderer links.
      await writeFile(join(target, "styles.css"), await readFile(stylesEntry, "utf8"), "utf8");
      shipped.styles = "./styles.css";
    }
    await writeFile(join(target, MANIFEST_FILE), `${JSON.stringify(shipped, null, 2)}\n`, "utf8");
    console.log(`kit ${manifest.id} -> dist-kits/${manifest.id}`);
  }
  return kits.length;
}

const count = await buildKits().catch((error) => {
  // A watch keeps running through a kit that does not compile; a build does not.
  if (!watch) throw error;
  console.error(error.message);
  return 0;
});
console.log(`Prebuilt ${count} kit${count === 1 ? "" : "s"}.`);

if (watch) {
  const { watch: watchDirectory } = await import("node:fs");
  let pending;
  watchDirectory(SOURCE, { recursive: true }, () => {
    clearTimeout(pending);
    pending = setTimeout(() => { void buildKits().catch((error) => console.error(error.message)); }, 120);
  });
}
