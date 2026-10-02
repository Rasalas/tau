import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTypes } from "../scripts/build-types.mjs";
import { extensionApiTypes, kitFiles, kitName, kitSlug, kitTitle, parseKitArgs, runKit } from "./tau-kit.mjs";
import { main } from "./tau.mjs";

const cleanups = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function temp() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "tau-kit-")));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

/** A types folder with just its package.json, for tests that do not type-check. */
async function fakeTypes() {
  const types = await temp();
  await writeFile(join(types, "package.json"), JSON.stringify({ name: "@tau/extension-api", version: "1.29.0" }));
  await writeFile(join(types, "tau.d.ts"), "export {};\n");
  return types;
}

describe("tau kit", () => {
  it("reads new and types with their flags", () => {
    expect(parseKitArgs(["new", "pr-title"])).toEqual({ action: "new", target: "pr-title", host: true, install: false, local: false });
    expect(parseKitArgs(["new", "x", "--id", "me.x", "--no-host", "--install", "--local"])).toEqual({ action: "new", target: "x", id: "me.x", host: false, install: true, local: true });
    expect(parseKitArgs(["new", "x", "--name", "PR Title"])).toMatchObject({ target: "x", name: "PR Title" });
    expect(() => parseKitArgs(["new", "x", "--name"])).toThrow(/--name needs a value/u);
    expect(parseKitArgs(["types"])).toEqual({ action: "types", folder: undefined });
    expect(parseKitArgs(["--help"])).toEqual({ help: true });
    expect(() => parseKitArgs(["new"])).toThrow(/Name the kit/u);
    expect(() => parseKitArgs(["new", "x", "--local"])).toThrow(/--local goes with --install/u);
    expect(() => parseKitArgs(["publish"])).toThrow(/Unknown kit action/u);
  });

  it("names a kit from what the user typed", () => {
    expect(kitSlug("PR title")).toBe("pr-title");
    expect(kitSlug("2fast")).toBe("fast");
    expect(() => kitSlug("!!")).toThrow(/no usable kit name/u);
    expect(kitTitle("pr-title")).toBe("PR Title");
    expect(kitTitle("my-json-view")).toBe("My JSON View");
    // --name wins; a folder named like a title keeps its spelling.
    expect(kitName("pr-title", "pr-title", "Copy PR title")).toBe("Copy PR title");
    expect(kitName("PR title", "pr-title")).toBe("PR title");
    expect(kitName("pr-title", "pr-title")).toBe("PR Title");
  });

  it("writes a manifest for the running API, both halves, a command, styles, types and a README", async () => {
    const files = kitFiles({ id: "local.pr-title", name: "Pr title", apiVersion: "1.29.0" });
    expect(Object.keys(files).sort()).toEqual([".gitignore", "README.md", "desktop.tsx", "host.ts", "styles.css", "tau-extension.json", "tsconfig.json"]);
    expect(JSON.parse(files["tau-extension.json"])).toMatchObject({ id: "local.pr-title", engines: { api: "^1.29.0" }, permissions: [], desktop: "./desktop.tsx", host: "./host.ts", styles: "./styles.css" });
    expect(files["desktop.tsx"]).toContain("useHostAvailability");
    expect(files["host.ts"]).toContain('registerCommand("greet"');
    expect(files[".gitignore"]).toContain(".tau-types/");
    const desktopOnly = kitFiles({ id: "local.x", name: "X", apiVersion: "1.29.0", host: false });
    expect(desktopOnly["host.ts"]).toBeUndefined();
    expect(JSON.parse(desktopOnly["tau-extension.json"]).host).toBeUndefined();
  });

  it("creates the folder with the types, refuses a folder in use, and installs through the running Tau when asked", async () => {
    const cwd = await temp();
    const types = await fakeTypes();
    const lines = [];
    const install = vi.fn(async () => ({ message: "local.my-kit · global · unsigned — approve it in Settings → Extensions to start it." }));
    await runKit(parseKitArgs(["new", "my-kit", "--install"]), { cwd, out: (line) => lines.push(line), types: { env: { TAU_TYPES_DIR: types } }, install });
    expect(existsSync(join(cwd, "my-kit", ".tau-types", "tau.d.ts"))).toBe(true);
    expect(JSON.parse(await readFile(join(cwd, "my-kit", "tau-extension.json"), "utf8")).id).toBe("local.my-kit");
    expect(install).toHaveBeenCalledWith(join(cwd, "my-kit"), "global");
    expect(lines.join("\n")).toMatch(/approve it in Tau's Settings → Extensions → My Kit/u);
    await expect(runKit(parseKitArgs(["new", "my-kit"]), { cwd, out: () => undefined, types: { env: { TAU_TYPES_DIR: types } } })).rejects.toThrow(/is not empty/u);
    // A project install in a project Pi does not trust is skipped until it is trusted; the next step says so.
    lines.length = 0;
    await runKit(parseKitArgs(["new", "other", "--install", "--local"]), { cwd, out: (line) => lines.push(line), types: { env: { TAU_TYPES_DIR: types } }, install: async () => ({ message: "skipped", untrusted: true }) });
    expect(lines.at(-1)).toMatch(/Trust this project; then approve Other/u);
  });

  it("copies the types into a folder and writes a tsconfig only where there is none", async () => {
    const folder = await temp();
    const types = await fakeTypes();
    await runKit({ action: "types" }, { cwd: folder, out: () => undefined, types: { env: { TAU_TYPES_DIR: types } } });
    expect(existsSync(join(folder, ".tau-types", "package.json"))).toBe(true);
    expect(JSON.parse(await readFile(join(folder, "tsconfig.json"), "utf8")).compilerOptions.paths.tau).toEqual(["./.tau-types/tau.d.ts"]);
    await writeFile(join(folder, "tsconfig.json"), "{}");
    await runKit({ action: "types" }, { cwd: folder, out: () => undefined, types: { env: { TAU_TYPES_DIR: types } } });
    expect(await readFile(join(folder, "tsconfig.json"), "utf8")).toBe("{}");
  });

  it("finds the types a release ships beside its archive", async () => {
    const resources = await temp();
    await mkdir(join(resources, "app.asar.unpacked", "bin"), { recursive: true });
    await writeFile(join(resources, "app.asar.unpacked", "bin", "tau-kit.mjs"), "");
    await mkdir(join(resources, "extension-api"));
    await writeFile(join(resources, "extension-api", "package.json"), "{}");
    expect(extensionApiTypes({ env: {}, self: join(resources, "app.asar.unpacked", "bin", "tau-kit.mjs") })).toBe(join(resources, "extension-api"));
  });

  it("builds a checkout's types each time, and says so when it has to copy an older build", async () => {
    const root = await temp();
    await mkdir(join(root, "bin"));
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "bin", "tau-kit.mjs"), "");
    await writeFile(join(root, "scripts", "build-types.mjs"), "");
    const built = join(root, "dist-types", "extension-api");
    const self = join(root, "bin", "tau-kit.mjs");
    const build = vi.fn(() => undefined);
    await mkdir(built, { recursive: true });
    await writeFile(join(built, "package.json"), "{}");
    expect(extensionApiTypes({ env: {}, self, build })).toBe(built);
    expect(extensionApiTypes({ env: {}, self, build })).toBe(built);
    expect(build).toHaveBeenCalledTimes(2);
    const warn = vi.fn();
    expect(extensionApiTypes({ env: {}, self, build: () => "tsc failed", warn })).toBe(built);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Could not build the extension API types from this checkout \(tsc failed\); copying the last build/u));
  });

  it("is reached through tau kit", async () => {
    const cwd = await temp();
    const types = await fakeTypes();
    const lines = [];
    expect(await main(["kit", "new", "hello"], { cwd, out: (line) => lines.push(line), kitTypes: { env: { TAU_TYPES_DIR: types } } })).toBe(0);
    expect(lines[0]).toMatch(/^Created .*hello: Hello \(local\.hello\)/u);
  });

  // The types a release ships, and a new kit's own tsconfig, check the kit the way an editor would.
  it("type-checks a new kit against the built extension API types, and catches a mistake", async () => {
    const types = join(await temp(), "extension-api");
    await buildTypes({ output: types });
    const cwd = await temp();
    await runKit(parseKitArgs(["new", "my-kit"]), { cwd, out: () => undefined, types: { env: { TAU_TYPES_DIR: types } } });
    const folder = join(cwd, "my-kit");
    const check = () => {
      const config = ts.getParsedCommandLineOfConfigFile(join(folder, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
      const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
      return ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    };
    expect(check()).toEqual([]);
    const desktop = join(folder, "desktop.tsx");
    await writeFile(desktop, (await readFile(desktop, "utf8")).replace("context.registerRegion(", "context.registerRegions("));
    expect(check().join("\n")).toMatch(/registerRegions/u);
  }, 120_000);
});
