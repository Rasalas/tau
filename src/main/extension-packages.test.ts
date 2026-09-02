import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalHostEvent } from "../shared/contracts.js";
import { HostExtensionRegistry, type HostExtensionServices } from "./host-extensions.js";
import { bundleHostExtension, importHostExtension, listExtensionPackages, loadHostExtensionPackages, parseExtensionManifest } from "./extension-packages.js";

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
    expect(parseExtensionManifest("/p", JSON.stringify({ id: "a.b", name: " Hello ", desktop: "./d.tsx" }))).toEqual({ manifest: { id: "a.b", name: "Hello", desktop: "./d.tsx" }, desktopEntry: "/p/d.tsx" });
  });

  it("lists packages from both folders and keeps untrusted project packages off", async () => {
    const home = await scratch();
    const project = await scratch();
    await writePackage(home, "global-one", { id: "acme.global", name: "Global", host: "./host.ts" }, { "host.ts": "export default { activate() {} }" });
    await writePackage(project, "local-one", { id: "acme.local", name: "Local", desktop: "./desktop.tsx" }, { "desktop.tsx": "export default {}" });
    await writePackage(project, "broken", { id: "acme.broken", name: "Broken", host: "./missing.ts" }, {});
    const trusted = await listExtensionPackages(project, "/agent", { home, trusted: () => true });
    expect(trusted.packages.map((pkg) => [pkg.scope, pkg.manifest.id])).toEqual([["global", "acme.global"], ["project", "acme.local"]]);
    expect(trusted.errors.map((error) => error.message)).toEqual([expect.stringContaining("does not exist")]);
    const untrusted = await listExtensionPackages(project, "/agent", { home, trusted: () => false });
    expect(untrusted.packages.map((pkg) => pkg.manifest.id)).toEqual(["acme.global"]);
    expect(untrusted.skipped).toHaveLength(1);
  });

  it("bundles and imports a host entry that then serves commands through the registry", async () => {
    const home = await scratch();
    const cache = await scratch();
    const dir = await writePackage(home, "hello", { id: "acme.hello", name: "Hello" , host: "./host.ts" }, {
      "host.ts": `
        import { basename } from "node:path";
        import { double } from "./lib.js";
        export default { name: "Hello Host", activate(context: any) { context.registerCommand("greet", (input: any) => basename(context.services.cwd()) + ":" + double(input.n)); } };
      `,
      "lib.js": "export const double = (n) => n * 2;",
    });
    const code = await bundleHostExtension(join(dir, "host.ts"));
    expect(code).toContain("node:path");
    const extension = await importHostExtension(code, { id: "acme.hello", name: "Hello" }, cache);
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
