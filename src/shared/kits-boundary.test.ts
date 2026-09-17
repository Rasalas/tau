import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXTENSION_API_VERSION, satisfiesRange } from "./extension-compat.js";

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

/** Folder names under `kits/`; `package.json` and `README.md` are not kits. */
const kitDirectories = () => readdirSync("kits").sort().filter((name) => statSync(join("kits", name)).isDirectory());

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

  it("Review consumes Workspace contracts without importing its files", () => {
    const offenders = sourceFiles("kits/review")
      .filter((path) => !isTest(path))
      .filter((path) => specifiers(path).some((specifier) => specifier.includes("workspace/")));
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
        if (specifier.includes("kits/")) offenders.push(`${path}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the distribution pins the API version the kits declare", () => {
    const distribution = JSON.parse(readFileSync(join("kits", "package.json"), "utf8")) as {
      name: string; private: boolean; version: string; engines?: { api?: string }; files?: string[];
    };
    expect(distribution.name).toBe("@tau/kits");
    expect(distribution.private).toBe(true);
    expect(distribution.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(distribution.engines?.api).toBeDefined();
    expect(satisfiesRange(EXTENSION_API_VERSION, distribution.engines?.api as string)).toBe(true);
    expect(distribution.engines?.api).toMatch(/^\^\d+\.\d+\.\d+$/u);
    const minimum = distribution.engines?.api?.slice(1) ?? "";
    // A kit may keep an older additive API range, but every shipped kit must
    // accept the current host API. Kits that use a new seam raise their own
    // minimum (Review and Workspace use ^1.6.0).
    for (const name of kitDirectories()) {
      const manifest = JSON.parse(readFileSync(join("kits", name, "tau-extension.json"), "utf8")) as { engines?: { api?: string } };
      expect(manifest.engines?.api, name).toBeDefined();
      expect(satisfiesRange(EXTENSION_API_VERSION, manifest.engines?.api as string), name).toBe(true);
      expect(satisfiesRange(minimum, manifest.engines?.api as string), `${name} must support the distribution minimum ${minimum}`).toBe(true);
    }
  });

  it("every kit carries a manifest with an id, permissions and an entry", () => {
    for (const name of kitDirectories()) {
      const directory = join("kits", name);
      const manifest = JSON.parse(readFileSync(join(directory, "tau-extension.json"), "utf8")) as Record<string, unknown>;
      expect(manifest.id).toMatch(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u);
      expect(Array.isArray(manifest.permissions)).toBe(true);
      expect(Boolean(manifest.desktop) || Boolean(manifest.host)).toBe(true);
    }
  });
});
