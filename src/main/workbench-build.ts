import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { WorkbenchBuildResult } from "../shared/contracts.js";

async function digestDirectory(directory: string): Promise<string> {
  const hash = createHash("sha1");
  let names: string[] = [];
  try { names = (await readdir(directory, { recursive: true })).sort(); } catch { return ""; }
  for (const name of names) {
    if (!/\.(js|cjs|mjs)$/u.test(name)) continue;
    hash.update(name);
    try { hash.update(await readFile(join(directory, name))); } catch { /* removed mid-scan */ }
  }
  return hash.digest("hex");
}

/**
 * Rebuilds the workbench from source, the way `npm run build` does, without
 * leaving the app. The renderer can reload its bundle afterwards; the main
 * process cannot, so the caller is told when that side changed.
 */
export async function rebuildWorkbench(root: string, options: { onOutput?(line: string): void; execPath?: string } = {}): Promise<WorkbenchBuildResult> {
  const startedAt = performance.now();
  const electronDir = join(root, "dist-electron");
  const before = await digestDirectory(electronDir);
  const output: string[] = [];
  const ok = await new Promise<boolean>((resolve) => {
    const child = execFile(
      options.execPath ?? process.execPath,
      [join(root, "scripts", "build.mjs")],
      {
        cwd: root,
        maxBuffer: 16 * 1024 * 1024,
        // The build runs the electron binary as plain node, and so do the
        // tsc and vite processes it spawns with the same executable.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
      (error) => resolve(!error),
    );
    const collect = (chunk: Buffer | string) => {
      for (const line of String(chunk).split(/\r?\n/u)) {
        if (!line.trim()) continue;
        output.push(line);
        options.onOutput?.(line);
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
  });
  const after = await digestDirectory(electronDir);
  return {
    ok,
    durationMs: Math.round(performance.now() - startedAt),
    mainChanged: ok && before !== after,
    output: output.slice(-40).join("\n"),
  };
}
