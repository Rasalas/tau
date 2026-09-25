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
    exclude: [
      ...configDefaults.exclude,
      "**/dist-electron/**",
      "**/dist-source/**",
      "**/release/**",
      "**/.tau-dev/**",
    ],
    globalSetup: ["./src/test-global-setup.ts"],
    setupFiles: ["./src/test-setup.ts"],
    // Several suites spawn their own bounded subprocess pools. Letting Vitest
    // occupy every core at the same time starves jsdom timers and makes the
    // integration assertions depend on host load. Fewer do not pay off on a
    // two-CPU runner either: two workers took a fifth longer there than four.
    maxWorkers: 4,
    // A budget, not a performance assertion. The suites that spawn real `git`
    // or activate every kit need a couple of seconds each when nothing else
    // runs and four times that under this pool's own load; 20 s turned ordinary
    // load into a red run, and both ci.yml and release.yml gate on this command.
    // A genuinely hung test still fails, only later. The real budgets live in
    // .github/workflows/performance.yml.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // 1 s by default; the same wait as src/test-setup.ts gives the DOM helpers and vi.waitFor.
    expect: { poll: { timeout: 5_000 } },
  },
});
