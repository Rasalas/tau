import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dedupeLegalComments } from "./vite.legal-comments";
import { stripIconKeys } from "./vite.icon-keys";
import { rendererBuild } from "./vite.renderer-build";

export default defineConfig(({ mode }) => ({
  plugins: [react(), stripIconKeys(), dedupeLegalComments()],
  resolve: rendererBuild.resolve,
  base: "./",
  build: {
    outDir: "dist",
    // Production assets are minified by default. Source maps are an explicit
    // opt-in for release debugging and are never silently shipped by start.
    sourcemap: mode === "development" || process.env.TAU_SOURCEMAP === "true",
    minify: "esbuild",
    target: rendererBuild.target,
    cssTarget: rendererBuild.cssTarget,
    manifest: true,
  },
}));
