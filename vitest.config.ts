import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/dist-electron/**"],
    setupFiles: ["./src/test-setup.ts"],
    // Several suites spawn their own bounded subprocess pools. Letting Vitest
    // occupy every core at the same time starves jsdom timers and makes the
    // integration assertions depend on host load.
    maxWorkers: 4,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
