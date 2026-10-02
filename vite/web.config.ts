import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dedupeLegalComments } from "./legal-comments";
import { stripIconKeys } from "./icon-keys";
import { packIconSet } from "./icon-set";
import { mangleForGzip } from "./mangle";
import { rendererBuild } from "./renderer-build";
import { thirdPartyLicenses } from "./third-party-licenses";
import { browserConnectAssets } from "./browser-connect";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/**
 * The browser client (`dist-web/`), served by a listening host at its own root.
 * It shares every component with the Electron renderer; only the entry, the
 * platform and the HTML around it differ, so this config differs only there.
 */
export default defineConfig(({ mode }) => ({
  plugins: [react(), stripIconKeys(), packIconSet(), dedupeLegalComments(), mangleForGzip(), thirdPartyLicenses(), browserConnectAssets()],
  root: path("../src/web"),
  base: "/",
  // Favicon, touch icon and manifest, copied to the root as they are.
  publicDir: path("../src/web/public"),
  build: {
    outDir: path("../dist-web"),
    emptyOutDir: true,
    // The key keeps the entry chunk's name (`index.web-<hash>.js`) apart from the renderer's `index` chunks.
    rollupOptions: { input: { "index.web": path("../src/web/index.html") }, output: rendererBuild.output, onwarn: rendererBuild.onwarn },
    sourcemap: mode === "development" || process.env.TAU_SOURCEMAP === "true",
    minify: "esbuild",
    target: rendererBuild.target,
    cssTarget: rendererBuild.cssTarget,
    manifest: true,
  },
}));
