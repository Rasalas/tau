import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { appPackageVersion, esbuildBinaryPath, unpackedPath } from "./packaged-app.js";

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

describe("appPackageVersion", () => {
  // `resources/app.asar` stands in for the archive as Electron's fs shows it; the unpacked copy has no package.json.
  async function packagedResources(): Promise<string> {
    const resources = join(await mkdtemp(join(tmpdir(), "tau-packaged-")), "opt", "tau", "resources");
    await mkdir(join(resources, "app.asar"), { recursive: true });
    await writeFile(join(resources, "app.asar", "package.json"), JSON.stringify({ name: "tau", version: "0.7.1" }));
    await mkdir(join(resources, "app.asar.unpacked", "dist-electron", "main"), { recursive: true });
    return resources;
  }

  it("reads the archive's package.json for a host started from app.asar.unpacked", async () => {
    const resources = await packagedResources();
    expect(appPackageVersion(join(resources, "app.asar.unpacked"))).toBe("0.7.1");
  });

  it("reads a checkout's own package.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-checkout-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.8.0-dev" }));
    expect(appPackageVersion(root)).toBe("0.8.0-dev");
  });

  it("looks beside no other folder than app.asar.unpacked", async () => {
    const resources = await packagedResources();
    await mkdir(join(resources, "app"), { recursive: true });
    expect(appPackageVersion(join(resources, "app"))).toBeUndefined();
  });

  it("answers with nothing when no package.json names a version", async () => {
    const resources = await packagedResources();
    await writeFile(join(resources, "app.asar", "package.json"), "{}");
    expect(appPackageVersion(join(resources, "app.asar.unpacked"))).toBeUndefined();
  });
});

describe("esbuildBinaryPath", () => {
  // `<root>/app/main.js` resolves esbuild from `<root>/node_modules`, as dist-electron does in the app.
  async function tree(files: string[]): Promise<{ root: string; from: string }> {
    // Resolution answers with real paths, and macOS's tmpdir is behind a symlink.
    const root = await realpath(await mkdtemp(join(tmpdir(), "tau-esbuild-")));
    const esbuild = join(root, "node_modules", "esbuild");
    await mkdir(join(esbuild, "lib"), { recursive: true });
    await writeFile(join(esbuild, "package.json"), JSON.stringify({ name: "esbuild", main: "lib/main.js" }));
    await writeFile(join(esbuild, "lib", "main.js"), "");
    for (const file of files) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), "");
    }
    return { root, from: join(root, "app", "main.js") };
  }

  it("finds the binary for this platform where npm hoists it", async () => {
    const { root, from } = await tree(["node_modules/@esbuild/darwin-x64/bin/esbuild"]);
    expect(esbuildBinaryPath(from, "darwin-x64")).toBe(join(root, "node_modules", "@esbuild", "darwin-x64", "bin", "esbuild"));
  });

  it("prefers esbuild's own copy over another esbuild's binary at the top level", async () => {
    // The packaged layout: electron-builder nests esbuild's platform package and hoists a dependency's newer one.
    const { root, from } = await tree(["node_modules/@esbuild/darwin-arm64/bin/esbuild", "node_modules/@esbuild/darwin-x64/bin/esbuild", "node_modules/esbuild/node_modules/@esbuild/darwin-x64/bin/esbuild"]);
    expect(esbuildBinaryPath(from, "darwin-x64")).toBe(join(root, "node_modules", "esbuild", "node_modules", "@esbuild", "darwin-x64", "bin", "esbuild"));
  });

  it("never takes another architecture's binary", async () => {
    const { from } = await tree(["node_modules/@esbuild/darwin-arm64/bin/esbuild"]);
    expect(esbuildBinaryPath(from, "darwin-x64")).toBeUndefined();
  });

  it("finds the Windows binary, which sits at the package root", async () => {
    const { root, from } = await tree(["node_modules/@esbuild/win32-x64/esbuild.exe"]);
    expect(esbuildBinaryPath(from, "win32-x64")).toBe(join(root, "node_modules", "@esbuild", "win32-x64", "esbuild.exe"));
  });

  it("answers with nothing when esbuild cannot be resolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-esbuild-"));
    expect(esbuildBinaryPath(join(root, "main.js"), "darwin-x64")).toBeUndefined();
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
