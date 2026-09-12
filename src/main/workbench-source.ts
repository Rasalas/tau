import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const TAU_PACKAGE_NAME = "tau-pi-desktop-prototype";
const SOURCE_MARKERS = ["scripts/build.mjs", "src/main/index.ts"] as const;
const BUILD_OUTPUTS = [
  "dist/index.html",
  "dist-electron/main/index.js",
  "dist-electron/preload/bundle.cjs",
  "dist-kits/manifest.json",
] as const;

interface WorkbenchSourceState {
  version: 1;
  root: string;
}

async function regularFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function tauPackage(root: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: unknown };
    return parsed.name === TAU_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/** Returns the canonical root only when the directory is this Tau source tree. */
export async function resolveTauSourceRoot(candidate: string): Promise<string | undefined> {
  let root: string;
  try { root = await realpath(candidate); } catch { return undefined; }
  if (!(await tauPackage(root))) return undefined;
  for (const marker of SOURCE_MARKERS) if (!(await regularFile(join(root, marker)))) return undefined;
  return root;
}

/** Build outputs the launcher needs before it can hand control to a checkout. */
export async function missingWorkbenchBuildOutput(root: string): Promise<string | undefined> {
  for (const output of BUILD_OUTPUTS) if (!(await regularFile(join(root, output)))) return output;
  return undefined;
}

export function workbenchSourceStatePath(userData: string): string {
  return join(userData, "workbench-source.json");
}

/** Activates a checkout atomically, so a crash cannot leave a partial pointer. */
export async function writeWorkbenchSourceRoot(userData: string, root: string): Promise<void> {
  const path = workbenchSourceStatePath(userData);
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify({ version: 1, root } satisfies WorkbenchSourceState, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/** Reads and revalidates the persisted checkout before the launcher imports it. */
export async function readWorkbenchSourceRoot(userData: string): Promise<string | undefined> {
  let state: WorkbenchSourceState;
  try { state = JSON.parse(await readFile(workbenchSourceStatePath(userData), "utf8")) as WorkbenchSourceState; } catch { return undefined; }
  if (state.version !== 1 || typeof state.root !== "string") return undefined;
  const root = await resolveTauSourceRoot(state.root);
  if (!root || await missingWorkbenchBuildOutput(root)) return undefined;
  try { await access(join(root, "dist-electron/main/index.js"), constants.R_OK); } catch { return undefined; }
  return root;
}
