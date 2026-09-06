import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The wall around `kits/`. A kit is a package Tau ships (ADR 0014), so it may
 * only reach core through the modules a package can reach: `tau`,
 * `tau/host-extension` and `tau/host`. Core may not reach into a kit at all —
 * it loads them from disk, the way it loads an installed package.
 */
const API_MODULES = ["tau", "tau/host-extension", "tau/host"];
/** Harnesses a kit's own tests may reach for; nothing else of `src/` is theirs. */
const TEST_HARNESSES = ["src/main/test-support/", "src/renderer/test-support/"];

const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.[cm]?[jt]sx?$/u.test(name)) found.push(path);
    }
  };
  walk(root);
  return found;
}

function specifiers(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT)) found.push(match[1] ?? match[2]);
  return found;
}

const isTest = (path: string) => /\.test\.[cm]?[jt]sx?$/u.test(path);

describe("kits boundary", () => {
  it("a kit names no Tau module but the three API modules", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles("kits")) {
      for (const specifier of specifiers(path)) {
        if (!/^tau(\/|$)/u.test(specifier) || API_MODULES.includes(specifier)) continue;
        offenders.push(`${path}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("a kit's relative imports stay inside kits/", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles("kits")) {
      for (const specifier of specifiers(path)) {
        if (!specifier.startsWith(".")) continue;
        const resolved = join(path, "..", specifier);
        if (resolved.startsWith("kits/")) continue;
        // A test may reach the two harnesses core keeps for kits, nothing else.
        if (isTest(path) && TEST_HARNESSES.some((allowed) => resolved.startsWith(allowed))) continue;
        offenders.push(`${path}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("a kit ships no test harness in the code it loads", () => {
    const offenders = sourceFiles("kits")
      .filter((path) => !isTest(path))
      .filter((path) => specifiers(path).some((specifier) => specifier.includes("test-support")));
    expect(offenders).toEqual([]);
  });

  it("core imports no kit", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles("src")) {
      for (const specifier of specifiers(path)) {
        if (specifier.includes("kits/") && !specifier.includes("/kits/test")) offenders.push(`${path}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every kit carries a manifest with an id, permissions and an entry", () => {
    for (const name of readdirSync("kits").sort()) {
      const directory = join("kits", name);
      if (!statSync(directory).isDirectory()) continue;
      const manifest = JSON.parse(readFileSync(join(directory, "tau-extension.json"), "utf8")) as Record<string, unknown>;
      expect(manifest.id).toMatch(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u);
      expect(Array.isArray(manifest.permissions)).toBe(true);
      expect(Boolean(manifest.desktop) || Boolean(manifest.host)).toBe(true);
    }
  });
});
