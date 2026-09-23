import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dedupeLegalComments } from "./vite.legal-comments";
import { stripIconKeys } from "./vite.icon-keys";

export default defineConfig(({ mode }) => ({
  plugins: [react(), stripIconKeys(), dedupeLegalComments()],
  // The polyfill's 3 KB sat in the initial script behind a native call.
  resolve: { alias: { "@ungap/structured-clone": fileURLToPath(new URL("src/renderer/components/structured-clone.ts", import.meta.url)) } },
  base: "./",
  build: {
    outDir: "dist",
    // Production assets are minified by default. Source maps are an explicit
    // opt-in for release debugging and are never silently shipped by start.
    sourcemap: mode === "development" || process.env.TAU_SOURCEMAP === "true",
    minify: "esbuild",
    manifest: true,
  },
}));
