import type { Plugin } from "vite";
import { minify } from "terser";

/** terser's renaming alone: no other rewrite of the code, legal comments kept. */
export async function mangleChunk(code: string, sourceMap: boolean): Promise<{ code: string; map: string | null }> {
  const result = await minify(code, { module: true, ecma: 2020, compress: false, mangle: true, sourceMap });
  return { code: result.code ?? code, map: typeof result.map === "string" ? result.map : null };
}

/**
 * Renames local names once more after esbuild has minified a chunk. terser picks
 * short names by how often each character occurs in the chunk, which gzip rewards.
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
