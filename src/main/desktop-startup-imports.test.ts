import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("desktop startup imports", () => {
  it("keeps the runtime SDK out of the window's static import graph", async () => {
    const { metafile } = await build({ entryPoints: ["src/main/index.ts"], bundle: true, packages: "external", platform: "node", format: "esm", write: false, metafile: true, logLevel: "silent" });
    const visited = new Set<string>();
    const imports = new Set<string>();
    const visit = (path: string) => {
      if (visited.has(path)) return;
      visited.add(path);
      for (const entry of metafile!.inputs[path]?.imports ?? []) {
        if (entry.kind === "dynamic-import") continue;
        imports.add(entry.path);
        if (!entry.external) visit(entry.path);
      }
    };
    visit("src/main/index.ts");
    expect(imports.has("@earendil-works/pi-coding-agent")).toBe(false);
    expect(imports.has("src/main/pi-host.ts")).toBe(false);
  });

  it.each(["launcher", "headless"])("enables the compile cache before %s loads its dependencies", async (entry) => {
    const source = await readFile(new URL(`./${entry}.ts`, import.meta.url), "utf8");
    expect(source).toMatch(/^import "\.\/compile-cache\.js";/u);
  });
});
