import type { Plugin } from "vite";
import { minify } from "terser";

/** terser's compress and rename passes over esbuild's output, legal comments kept. */
export async function mangleChunk(code: string, sourceMap: boolean): Promise<{ code: string; map: string | null }> {
  const result = await minify(code, { module: true, ecma: 2020, compress: { passes: 3 }, mangle: true, format: { wrap_func_args: false }, sourceMap });
  return { code: result.code ?? code, map: typeof result.map === "string" ? result.map : null };
}

/**
 * Compresses and renames once more after esbuild has minified a chunk. terser
 * finds code esbuild keeps. Three compression passes fold expressions exposed
 * by earlier passes, keeping the desktop and browser builds within their gzip budgets.
 * It picks short names by character frequency, which gzip rewards.
 */
export function mangleForGzip(): Plugin {
  let enabled = false;
  return {
    name: "tau-mangle-for-gzip",
    apply: "build",
    configResolved(config) {
      enabled = config.build.minify === "esbuild";
    },
    renderChunk: {
      // After Vite's minifier, whose renderChunk is unordered.
      order: "post",
      async handler(code, _chunk, options) {
        if (!enabled) return null;
        return mangleChunk(code, Boolean(options.sourcemap));
      },
    },
  };
}
