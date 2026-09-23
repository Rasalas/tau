import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dedupeLegalComments } from "./vite.legal-comments";
import { stripIconKeys } from "./vite.icon-keys";
import { rendererBuild } from "./vite.renderer-build";

/**
 * The browser client (`dist-web/`), served by a listening host at its own root.
 * It shares every component with the Electron renderer; only the entry, the
 * platform and the HTML around it differ, so this config differs only there.
 */
export default defineConfig(({ mode }) => ({
  plugins: [react(), stripIconKeys(), dedupeLegalComments()],
  resolve: rendererBuild.resolve,
  base: "/",
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL("index.web.html", import.meta.url)) },
    sourcemap: mode === "development" || process.env.TAU_SOURCEMAP === "true",
    minify: "esbuild",
    target: rendererBuild.target,
    cssTarget: rendererBuild.cssTarget,
    manifest: true,
  },
}));
