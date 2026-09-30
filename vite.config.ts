import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dedupeLegalComments } from "./vite/legal-comments";
import { stripIconKeys } from "./vite/icon-keys";
import { packIconSet } from "./vite/icon-set";
import { mangleForGzip } from "./vite/mangle";
import { rendererBuild } from "./vite/renderer-build";
import { thirdPartyLicenses } from "./vite/third-party-licenses";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [react(), stripIconKeys(), packIconSet(), dedupeLegalComments(), mangleForGzip(), thirdPartyLicenses()],
  // The desktop page, src/renderer/index.html, is the dev server's and the build's index.
  root: path("src/renderer"),
  base: "./",
  build: {
    outDir: path("dist"),
    // Outside `root`, so Vite would otherwise leave the previous build's chunks in place.
    emptyOutDir: true,
    // Production assets are minified by default. Source maps are an explicit
    // opt-in for release debugging and are never silently shipped by start.
    sourcemap: mode === "development" || process.env.TAU_SOURCEMAP === "true",
    minify: "esbuild",
    rollupOptions: { output: rendererBuild.output, onwarn: rendererBuild.onwarn },
    // Electron reads chunks from disk, so a lazy chunk's scripts need no preload
    // list; only its stylesheets still have to be fetched with it.
    modulePreload: { resolveDependencies: (_file, dependencies) => dependencies.filter((dependency) => dependency.endsWith(".css")) },
    target: rendererBuild.target,
    cssTarget: rendererBuild.cssTarget,
    manifest: true,
  },
}));
