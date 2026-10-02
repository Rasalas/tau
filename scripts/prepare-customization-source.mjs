import { cp, mkdir, rm, stat } from "node:fs/promises";
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
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
  "vite",
  "tooling",
];
// What the copy never builds: the plugins' tests and the packaging config.
const LEFT_OUT = { vite: /\.test\.ts$/, tooling: /electron-builder\.yml$/ };

await rm(OUTPUT, { recursive: true, force: true });
await mkdir(OUTPUT, { recursive: true });
for (const input of INPUTS) {
  await cp(join(ROOT, input), join(OUTPUT, input), { recursive: true, filter: (source) => !LEFT_OUT[input]?.test(source) });
}
// Rebuilding a managed Linux source overlay reuses the signed release's helpers.
// It never asks the person to install Rust just to keep their existing capture integration.
for (const backend of ["kde", "hyprland"]) {
  const name = `tau-${backend}-snapshot`;
  const source = join(ROOT, "dist-kits", "tau.snapshots", "wayland-helpers", name);
  if (await stat(source).catch(() => undefined)) {
    const destination = join(OUTPUT, ".tau-native", "bundled");
    await mkdir(destination, { recursive: true });
    await cp(source, join(destination, name));
  }
}
console.log("Prepared editable Tau source.");
