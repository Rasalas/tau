import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addPackageSource,
  gitFolderName,
  listInstalledSources,
  packagesFilePath,
  parseExtensionSource,
  readPackagesFile,
  removePackageSource,
  sourceDirectory,
  writePackagesFile,
} from "./extension-sources.js";

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tau-src-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("extension sources", () => {
  it("reads Pi's three source shapes", () => {
    expect(parseExtensionSource("npm:@acme/hello", "/project")).toEqual({ kind: "npm", raw: "npm:@acme/hello", value: "@acme/hello" });
    expect(parseExtensionSource("npm:hello@1.2.3", "/project")).toEqual({ kind: "npm", raw: "npm:hello@1.2.3", value: "hello", spec: "1.2.3" });
    expect(parseExtensionSource("git:https://example.com/acme/hello.git", "/project"))
      .toEqual({ kind: "git", raw: "git:https://example.com/acme/hello.git", value: "https://example.com/acme/hello.git" });
    expect(parseExtensionSource("./ext/hello", "/project")).toEqual({ kind: "path", raw: "./ext/hello", value: "/project/ext/hello" });
  });

  it("refuses a source it cannot resolve safely", () => {
    expect(() => parseExtensionSource("", "/project")).toThrow(/Enter a source/u);
    expect(() => parseExtensionSource("npm:", "/project")).toThrow(/needs a package name/u);
    expect(() => parseExtensionSource("npm:../../etc/passwd", "/project")).toThrow(/not an npm package name/u);
    expect(() => parseExtensionSource("git:ftp://example.com/x", "/project")).toThrow(/HTTPS or SSH/u);
    expect(() => parseExtensionSource("-rf", "/project")).toThrow(/may not start with a dash/u);
  });

  it("keeps a resolved source folder inside its store", () => {
    const home = "/home/user";
    expect(sourceDirectory(parseExtensionSource("npm:@acme/hello", "/p"), home)).toBe(join(home, ".tau", "npm", "node_modules", "@acme", "hello"));
    expect(sourceDirectory(parseExtensionSource("git:https://example.com/acme/hello.git", "/p"), home))
      .toBe(join(home, ".tau", "git", "example.com-acme-hello"));
    expect(sourceDirectory(parseExtensionSource("/abs/hello", "/p"), home)).toBe("/abs/hello");
    expect(() => gitFolderName("https:////")).toThrow(/no usable folder name/u);
  });

  it("persists the source list per scope and resolves both", async () => {
    const home = await scratch();
    const project = await scratch();
    const globalFile = packagesFilePath("global", project, home);
    expect(await addPackageSource(globalFile, "npm:@acme/hello")).toBe(true);
    expect(await addPackageSource(globalFile, "npm:@acme/hello")).toBe(false);
    await addPackageSource(packagesFilePath("project", project, home), "git:https://example.com/acme/local.git");

    const installed = await listInstalledSources(project, home);
    expect(installed.map((entry) => [entry.scope, entry.source.raw])).toEqual([
      ["global", "npm:@acme/hello"],
      ["project", "git:https://example.com/acme/local.git"],
    ]);
    expect(installed[0]?.directory).toBe(join(home, ".tau", "npm", "node_modules", "@acme", "hello"));

    expect(await removePackageSource(globalFile, "npm:@acme/hello")).toBe(true);
    expect(await removePackageSource(globalFile, "npm:@acme/hello")).toBe(false);
    expect((await readPackagesFile(globalFile)).sources).toEqual([]);
  });

  it("reports an unreadable source instead of dropping it", async () => {
    const home = await scratch();
    const project = await scratch();
    await writePackagesFile(packagesFilePath("global", project, home), { sources: ["npm:@bad name"] });
    const installed = await listInstalledSources(project, home);
    expect(installed[0]?.error).toMatch(/not an npm package name/u);
  });
});
