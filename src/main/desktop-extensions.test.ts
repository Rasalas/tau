import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleDesktopExtension, desktopExtensionLabel, listDesktopExtensionEntries, loadDesktopExtensions } from "./desktop-extensions.js";

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
      const extension: DesktopExtension = { id: "x.hello", name: "Hello", activate(plugin) { plugin.registerPanel({ id: "hello", label: "Hello", glyph: "signals", Component: Panel }); } };
      export default extension;
    `);
    const code = await bundleDesktopExtension(join(dir, "hello.tsx"), {
      sharedExports: { react: ["useState"], "react/jsx-runtime": ["jsx", "jsxs", "Fragment"], tau: [] },
    });
    expect(code).toContain('globalThis.__tauShared?.["react"]');
    expect(code).toContain('globalThis.__tauShared?.["react/jsx-runtime"]');
    expect(code).not.toMatch(/from\s+["']react["']/u);
    expect(code).toContain("export {");
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
});
