import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalHostEvent } from "../shared/contracts.js";
import { HostExtensionRegistry, type HostExtensionServices } from "./host-extensions.js";
import { bundleHostExtension, importHostExtension, inspectExtensionPackages, isThemeManifest, listExtensionPackages, loadHostExtensionPackages, manifestIncompatibility, parseExtensionManifest } from "./extension-packages.js";
import { grantPackage } from "./extension-grants.js";

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tau-pkg-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function writePackage(root: string, name: string, manifest: object, files: Record<string, string>) {
  const dir = join(root, ".tau", "extensions", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "tau-extension.json"), JSON.stringify(manifest));
  for (const [file, source] of Object.entries(files)) await writeFile(join(dir, file), source);
  return dir;
}

const services = {
  cwd: () => "/project",
  safeMode: false,
  log: vi.fn(),
} as unknown as HostExtensionServices;

describe("extension packages", () => {
  it("validates manifests", () => {
    expect(() => parseExtensionManifest("/p", "{")).toThrow("not valid JSON");
    expect(() => parseExtensionManifest("/p", JSON.stringify({ id: "Bad Id", name: "x", host: "./h.ts" }))).toThrow('"id"');
    expect(() => parseExtensionManifest("/p", JSON.stringify({ id: "a.b", name: "x" }))).toThrow("names none of");
    expect(() => parseExtensionManifest("/p", JSON.stringify({ id: "a.b", name: "x", host: "../h.ts" }))).toThrow("inside the package folder");
    expect(parseExtensionManifest("/p", JSON.stringify({ id: "a.b", name: " Hello ", desktop: "./d.tsx" }))).toEqual({
      manifest: { id: "a.b", name: "Hello", permissions: [], desktop: "./d.tsx" },
      desktopEntry: "/p/d.tsx",
    });
  });

  it("resolves the stylesheet a package names, and keeps it inside the folder", () => {
    expect(parseExtensionManifest("/p", JSON.stringify({ id: "a.b", name: "x", desktop: "./d.tsx", styles: "./styles.css" }))).toEqual({
      manifest: { id: "a.b", name: "x", permissions: [], desktop: "./d.tsx", styles: "./styles.css" },
      desktopEntry: "/p/d.tsx",
      stylesEntry: "/p/styles.css",
    });
    expect(() => parseExtensionManifest("/p", JSON.stringify({ id: "a.b", name: "x", desktop: "./d.tsx", styles: "../elsewhere.css" })))
      .toThrow("inside the package folder");
  });

  it("reads a package that is only a stylesheet as a theme", () => {
    const parsed = parseExtensionManifest("/p", JSON.stringify({ id: "a.theme", name: "Theme", styles: "./theme.css" }));
    expect(parsed).toEqual({
      manifest: { id: "a.theme", name: "Theme", permissions: [], styles: "./theme.css" },
      stylesEntry: "/p/theme.css",
    });
    expect(isThemeManifest(parsed.manifest)).toBe(true);
    expect(isThemeManifest({ id: "a.b", desktop: "./d.tsx", styles: "./s.css" } as never)).toBe(false);
  });

  it("reports a theme as granted: there is nothing to approve", async () => {
    const home = await scratch();
    const project = await scratch();
    await writePackage(project, "terracotta", { id: "acme.theme", name: "Terracotta", styles: "./theme.css" }, { "theme.css": ":root {}" });
    const inspection = await inspectExtensionPackages(project, join(home, "agent"), {
      home,
      trusted: () => true,
      versions: { tau: "0.1.1", pi: "0.84.4", api: "1.3.0" },
      grantsFilePath: join(home, "grants.json"),
    });
    const theme = inspection.packages.find((entry) => entry.id === "acme.theme");
    expect(theme).toMatchObject({ theme: true, granted: true, desktop: false, host: false });
  });

  it("refuses a theme that asks for anything, and a manifest that names no entry at all", () => {
    expect(() => parseExtensionManifest("/p", JSON.stringify({ id: "a.theme", name: "T", styles: "./t.css", permissions: ["process"] })))
      .toThrow("a theme is only a stylesheet and cannot hold permissions");
    expect(() => parseExtensionManifest("/p", JSON.stringify({ id: "a.theme", name: "T", styles: "./t.css", isolation: "in-process" })))
      .toThrow('a theme runs no code, so "isolation" says nothing');
    expect(() => parseExtensionManifest("/p", JSON.stringify({ id: "a.b", name: "x" })))
      .toThrow('names none of a "desktop", a "host" and a "styles" entry');
  });

  it("parses permissions and refuses unknown ones", () => {
    expect(parseExtensionManifest("/p", JSON.stringify({ id: "a.b", name: "x", host: "./h.ts" })).manifest.permissions).toEqual([]);
    const withPerms = parseExtensionManifest("/p", JSON.stringify({
      id: "a.b",
      name: "x",
      permissions: ["sessions", "workspace:read", "process"],
      host: "./h.ts",
    }));
    expect(withPerms.manifest.permissions).toEqual(["process", "sessions", "workspace:read"]);
    expect(() => parseExtensionManifest("/p", JSON.stringify({
      id: "a.b",
      name: "x",
      permissions: ["sessions", "invalid:perm"],
      host: "./h.ts",
    }))).toThrow('unknown permission "invalid:perm"');
    expect(() => parseExtensionManifest("/p", JSON.stringify({
      id: "a.b",
      name: "x",
      permissions: "sessions",
      host: "./h.ts",
    }))).toThrow('"permissions" must be an array of strings');
  });

  it("parses optional provenance source", () => {
    const parsed = parseExtensionManifest("/p", JSON.stringify({
      id: "a.b",
      name: "x",
      source: { url: "https://github.com/example/ext", commit: "abcdef1" },
      host: "./h.ts",
    }));
    expect(parsed.manifest.source).toEqual({ url: "https://github.com/example/ext", commit: "abcdef1" });
    expect(() => parseExtensionManifest("/p", JSON.stringify({
      id: "a.b",
      name: "x",
      source: { commit: "abc" },
      host: "./h.ts",
    }))).toThrow('"source.url" must be a non-empty string');
  });

  it("reads version and engines and refuses ranges it cannot check", () => {
    const parsed = parseExtensionManifest("/p", JSON.stringify({ id: "a.b", name: "x", version: "1.2.0", engines: { api: "^1.0.0", pi: ">=0.80 <1" }, host: "./h.ts" }));
    expect(parsed.manifest).toEqual({ id: "a.b", name: "x", version: "1.2.0", engines: { api: "^1.0.0", pi: ">=0.80 <1" }, permissions: [], host: "./h.ts" });
    expect(() => parseExtensionManifest("/p", JSON.stringify({ id: "a.b", name: "x", version: "latest", host: "./h.ts" }))).toThrow('"version" must be a semver string');
    expect(() => parseExtensionManifest("/p", JSON.stringify({ id: "a.b", name: "x", engines: { node: ">=20" }, host: "./h.ts" }))).toThrow('not "node"');
    expect(() => parseExtensionManifest("/p", JSON.stringify({ id: "a.b", name: "x", engines: { api: "newest" }, host: "./h.ts" }))).toThrow('"engines": "newest" is not a version range');
    expect(() => parseExtensionManifest("/p", JSON.stringify({ id: "a.b", name: "x", engines: ["api"], host: "./h.ts" }))).toThrow('"engines" must be an object');
    const versions = { tau: "0.0.0", pi: "0.84.4", api: "1.0.0" };
    expect(manifestIncompatibility(parsed.manifest, versions)).toBeUndefined();
    expect(manifestIncompatibility(parsed.manifest, undefined)).toBeUndefined();
    expect(manifestIncompatibility({ ...parsed.manifest, engines: { api: "^2" } }, versions)).toBe("a.b 1.2.0 needs the extension API ^2, this Tau has 1.0.0");
  });

  it("summarizes the package folders for the inspector without loading code", async () => {
    const home = await scratch();
    const project = await scratch();
    await writePackage(home, "hello", { id: "acme.hello", name: "Hello", version: "0.3.0", engines: { api: "^1" }, permissions: ["workspace:read"], source: { url: "https://example.com/repo" }, desktop: "./d.tsx", host: "./h.ts" }, { "d.tsx": "export default {}", "h.ts": "export default { activate() {} }" });
    await writePackage(project, "local", { id: "acme.local", name: "Local", desktop: "./d.tsx" }, { "d.tsx": "export default {}" });
    const versions = { tau: "0.0.0", pi: "0.84.4", api: "1.0.0" };
    const inspection = await inspectExtensionPackages(project, "/agent", { home, trusted: () => false, versions });
    expect(inspection.versions).toEqual(versions);
    expect(inspection.directories.map((entry) => entry.scope)).toEqual(["global", "project"]);
    expect(inspection.packages).toEqual([{
      id: "acme.hello",
      name: "Hello",
      version: "0.3.0",
      engines: { api: "^1" },
      permissions: ["workspace:read"],
      isolation: "worker",
      granted: false,
      source: { url: "https://example.com/repo" },
      signature: { state: "unsigned", label: "unsigned" },
      scope: "global",
      directory: join(home, ".tau", "extensions", "hello"),
      desktop: true,
      host: true,
    }]);
    expect(inspection.skipped).toHaveLength(1);
    expect(inspection.errors).toEqual([]);
  });

  it("lists packages from both folders and keeps untrusted project packages off", async () => {
    const home = await scratch();
    const project = await scratch();
    await writePackage(home, "global-one", { id: "acme.global", name: "Global", host: "./host.ts" }, { "host.ts": "export default { activate() {} }" });
    await writePackage(project, "local-one", { id: "acme.local", name: "Local", desktop: "./desktop.tsx" }, { "desktop.tsx": "export default {}" });
    await writePackage(project, "broken", { id: "acme.broken", name: "Broken", host: "./missing.ts" }, {});
    await writePackage(home, "future", { id: "acme.future", name: "Future", version: "3.0.0", engines: { api: "^2.0.0" }, host: "./host.ts" }, { "host.ts": "export default { activate() {} }" });
    const versions = { tau: "0.0.0", pi: "0.84.4", api: "1.0.0" };
    const trusted = await listExtensionPackages(project, "/agent", { home, trusted: () => true, versions });
    expect(trusted.packages.map((pkg) => [pkg.scope, pkg.manifest.id])).toEqual([["global", "acme.global"], ["project", "acme.local"]]);
    expect(trusted.errors.map((error) => error.message)).toEqual([
      "acme.future 3.0.0 needs the extension API ^2.0.0, this Tau has 1.0.0",
      expect.stringContaining("does not exist"),
    ]);
    // Without versions to check against, engines are not enforced.
    const unchecked = await listExtensionPackages(project, "/agent", { home, trusted: () => true });
    expect(unchecked.packages.map((pkg) => pkg.manifest.id)).toContain("acme.future");
    const untrusted = await listExtensionPackages(project, "/agent", { home, trusted: () => false, versions });
    expect(untrusted.packages.map((pkg) => pkg.manifest.id)).toEqual(["acme.global"]);
    expect(untrusted.skipped).toHaveLength(1);
  });

  it("binds import.meta.url in a host bundle to the compiled file", async () => {
    const home = await scratch();
    const cache = await scratch();
    const dir = await writePackage(home, "meta", { id: "acme.meta", name: "Meta", host: "./host.ts" }, {
      "host.ts": `
        import { here, requireFromHere } from "./lib.mjs";
        export default { activate(context: any) { context.registerCommand("where", () => ({ here, join: typeof requireFromHere("node:path").join })); } };
      `,
      // The shape an ESM dependency takes: a require built from its own URL.
      "lib.mjs": 'import { createRequire } from "node:module";\nexport const here = import.meta.url;\nexport const requireFromHere = createRequire(import.meta.url);\n',
    });
    const extension = await importHostExtension(await bundleHostExtension(join(dir, "host.ts")), { id: "acme.meta", name: "Meta", permissions: [] }, cache);
    const registry = new HostExtensionRegistry(services, () => undefined);
    expect(await registry.activate(extension)).toBe(true);
    const where = await registry.invoke("acme.meta", "where") as { here: string; join: string };
    expect(where.join).toBe("function");
    expect(where.here).toMatch(/^file:\/\/.*acme\.meta-[0-9a-f]+\.cjs$/u);
  });

  it("bundles and imports a host entry that then serves commands through the registry", async () => {
    const home = await scratch();
    const cache = await scratch();
    const dir = await writePackage(home, "hello", { id: "acme.hello", name: "Hello", permissions: ["workspace:read"], host: "./host.ts" }, {
      "host.ts": `
        import { basename } from "node:path";
        import { double } from "./lib.js";
        export default { name: "Hello Host", activate(context: any) { context.registerCommand("greet", (input: any) => basename(context.services.cwd()) + ":" + double(input.n)); } };
      `,
      "lib.js": "export const double = (n) => n * 2;",
    });
    const code = await bundleHostExtension(join(dir, "host.ts"));
    expect(code).toContain("node:path");
    const extension = await importHostExtension(code, { id: "acme.hello", name: "Hello", permissions: ["workspace:read"] }, cache);
    expect(extension).toMatchObject({ id: "acme.hello", name: "Hello Host" });
    const events: GlobalHostEvent[] = [];
    const registry = new HostExtensionRegistry(services, (event) => events.push(event));
    expect(await registry.activate(extension)).toBe(true);
    await expect(registry.invoke("acme.hello", "greet", { n: 21 })).resolves.toBe("project:42");
    // A module whose id disagrees with the manifest is refused.
    await expect(importHostExtension('module.exports = { id: "other.id", activate() {} };', { id: "acme.hello", name: "Hello" }, cache)).rejects.toThrow("differs from the manifest id");
    await expect(importHostExtension('module.exports = { greeting: "no activate" };', { id: "acme.hello", name: "Hello" }, cache)).rejects.toThrow("must default-export a host extension");
    // Only host halves load; a desktop-only package contributes no host extension.
    await writePackage(home, "desktop-only", { id: "acme.desktop", name: "D", desktop: "./d.tsx" }, { "d.tsx": "export default {}" });
    const grantsFilePath = join(await scratch(), "grants.json");
    await grantPackage({ id: "acme.hello", permissions: ["workspace:read"] }, true, grantsFilePath);
    const loaded = await loadHostExtensionPackages("/nowhere", "/agent", { home, trusted: () => true, cacheDir: cache, grantsFilePath });
    expect(loaded.extensions.map((entry) => entry.extension.id)).toEqual(["acme.hello"]);
    expect(loaded.errors).toEqual([]);
  });

  it("never imports a package the user has not approved, in either scope", async () => {
    const home = await scratch();
    const project = await scratch();
    const cache = await scratch();
    const grantsFilePath = join(await scratch(), "grants.json");
    const sideEffect = join(await scratch(), "ran.txt");
    const entry = `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(sideEffect)}, "ran");
      export default { activate() {} };
    `;
    await writePackage(home, "global-pkg", { id: "acme.global", name: "Global", host: "./host.ts" }, { "host.ts": entry });
    await writePackage(project, "project-pkg", { id: "acme.project", name: "Project", host: "./host.ts" }, { "host.ts": entry });

    const options = { home, trusted: () => true, cacheDir: cache, grantsFilePath };
    const first = await loadHostExtensionPackages(project, "/agent", options);
    expect(first.extensions).toEqual([]);
    expect(first.ungranted.map((pkg) => pkg.manifest.id).sort()).toEqual(["acme.global", "acme.project"]);
    // Top-level module code of an unapproved package never ran.
    expect(existsSync(sideEffect)).toBe(false);

    await grantPackage({ id: "acme.global", permissions: [] }, true, grantsFilePath);
    const second = await loadHostExtensionPackages(project, "/agent", options);
    expect(second.extensions.map((e) => e.extension.id)).toEqual(["acme.global"]);
    expect(second.ungranted.map((pkg) => pkg.manifest.id)).toEqual(["acme.project"]);
    // The default is a worker, so even an approved package runs no line of its
    // own inside the host process; the worker runs it when it activates.
    expect(second.extensions[0]?.extension.isolation).toBe("worker");
    expect(existsSync(sideEffect)).toBe(false);
  });

  it("imports an approved in-process package into the host itself", async () => {
    const home = await scratch();
    const cache = await scratch();
    const grantsFilePath = join(await scratch(), "grants.json");
    const sideEffect = join(await scratch(), "ran.txt");
    await writePackage(home, "trusted-pkg", { id: "acme.trusted", name: "Trusted", isolation: "in-process", host: "./host.ts" }, {
      "host.ts": `
        import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(sideEffect)}, "ran");
        export default { activate() {} };
      `,
    });
    const options = { home, trusted: () => true, cacheDir: cache, grantsFilePath };
    // The isolation is part of the grant, so the worker grant does not cover it.
    await grantPackage({ id: "acme.trusted", permissions: [] }, true, grantsFilePath);
    expect((await loadHostExtensionPackages("/nowhere", "/agent", options)).ungranted.map((pkg) => pkg.manifest.id)).toEqual(["acme.trusted"]);

    await grantPackage({ id: "acme.trusted", permissions: [], isolation: "in-process" }, true, grantsFilePath);
    const loaded = await loadHostExtensionPackages("/nowhere", "/agent", options);
    expect(loaded.extensions[0]?.extension.isolation).toBe("in-process");
    expect(existsSync(sideEffect)).toBe(true);
  });

  it("refuses an isolation the vocabulary does not know", () => {
    expect(() => parseExtensionManifest("/pkg", JSON.stringify({ id: "acme.x", name: "X", isolation: "vm", host: "./h.ts" })))
      .toThrow('"isolation" is "worker" or "in-process", not "vm"');
  });

  it("asks again once a granted package changes the permissions it wants", async () => {
    const home = await scratch();
    const cache = await scratch();
    const grantsFilePath = join(await scratch(), "grants.json");
    await writePackage(home, "shifty", { id: "acme.shifty", name: "Shifty", permissions: ["sessions"], host: "./host.ts" }, {
      "host.ts": "export default { activate() {} };",
    });
    await grantPackage({ id: "acme.shifty", permissions: ["sessions"] }, true, grantsFilePath);
    const options = { home, trusted: () => true, cacheDir: cache, grantsFilePath };
    expect((await loadHostExtensionPackages("/nowhere", "/agent", options)).extensions).toHaveLength(1);

    // The grant survives a restart (a fresh read of the same file) ...
    expect((await loadHostExtensionPackages("/nowhere", "/agent", options)).extensions).toHaveLength(1);
    // ... but a wider permission list is a new question.
    await writePackage(home, "shifty", { id: "acme.shifty", name: "Shifty", permissions: ["sessions", "process"], host: "./host.ts" }, {
      "host.ts": "export default { activate() {} };",
    });
    const after = await loadHostExtensionPackages("/nowhere", "/agent", options);
    expect(after.extensions).toEqual([]);
    expect(after.ungranted.map((pkg) => pkg.manifest.id)).toEqual(["acme.shifty"]);
  });
});
