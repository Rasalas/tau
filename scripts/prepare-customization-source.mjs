import { cp, mkdir, readdir, rm } from "node:fs/promises";
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
  "index.web.html",
  "tsconfig.json",
  "tsconfig.electron.json",
  "tsconfig.examples.json",
  "tsconfig.extension.json",
  "tsconfig.kits.json",
  "tsconfig.pi-extensions.json",
  "vitest.config.ts",
];
// Every Vite config and plugin next to it, so a new plugin cannot break building the copy.
const VITE_FILES = (await readdir(ROOT)).filter((name) => /^vite\..+\.ts$/.test(name) && !name.endsWith(".test.ts"));

await rm(OUTPUT, { recursive: true, force: true });
await mkdir(OUTPUT, { recursive: true });
for (const input of [...INPUTS, ...VITE_FILES]) await cp(join(ROOT, input), join(OUTPUT, input), { recursive: true });
console.log("Prepared editable Tau source.");
