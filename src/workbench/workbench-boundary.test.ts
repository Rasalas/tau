import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The workbench is the client Tau would still be without Electron and without
 * React: threads, transcript, composer scopes, notices, the connection. It may
 * not import a view library, an Electron module or a browser global. Anything
 * that needs one belongs in `src/renderer/` or behind `Platform`.
 */
const ROOT = "src/workbench";

/** Browser and Electron globals. `document`/`navigator` are not `Platform`'s job either. */
const FORBIDDEN: Array<{ label: string; test: RegExp }> = [
  { label: "react import", test: /from\s+["']react(\/[\w-]+)?["']/u },
  { label: "electron import", test: /from\s+["']electron(\/[\w-]+)?["']/u },
  { label: "renderer import", test: /from\s+["']\.\.\/renderer\//u },
  { label: "main import", test: /from\s+["']\.\.\/main\//u },
  { label: "window", test: /(^|[^.\w])window\s*[.[]/u },
  { label: "document", test: /(^|[^.\w])document\s*[.[]/u },
  { label: "localStorage", test: /(^|[^.\w])localStorage\b/u },
  { label: "navigator", test: /(^|[^.\w])navigator\s*\./u },
];

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return /\.tsx?$/u.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
  });
}

/** Comments and strings may say "window"; only code counts. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/[^\n]*/gmu, "")
    .replace(/`(?:[^`\\]|\\[\s\S])*`/gu, "``");
}

describe("workbench boundary", () => {
  const files = listFiles(ROOT);

  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const rule of FORBIDDEN) {
    it(`no workbench module names ${rule.label}`, () => {
      const offenders = files
        .filter((path) => rule.test.test(code(readFileSync(path, "utf8"))))
        .map((path) => path.replaceAll("\\", "/"));
      expect(offenders).toEqual([]);
    });
  }

  it("no workbench module has a .tsx file", () => {
    expect(files.filter((path) => path.endsWith(".tsx"))).toEqual([]);
  });
});
