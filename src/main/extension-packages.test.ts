import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalHostEvent } from "../shared/contracts.js";
import { HostExtensionRegistry, type HostExtensionServices } from "./host-extensions.js";
import { bundleHostExtension, importHostExtension, inspectExtensionPackages, listExtensionPackages, loadHostExtensionPackages, manifestIncompatibility, parseExtensionManifest } from "./extension-packages.js";

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
    expect(() => parseExtensionManifest("/p", JSON.stringify({ id: "a.b", name: "x" }))).toThrow("neither");
    expect(() => parseExtensionManifest("/p", JSON.stringify({ id: "a.b", name: "x", host: "../h.ts" }))).toThrow("inside the package folder");
    expect(parseExtensionManifest("/p", JSON.stringify({ id: "a.b", name: " Hello ", desktop: "./d.tsx" }))).toEqual({
      manifest: { id: "a.b", name: "Hello", permissions: [], desktop: "./d.tsx" },
      desktopEntry: "/p/d.tsx",
    });
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
      granted: false,
      source: { url: "https://example.com/repo" },
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
    const loaded = await loadHostExtensionPackages("/nowhere", "/agent", { home, trusted: () => true, cacheDir: cache });
    expect(loaded.extensions.map((entry) => entry.extension.id)).toEqual(["acme.hello"]);
    expect(loaded.errors).toEqual([]);
  });
});
