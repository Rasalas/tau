import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { esbuildBinaryPath, unpackedPath } from "./packaged-app.js";

describe("unpackedPath", () => {
  it("points a path inside the archive at the copy beside it", () => {
    expect(unpackedPath(join(sep, "Apps", "Tau.app", "Contents", "Resources", "app.asar", "dist-electron", "main", "worker.cjs")))
      .toBe(join(sep, "Apps", "Tau.app", "Contents", "Resources", "app.asar.unpacked", "dist-electron", "main", "worker.cjs"));
  });

  it("leaves a path outside an archive alone", () => {
    const path = join(sep, "repo", "dist-electron", "main", "worker.cjs");
    expect(unpackedPath(path)).toBe(path);
  });
});

describe("esbuildBinaryPath", () => {
  async function scopedPackage(subpath: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "tau-esbuild-"));
    const modules = join(root, "node_modules");
    const binary = join(modules, "@esbuild", "some-platform", subpath);
    await mkdir(join(binary, ".."), { recursive: true });
    await writeFile(binary, "");
    return modules;
  }

  it("finds the unix binary of the one installed platform package", async () => {
    const modules = await scopedPackage(join("bin", "esbuild"));
    expect(esbuildBinaryPath(() => join(modules, "esbuild", "lib", "main.js")))
      .toBe(join(modules, "@esbuild", "some-platform", "bin", "esbuild"));
  });

  it("finds the Windows binary, which sits at the package root", async () => {
    const modules = await scopedPackage("esbuild.exe");
    expect(esbuildBinaryPath(() => join(modules, "esbuild", "lib", "main.js")))
      .toBe(join(modules, "@esbuild", "some-platform", "esbuild.exe"));
  });

  it("answers with nothing when esbuild cannot be resolved", () => {
    expect(esbuildBinaryPath(() => { throw new Error("not installed"); })).toBeUndefined();
  });

  it("answers with nothing when no platform package is installed", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-esbuild-"));
    expect(esbuildBinaryPath(() => join(root, "node_modules", "esbuild", "lib", "main.js"))).toBeUndefined();
  });
});

describe("the esbuild redirect", () => {
  // The redirect only works if it runs before esbuild's own module body, and a
  // module evaluates its imports in source order.
  const importers = ["desktop-extensions.ts", "extension-packages.ts", "host-extension-isolation.ts"];
  const read = (name: string) => readFileSync(join(import.meta.dirname, name), "utf8");
  const redirectAt = (source: string) => Math.max(source.indexOf('from "./packaged-app.js"'), source.indexOf('import "./packaged-app.js"'));

  for (const file of importers) {
    it(`${file} imports packaged-app before esbuild`, () => {
      const source = read(file);
      expect(redirectAt(source)).toBeGreaterThanOrEqual(0);
      expect(redirectAt(source)).toBeLessThan(source.indexOf('from "esbuild"'));
    });
  }

  it("every module of the host that imports esbuild is listed here", () => {
    const users = readdirSync(import.meta.dirname, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) => read(name).includes('from "esbuild"'));
    expect(users.sort()).toEqual([...importers].sort());
  });
});
