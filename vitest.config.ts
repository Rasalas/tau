import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // The API modules a kit imports, resolved the way the bundlers resolve them.
  resolve: {
    alias: {
      "tau/host-extension": source("./src/main/host-extension-api.ts"),
      "tau/host": source("./src/main/host-extension-worker-protocol.ts"),
      tau: source("./src/renderer/extension-api.ts"),
    },
  },
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
