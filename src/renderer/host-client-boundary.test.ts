import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Electron IPC is one HostClient implementation, not the renderer's only
 * transport. `main.tsx` is the sole seam that reads `window.tau`; every other
 * non-test module reaches the host through `HostClient` (a component calls
 * `useHostClient`, a module-scope singleton calls `getHostClient`) and the
 * machine through `Platform`.
 */
const ALLOWED = new Set(["src/renderer/main.tsx"]);

function listFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return /\.(ts|tsx)$/u.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
  });
}

describe("host client boundary", () => {
  it("no client module outside the allow-list touches window.tau", () => {
    const offenders = ["src/renderer", "src/workbench"].flatMap(listFiles)
      .filter((path) => statSync(path).isFile())
      .filter((path) => readFileSync(path, "utf8").includes("window.tau"))
      .map((path) => path.replaceAll("\\", "/"))
      .filter((path) => !ALLOWED.has(path));
    expect(offenders).toEqual([]);
  });
});
