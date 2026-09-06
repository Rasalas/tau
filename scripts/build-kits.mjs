#!/usr/bin/env node
// Prebuilds every kit under `kits/` into `dist-kits/<id>/`, with the same
// esbuild options the package loaders use at runtime — the bundlers themselves
// are imported from the compiled main modules, so there is one implementation.
//
// The shipped app has no `kits/` and no toolchain: it reads `dist-kits/`.
//
// `kits/package.json` names the distribution (`@tau/kits`) and its `files` list
// is the shape of `dist-kits/`; writing a file it does not cover fails the build.
import { build } from "esbuild";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = join(ROOT, "kits");
const OUTPUT = join(ROOT, "dist-kits");
const MAIN = join(ROOT, "dist-electron/main");
/** The distribution index the app reads for the version of the set it ships. */
const INDEX_FILE = "manifest.json";
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

/** `files` matcher: `*` covers one path segment, which is all the list needs. */
function shipped(patterns, relative) {
  return patterns.some((pattern) => {
    const expression = pattern.split("/").map((part) => part.replaceAll("*", "[^/]*")).join("/");
    return new RegExp(`^${expression}$`, "u").test(relative);
  });
}

async function buildKits() {
  const distribution = JSON.parse(await readFile(join(SOURCE, "package.json"), "utf8"));
  const sharedExports = await sharedExportNames();
  const kits = await kitDirectories();
  await rm(OUTPUT, { recursive: true, force: true });
  const write = async (relative, contents) => {
    if (!shipped(distribution.files, relative)) {
      throw new Error(`dist-kits/${relative} is not covered by the "files" list in kits/package.json.`);
    }
    await writeFile(join(OUTPUT, relative), contents, "utf8");
  };
  const ids = [];
  for (const kit of kits) {
    const { manifest, hostEntry, desktopEntry, stylesEntry } = parseExtensionManifest(kit.directory, kit.source);
    await mkdir(join(OUTPUT, manifest.id), { recursive: true });
    const shippedManifest = { ...manifest };
    if (hostEntry) {
      await write(`${manifest.id}/host.cjs`, await bundleHostExtension(hostEntry));
      shippedManifest.host = "./host.cjs";
    }
    if (desktopEntry) {
      await write(`${manifest.id}/desktop.js`, await bundleDesktopExtension(desktopEntry, { sharedExports }));
      shippedManifest.desktop = "./desktop.js";
    }
    if (stylesEntry) {
      // Copied, not compiled: a kit's stylesheet is plain CSS the renderer links.
      await write(`${manifest.id}/styles.css`, await readFile(stylesEntry, "utf8"));
      shippedManifest.styles = "./styles.css";
    }
    await write(`${manifest.id}/${MANIFEST_FILE}`, `${JSON.stringify(shippedManifest, null, 2)}\n`);
    ids.push(manifest.id);
    console.log(`kit ${manifest.id} -> dist-kits/${manifest.id}`);
  }
  // The version belongs to the set, not to a kit: each kit keeps its own
  // `version` in its own manifest, and the index says which distribution
  // shipped them together.
  const index = { name: distribution.name, version: distribution.version, engines: distribution.engines, kits: ids.sort() };
  await mkdir(OUTPUT, { recursive: true });
  await write(INDEX_FILE, `${JSON.stringify(index, null, 2)}\n`);
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
