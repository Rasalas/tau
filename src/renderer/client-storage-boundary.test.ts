import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `localStorage` is one `ClientStorage` implementation, not the renderer's
 * only store. `client-storage.ts` is the sole seam that reads it; every other
 * non-test module reaches storage through `ClientStorage` (a component calls
 * `useClientStorage`, a module-scope singleton calls `getClientStorage`).
 */
const ALLOWED = new Set(["src/renderer/client-storage.ts"]);

function listFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return /\.(ts|tsx)$/u.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
  });
}

describe("client storage boundary", () => {
  it("no renderer module outside the allow-list touches localStorage", () => {
    const root = "src/renderer";
    const offenders = listFiles(root)
      .filter((path) => statSync(path).isFile())
      .filter((path) => /\blocalStorage\b/u.test(readFileSync(path, "utf8")))
      .map((path) => path.replaceAll("\\", "/"))
      .filter((path) => !ALLOWED.has(path));
    expect(offenders).toEqual([]);
  });
});
