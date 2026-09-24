import { defineConfig } from "vitest/config";
import { rendererBuild } from "../vite.renderer-build";

export default defineConfig({
  resolve: rendererBuild.resolve,
  define: { __TAU_AUTOMATION__: JSON.stringify(""), __TAU_BONJOUR_TYPE__: JSON.stringify("_tau._tcp") },
  test: { include: ["src/**/*.test.{ts,tsx}"] },
});
