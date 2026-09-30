import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { defineConfig } from "vitest/config";

const repository = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  define: { TAU_AUTOMATION_PORT: JSON.stringify(""), TAU_BONJOUR_TYPE: JSON.stringify("_tau._tcp") },
  // The app imports the workbench from the repository around it.
  server: { fs: { allow: [repository, realpathSync(new URL("../node_modules", import.meta.url))] } },
  test: { include: ["src/**/*.test.{ts,tsx}"], setupFiles: ["../src/test-setup.ts"] },
});
