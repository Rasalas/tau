import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT = join(ROOT, "dist-source");
const INPUTS = [
  "src",
  "kits",
  "scripts",
  "assets",
  "package.json",
  "package-lock.json",
  "index.html",
  "tsconfig.json",
  "tsconfig.electron.json",
  "tsconfig.examples.json",
  "tsconfig.extension.json",
  "tsconfig.kits.json",
  "tsconfig.pi-extensions.json",
  "vite.config.ts",
  "vitest.config.ts",
];

await rm(OUTPUT, { recursive: true, force: true });
await mkdir(OUTPUT, { recursive: true });
for (const input of INPUTS) await cp(join(ROOT, input), join(OUTPUT, input), { recursive: true });
console.log("Prepared editable Tau source.");
