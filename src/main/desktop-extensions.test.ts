import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageBuilds } from "./package-builds.js";
import { afterEach, describe, expect, it } from "vitest";
import { bundleDesktopExtension, desktopExtensionLabel, listDesktopExtensionEntries, loadDesktopExtensions, isGeneratedOrVendored } from "./desktop-extensions.js";

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tau-ext-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("desktop extension bundling", () => {
  it("lists entry files and index folders, skipping tests and private names", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "hello.tsx"), "export default {}");
    await writeFile(join(dir, "hello.test.tsx"), "");
    await writeFile(join(dir, "_draft.ts"), "");
    await mkdir(join(dir, "kit"));
    await writeFile(join(dir, "kit", "index.ts"), "export default {}");
    expect(await listDesktopExtensionEntries(dir)).toEqual([join(dir, "hello.tsx"), join(dir, "kit", "index.ts")]);
    expect(desktopExtensionLabel(join(dir, "kit", "index.ts"))).toBe("kit");
  });

  it("compiles TSX to one module that binds shared libraries from the renderer", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "hello.tsx"), `
      import { useState } from "react";
      import type { DesktopExtension } from "tau";
      function Panel() { const [n] = useState(1); return <b>{n}</b>; }
      const extension: DesktopExtension = { id: "x.hello", name: "Hello", activate(plugin) { plugin.registerPanel({ id: "hello", label: "Hello", Component: Panel }); } };
      export default extension;
    `);
    const code = await bundleDesktopExtension(join(dir, "hello.tsx"), {
      sharedExports: { react: ["useState"], "react/jsx-runtime": ["jsx", "jsxs", "Fragment"], tau: [] },
    });
    expect(code).toContain("globalThis.__tauShared?.[specifier]");
    expect(code).toContain('shared("react")');
    expect(code).toContain('shared("react/jsx-runtime")');
    // One copy of the lookup and its error, however many shared modules the bundle binds.
    expect(code.match(/is not available in this workbench/gu)).toHaveLength(1);
    expect(code).not.toMatch(/from\s+["']react["']/u);
    expect(code).toMatch(/export\s*\{/u);
    // Minified whitespace: no indented lines.
    expect(code.split("\n").filter((line) => /^\s/u.test(line))).toEqual([]);
  });

  it("binds shared modules from the renderer at import, and names the one that is missing", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "uses.ts"), `
      import { useState } from "react";
      export default { id: "x.uses", name: "Uses", activate() { return useState; } };
    `);
    const code = await bundleDesktopExtension(join(dir, "uses.ts"), { sharedExports: { react: ["useState"], tau: [] } });
    const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
    const shared = globalThis as { __tauShared?: Record<string, unknown> };
    const useState = () => 1;
    try {
      shared.__tauShared = { react: { useState } };
      const module = await import(/* @vite-ignore */ `${url}#ok`) as { default: { activate(): unknown } };
      expect(module.default.activate()).toBe(useState);
      shared.__tauShared = {};
      await expect(import(/* @vite-ignore */ `${url}#missing`)).rejects.toThrow("Shared module react is not available in this workbench");
    } finally {
      delete shared.__tauShared;
    }
  });

  it("ships only the shared bindings the extension imports, in the code and in the map", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "one-icon.tsx"), `
      import { Bot } from "icons";
      import type { DesktopExtension } from "tau";
      const extension: DesktopExtension = { id: "x.icon", name: "Icon", activate(plugin) { plugin.registerStatusItem({ id: "icon", align: "left", Component: () => <Bot /> }); } };
      export default extension;
    `);
    const icons = Array.from({ length: 2000 }, (_, index) => `Icon${index}`);
    const code = await bundleDesktopExtension(join(dir, "one-icon.tsx"), {
      sharedExports: { icons: ["Bot", ...icons], "react/jsx-runtime": ["jsx", "jsxs", "Fragment"], tau: [] },
    });
    expect(code).toContain('pick("Bot")');
    expect(code).not.toContain('pick("Icon1")');
    // The generated shim is nobody's source, so the inline map does not carry it either.
    const map = JSON.parse(Buffer.from(/base64,([A-Za-z0-9+/=]+)/u.exec(code)![1], "base64").toString("utf8")) as { sources: string[]; sourcesContent: (string | null)[] };
    expect(map.sourcesContent[map.sources.indexOf("tau-shared:icons")]).toBeNull();
    expect(map.sourcesContent[map.sources.findIndex((source) => source.endsWith("one-icon.tsx"))]).toContain("registerStatusItem");
    expect(code.length).toBeLessThan(20_000);
  });

  it("shortens a dependency's local names but keeps the extension's, and maps both back", async () => {
    const dir = await scratch();
    const vendor = join(dir, "node_modules", "dep");
    await mkdir(vendor, { recursive: true });
    await writeFile(join(vendor, "package.json"), JSON.stringify({ name: "dep", type: "module", main: "index.js" }));
    await writeFile(join(vendor, "index.js"), "function vendorLocalHelper(input) {\n  const vendorLocalValue = input * 2;\n  return vendorLocalValue;\n}\nexport function double(value) { return vendorLocalHelper(value); }\n");
    await mkdir(join(dir, "node_modules", "linked"), { recursive: true });
    await writeFile(join(dir, "node_modules", "linked", "package.json"), JSON.stringify({ name: "linked", type: "module", main: "index.js" }));
    await writeFile(join(dir, "node_modules", "linked", "index.js"), "export function triple(linkedLocalValue) { return linkedLocalValue * 3; }\n//# sourceMappingURL=index.js.map\n");
    await writeFile(join(dir, "uses-dep.ts"), `
      import { double } from "dep";
      import { triple } from "linked";
      function extensionOwnHelper(n: number) { return double(n) + triple(n); }
      export default { id: "x.dep", name: "Dep", activate() { return extensionOwnHelper(1); } };
    `);
    const code = await bundleDesktopExtension(join(dir, "uses-dep.ts"), { sharedExports: {} });
    expect(code).not.toContain("vendorLocalHelper");
    expect(code).not.toContain("vendorLocalValue");
    expect(code).toContain("extensionOwnHelper");
    // A file that links its own map keeps its names, so that map still fits.
    expect(code).toContain("linkedLocalValue");
    const map = JSON.parse(Buffer.from(/base64,([A-Za-z0-9+/=]+)/u.exec(code)![1], "base64").toString("utf8")) as { sources: string[]; names: string[] };
    expect(map.sources.some((source) => source.endsWith("node_modules/dep/index.js"))).toBe(true);
    expect(map.names).toContain("vendorLocalHelper");
  });

  it("loads the user folder always and the project folder only when Pi trusts the project", async () => {
    const home = await scratch();
    const project = await scratch();
    await mkdir(join(home, ".tau", "extensions"), { recursive: true });
    await mkdir(join(project, ".tau", "extensions"), { recursive: true });
    await writeFile(join(home, ".tau", "extensions", "mine.ts"), "export default { id: 'mine', name: 'Mine', activate() {} }");
    await writeFile(join(project, ".tau", "extensions", "theirs.ts"), "export default { id: 'theirs', name: 'Theirs', activate() {} }");
    await writeFile(join(project, ".tau", "extensions", "broken.ts"), "export default {");
    const untrusted = await loadDesktopExtensions(project, home, { sharedExports: {}, home, trusted: () => false });
    expect(untrusted.bundles.map((bundle) => bundle.scope)).toEqual(["global"]);
    expect(untrusted.skipped).toHaveLength(1);
    const trusted = await loadDesktopExtensions(project, home, { sharedExports: {}, home, trusted: () => true });
    expect(trusted.bundles.map((bundle) => `${bundle.scope}:${bundle.path.split("/").pop()}`)).toEqual(["global:mine.ts", "project:theirs.ts"]);
    expect(trusted.errors[0]?.path).toContain("broken.ts");
    // The whole compile error, with where it is, reaches the client and the build journal.
    expect(trusted.errors[0]?.diagnostics?.[0]).toMatchObject({ file: "broken.ts", line: 1, text: expect.any(String) });
    expect(trusted.errors[0]?.message).toMatch(/^broken\.ts:1:\d+: /u);
    expect(packageBuilds.list().find((build) => build.entry.endsWith("broken.ts"))).toMatchObject({ half: "desktop", ok: false });
  }, 20_000);
});

