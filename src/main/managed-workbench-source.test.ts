import { lstat, mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedWorkbenchSource } from "./managed-workbench-source.js";

const roots: string[] = [];

async function temporary(name: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `${name}-`)));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed Tau source", () => {
  it("copies the shipped source once and links the installed build dependencies", async () => {
    const userData = await temporary("tau-user-data");
    const seed = await temporary("tau-source-seed");
    const modules = await temporary("tau-installed-modules");
    const electronTypes = await temporary("tau-electron-types");
    const typescript = await temporary("tau-typescript");
    await mkdir(join(seed, "scripts"), { recursive: true });
    await mkdir(join(seed, "src/main"), { recursive: true });
    await writeFile(join(seed, "package.json"), JSON.stringify({ name: "tau-pi-desktop-prototype" }));
    await writeFile(join(seed, "scripts/build.mjs"), "original");
    await writeFile(join(seed, "src/main/index.ts"), "");
    await mkdir(join(modules, "typescript"));
    await writeFile(join(modules, "typescript", "package.json"), "{}");
    await writeFile(join(electronTypes, "package.json"), "{}");
    await writeFile(join(electronTypes, "electron.d.ts"), "export {};");
    await mkdir(join(typescript, "lib"));
    await writeFile(join(typescript, "lib", "lib.es2022.full.d.ts"), "interface Object {}");

    const source = new ManagedWorkbenchSource({
      userData,
      version: "1.2.3",
      seedDirectory: seed,
      installedModulesDirectory: modules,
      electronTypesDirectory: electronTypes,
      typescriptDirectory: typescript,
    });
    const root = await source.ensure();

    expect(root).toBe(join(userData, "workbench-source", "1.2.3"));
    expect((await lstat(join(root, "node_modules", "typescript"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(root, "node_modules", "typescript", "lib", "lib.es2022.full.d.ts"), "utf8")).toContain("Object");
    expect(await readFile(join(root, "node_modules", "electron", "electron.d.ts"), "utf8")).toContain("export");

    await writeFile(join(root, "scripts/build.mjs"), "customized");
    await source.ensure();
    expect(await readFile(join(root, "scripts/build.mjs"), "utf8")).toBe("customized");
  });
});
