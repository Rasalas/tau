import { build } from "esbuild";
import { join } from "node:path";
import type { Plugin } from "vite";
import { loadBundledKitDesktopHalves } from "../src/main/bundled-kits";
import { SHARED_MODULE_PACKAGES } from "../src/shared/shared-modules";

const MODULE = "virtual:tau-trusted-kits";

/** The native client ships its own allowlist and executable copies of the kits. */
export function trustedKits(appPath: string): Plugin {
  let catalogue: Promise<string> | undefined;
  return {
    name: "tau-trusted-kits",
    resolveId: (id) => id === MODULE ? `\0${MODULE}` : undefined,
    load(id) {
      if (id !== `\0${MODULE}`) return undefined;
      catalogue ??= localCatalogue(appPath);
      return catalogue;
    },
  };
}

export async function localCatalogue(appPath: string): Promise<string> {
  const sharedExports: Record<string, string[]> = {};
  for (const specifier of SHARED_MODULE_PACKAGES) sharedExports[specifier] = Object.keys(await import(specifier));
  const api = await build({
    entryPoints: [join(appPath, "src/renderer/extension-api.ts")], bundle: true, write: false,
    format: "esm", platform: "browser", target: "es2022", metafile: true, logLevel: "silent",
    external: [...SHARED_MODULE_PACKAGES],
    plugins: [{ name: "assets-are-external", setup(builder) {
      builder.onResolve({ filter: /\.(svg|png|jpe?g|webp|gif|css)(\?.*)?$/ }, (args) => ({ path: args.path, external: true }));
    } }],
  });
  sharedExports.tau = Object.values(api.metafile.outputs)[0]!.exports;
  const result = await loadBundledKitDesktopHalves({ appPath, sharedExports });
  if (result.errors.length) throw new Error(result.errors.map((error) => `${error.path}: ${error.message}`).join("\n"));
  if (!result.bundles.length) throw new Error("The native client needs its shipped desktop extensions.");
  return `export default ${JSON.stringify(result.bundles)};`;
}
