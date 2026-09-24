import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { dedupeLegalComments } from "../vite.legal-comments";
import { stripIconKeys } from "../vite.icon-keys";
import { dropSvgAttributes } from "../vite.markdown-schema";
import { rendererBuild } from "../vite.renderer-build";
import { thirdPartyLicenses } from "../vite.third-party-licenses";

const here = fileURLToPath(new URL(".", import.meta.url));
const repository = fileURLToPath(new URL("..", import.meta.url));

/**
 * The app's web layer (`dist/`, which `cap sync` copies into both native
 * projects): the compact web client with a shell of its own around it.
 * `--mode development` adds the automation bridge the simulator scripts drive.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, here, "TAU_");
  return {
    root: here,
    plugins: [react(), stripIconKeys(), dropSvgAttributes(), dedupeLegalComments(), thirdPartyLicenses(repository)],
    resolve: rendererBuild.resolve,
    base: "./",
    define: {
      __TAU_AUTOMATION__: JSON.stringify(mode === "development" ? env.TAU_AUTOMATION_PORT ?? "9477" : ""),
      __TAU_BONJOUR_TYPE__: JSON.stringify(env.TAU_BONJOUR_TYPE ?? (mode === "development" ? "_tau-test._tcp" : "_tau._tcp")),
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: mode === "development",
      minify: "esbuild",
      target: rendererBuild.target,
      cssTarget: rendererBuild.cssTarget,
    },
    server: { fs: { allow: [repository] } },
  };
});
