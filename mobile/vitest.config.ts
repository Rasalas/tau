import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { rendererBuild } from "../vite.renderer-build";

const repository = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  resolve: rendererBuild.resolve,
  define: { __TAU_AUTOMATION__: JSON.stringify(""), __TAU_BONJOUR_TYPE__: JSON.stringify("_tau._tcp") },
  // The app imports the workbench from the repository around it.
  server: { fs: { allow: [repository] } },
  test: { include: ["src/**/*.test.{ts,tsx}"], setupFiles: ["../src/test-setup.ts"] },
});
