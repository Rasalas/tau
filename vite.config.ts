import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
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
