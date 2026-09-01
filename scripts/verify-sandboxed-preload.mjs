import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const file = resolve(process.argv[2] ?? "dist-electron/preload/index.cjs");
const source = await readFile(file, "utf8");
const relativeRequire = source.match(/\brequire\(["']\.{1,2}[\\/]/u)?.[0];

if (relativeRequire) {
  throw new Error(`Sandboxed preload contains a local runtime import: ${relativeRequire}`);
}
