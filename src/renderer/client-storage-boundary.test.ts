import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `localStorage` is one `ClientStorage` implementation, not the workbench's
 * only store. The platform module is the sole seam that reads it; every other
 * non-test module reaches storage through `ClientStorage` (a component calls
 * `useClientStorage`, a module-scope singleton calls `getClientStorage`).
 */
const ALLOWED = new Set(["src/renderer/platform-electron.ts"]);

function listFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return /\.(ts|tsx)$/u.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
  });
}

describe("client storage boundary", () => {
  it("no client module outside the allow-list touches localStorage", () => {
    const offenders = ["src/renderer", "src/workbench"].flatMap(listFiles)
      .filter((path) => statSync(path).isFile())
      .filter((path) => /\blocalStorage\b/u.test(readFileSync(path, "utf8")))
      .map((path) => path.replaceAll("\\", "/"))
      .filter((path) => !ALLOWED.has(path));
    expect(offenders).toEqual([]);
  });
});
