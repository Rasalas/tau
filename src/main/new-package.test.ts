import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globalExtensionsDirectory } from "./extension-packages.js";
import { createNewPackage } from "./new-package.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function temp(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "tau-new-package-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function fixture() {
  const home = await temp();
  const types = await temp();
  await writeFile(join(types, "package.json"), JSON.stringify({ name: "@tau/extension-api", version: "1.75.0" }));
  await writeFile(join(types, "tau.d.ts"), "export {};\n");
  return { home, types };
}

describe("createNewPackage", () => {
  it("writes the package below the global extension folder of the packages home", async () => {
    const { home, types } = await fixture();
    const made = await createNewPackage({ slug: "copy-branch", description: "Copies the branch." }, { home, types });
    const directory = join(globalExtensionsDirectory(home), "copy-branch");
    expect(directory).toBe(join(home, ".tau", "extensions", "copy-branch"));
    expect(made).toMatchObject({ directory, id: "local.copy-branch", name: "Copy Branch", apiVersion: "1.75.0" });
    expect((await readdir(directory)).sort()).toEqual([".gitignore", ".tau-types", "AGENTS.md", "README.md", "desktop.tsx", "styles.css", "tau-extension.json", "tsconfig.json"]);
    expect(made.files).toContain("AGENTS.md");
    expect(made.files).toContain(".tau-types/");
    const manifest = JSON.parse(await readFile(join(directory, "tau-extension.json"), "utf8"));
    expect(manifest).toMatchObject({ id: "local.copy-branch", description: "Copies the branch.", engines: { api: "^1.75.0" }, desktop: "./desktop.tsx" });
    expect(manifest.host).toBeUndefined();
    expect(existsSync(join(directory, ".tau-types", "tau.d.ts"))).toBe(true);
  });

  it("follows TAU_PACKAGES_HOME, as the install scan does", async () => {
    const { home, types } = await fixture();
    const previous = process.env.TAU_PACKAGES_HOME;
    process.env.TAU_PACKAGES_HOME = home;
    try {
      expect((await createNewPackage({ slug: "mine" }, { types })).directory).toBe(join(home, ".tau", "extensions", "mine"));
    } finally {
      if (previous === undefined) delete process.env.TAU_PACKAGES_HOME; else process.env.TAU_PACKAGES_HOME = previous;
    }
  });

  it("adds a host half only when asked, and names the package as asked", async () => {
    const { home, types } = await fixture();
    const made = await createNewPackage({ slug: "pr-title", displayName: "Branch to title", host: true }, { home, types });
    expect(made.name).toBe("Branch to title");
    expect(made.files).toContain("host.ts");
    expect(JSON.parse(await readFile(join(made.directory, "tau-extension.json"), "utf8")).host).toBe("./host.ts");
    expect(await readFile(join(made.directory, "AGENTS.md"), "utf8")).toContain("tau/host");
  });

  it("never overwrites: an existing folder, file or link is an error naming its path", async () => {
    const { home, types } = await fixture();
    const root = globalExtensionsDirectory(home);
    await mkdir(join(root, "taken"), { recursive: true });
    await writeFile(join(root, "taken", "mine.txt"), "keep");
    await writeFile(join(root, "file"), "keep");
    await symlink(await temp(), join(root, "link"));
    for (const slug of ["taken", "file", "link"]) {
      await expect(createNewPackage({ slug }, { home, types })).rejects.toThrow(join(root, slug));
    }
    expect(await readFile(join(root, "taken", "mine.txt"), "utf8")).toBe("keep");
    expect(await readdir(join(root, "taken"))).toEqual(["mine.txt"]);
  });

  it("accepts only a plain slug, so nothing is written outside the folder", async () => {
    const { home, types } = await fixture();
    for (const slug of ["", "..", "../x", "a/b", "A", "My Kit", "-x", "x-", "x--y", "1x", ".hidden", "a".repeat(41)]) {
      await expect(createNewPackage({ slug }, { home, types })).rejects.toThrow(/is not a package name/u);
    }
    expect(existsSync(globalExtensionsDirectory(home))).toBe(false);
  });

  it("leaves no half-written folder when the scaffold fails", async () => {
    const { home } = await fixture();
    await expect(createNewPackage({ slug: "broken" }, { home, types: join(home, "no-types") })).rejects.toThrow();
    expect(existsSync(join(globalExtensionsDirectory(home), "broken"))).toBe(false);
  });
});
