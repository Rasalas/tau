import type { Plugin } from "vite";
import { minify } from "terser";

/** terser's compress and rename passes over esbuild's output, legal comments kept. */
export async function mangleChunk(code: string, sourceMap: boolean): Promise<{ code: string; map: string | null }> {
  const result = await minify(code, { module: true, ecma: 2020, compress: true, mangle: true, format: { wrap_func_args: false }, sourceMap });
  return { code: result.code ?? code, map: typeof result.map === "string" ? result.map : null };
}

/**
 * Compresses and renames once more after esbuild has minified a chunk. terser
 * finds code esbuild keeps. One compression pass avoids spending seconds on
 * further passes for a few hundred gzip bytes. It picks short names by how
 * often each character occurs in the chunk, which gzip rewards.
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