describe("desktop extension packages", () => {
  it("takes a package folder's desktop entry from its manifest and skips host-only packages", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "pkg"));
    await writeFile(join(dir, "pkg", "tau-extension.json"), JSON.stringify({ id: "acme.pkg", name: "Pkg", desktop: "./ui/main.tsx", host: "./host.ts" }));
    await mkdir(join(dir, "pkg", "ui"));
    await writeFile(join(dir, "pkg", "ui", "main.tsx"), "export default {}");
    await writeFile(join(dir, "pkg", "index.tsx"), "export default {}");
    await mkdir(join(dir, "host-only"));
    await writeFile(join(dir, "host-only", "tau-extension.json"), JSON.stringify({ id: "acme.host", name: "Host", host: "./host.ts" }));
    await writeFile(join(dir, "host-only", "index.tsx"), "export default {}");
    expect(await listDesktopExtensionEntries(dir)).toEqual([join(dir, "pkg", "ui", "main.tsx")]);
  });

  it("loads a package that is only a stylesheet as a theme, with no grant to wait for", async () => {
    const home = await scratch();
    const project = await scratch();
    const folder = join(home, ".tau", "extensions", "terracotta");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "tau-extension.json"), JSON.stringify({ id: "acme.theme", name: "Terracotta", styles: "./theme.css" }));
    await writeFile(join(folder, "theme.css"), ":root { --acid: #d2603a; }");

    const result = await loadDesktopExtensions(project, home, { sharedExports: {}, home, trusted: () => true });
    expect(result.errors).toEqual([]);
    const [bundle] = result.bundles;
    expect(bundle.id).toBe("acme.theme");
    expect(bundle.theme).toBe(true);
    expect(bundle.granted).toBe(true);
    expect(bundle.styles).toBe(":root { --acid: #d2603a; }");
    // The module is the seam, not the theme: the registry mounts and unmounts
    // a stylesheet, so a theme arrives as an extension that does nothing else.
    expect(bundle.code).toContain('id: "acme.theme"');
    expect(bundle.code).toContain("activate() {}");
  });

  it("keeps the desktop half of a package off when its engines do not fit", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "future"));
    await writeFile(join(dir, "future", "tau-extension.json"), JSON.stringify({ id: "acme.future", name: "Future", engines: { api: "^2.0.0" }, desktop: "./main.tsx" }));
    await writeFile(join(dir, "future", "main.tsx"), "export default {}");
    const versions = { tau: "0.0.0", pi: "0.84.4", api: "1.0.0" };
    expect(await listDesktopExtensionEntries(dir, { versions })).toEqual([]);
    expect(await listDesktopExtensionEntries(dir, { versions: { ...versions, api: "2.1.0" } })).toEqual([join(dir, "future", "main.tsx")]);
    expect(await listDesktopExtensionEntries(dir)).toEqual([join(dir, "future", "main.tsx")]);
  });

  it("replaces window.tau with undefined in bundled code", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "leak.ts"), `
      console.log(window.tau);
      export default { id: "leak", name: "Leak", activate() {} };
    `);
    const code = await bundleDesktopExtension(join(dir, "leak.ts"), { sharedExports: {} });
    expect(code).toContain("console.log(void 0)");
    expect(code).not.toContain("window.tau");
  });

  it("populates permissions, granted, and source on loaded bundles", async () => {
    const home = await scratch();
    const project = await scratch();
    await mkdir(join(home, ".tau", "extensions", "my-pkg"), { recursive: true });
    await writeFile(join(home, ".tau", "extensions", "my-pkg", "tau-extension.json"), JSON.stringify({
      id: "acme.pkg",
      name: "Pkg",
      permissions: ["workspace:read"],
      source: { url: "https://github.com/foo/bar" },
      desktop: "./index.ts",
    }));
    await writeFile(join(home, ".tau", "extensions", "my-pkg", "index.ts"), "export default { id: 'acme.pkg', name: 'Pkg', activate() {} };");

    const result = await loadDesktopExtensions(project, home, {
      sharedExports: {},
      home,
      trusted: () => true,
    });
    expect(result.bundles).toHaveLength(1);
    expect(result.bundles[0].id).toBe("acme.pkg");
    expect(result.bundles[0].permissions).toEqual(["workspace:read"]);
    expect(result.bundles[0].granted).toBe(false);
    expect(result.bundles[0].source).toEqual({ url: "https://github.com/foo/bar" });
  });
});

describe("isGeneratedOrVendored", () => {
  it("drops shim and dependency sources from a kit's map, keeps the author's", () => {
    expect(isGeneratedOrVendored("tau-shared:icons")).toBe(true);
    expect(isGeneratedOrVendored("../../node_modules/@codemirror/view/dist/index.js")).toBe(true);
    expect(isGeneratedOrVendored("..\\node_modules\\xterm\\lib\\xterm.js")).toBe(true);
    expect(isGeneratedOrVendored("../../kits/files/editor-view.ts")).toBe(false);
    expect(isGeneratedOrVendored(undefined)).toBe(false);
  });
});
