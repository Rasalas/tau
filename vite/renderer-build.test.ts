import { readFileSync } from "node:fs";
import type { ManualChunkMeta } from "rollup";
import { describe, expect, it } from "vitest";
import { COMMON_MODULES, entryGraph, rendererBuild } from "./renderer-build";
import { readLucideExports } from "./icon-set";

type Specifier = { type: string; imported?: { type: string; name: string }; local?: { type: string; name: string } };
type Module = { isEntry?: boolean; importedIds?: string[]; body?: { type: string; source?: { value: string }; specifiers: Specifier[] }[] };

const lucideImport = (...names: string[]) => ({
  type: "ImportDeclaration",
  source: { value: "lucide-react" },
  specifiers: names.map((name) => ({ type: "ImportSpecifier", imported: { type: "Identifier", name } })),
});

function meta(modules: Record<string, Module>): ManualChunkMeta {
  return {
    getModuleIds: () => Object.keys(modules)[Symbol.iterator](),
    getModuleInfo: (id: string) => {
      const module = modules[id];
      return module ? { isEntry: false, importedIds: [], ...module, ast: { body: module.body ?? [] } } : null;
    },
  } as unknown as ManualChunkMeta;
}

const EXPORTS = new Map([["Check", "check"], ["CheckIcon", "check"], ["X", "x"], ["Plus", "plus"]]);

describe("entryGraph", () => {
  it("lists the entry's static modules and the icons they import, by file", () => {
    const graph = meta({
      "/src/index.html": { isEntry: true, importedIds: ["/src/main.tsx"] },
      "/src/main.tsx": { importedIds: ["/src/rail.tsx", "/node_modules/lucide-react/dist/esm/lucide-react.mjs"], body: [lucideImport("CheckIcon")] },
      "/src/rail.tsx": { body: [lucideImport("Check", "Plus")] },
      // Reached only through `import()`, so not in `importedIds`.
      "/src/Settings.tsx": { body: [lucideImport("X")] },
      "/node_modules/lucide-react/dist/esm/lucide-react.mjs": { importedIds: ["/node_modules/lucide-react/dist/esm/icons/x.mjs"] },
    });
    expect(entryGraph(graph, EXPORTS)).toEqual({ modules: new Set(["/src/index.html", "/src/main.tsx", "/src/rail.tsx"]), icons: new Set(["check", "plus"]) });
  });

  it("skips names that are no icon and gives up on the whole namespace", () => {
    expect(entryGraph(meta({ "/src/main.tsx": { isEntry: true, body: [lucideImport("Check", "createLucideIcon")] } }), EXPORTS).icons).toEqual(new Set(["check"]));
    const namespace = { type: "ImportDeclaration", source: { value: "lucide-react" }, specifiers: [{ type: "ImportNamespaceSpecifier", local: { type: "Identifier", name: "lucide" } }] };
    expect(entryGraph(meta({ "/src/main.tsx": { isEntry: true, body: [namespace] } }), EXPORTS).icons).toBeUndefined();
    const all = { type: "ExportAllDeclaration", source: { value: "lucide-react" } };
    expect(entryGraph(meta({ "/src/main.tsx": { isEntry: true, body: [all as never] } }), EXPORTS).icons).toBeUndefined();
  });

  it("maps every name lucide's entry exports", () => {
    const exports = readLucideExports();
    expect(exports.get("Check")).toBe("check");
    expect(exports.get("LucideCheck")).toBe("check");
    expect(exports.get("CheckIcon")).toBe("check");
  });
});

describe("rendererBuild.output.manualChunks", () => {
  const graph = meta({
    "/repo/src/renderer/main.tsx": { isEntry: true, importedIds: ["/repo/src/renderer/components/ui/Feedback.tsx"], body: [lucideImport("Check")] },
    "/repo/src/renderer/components/ui/Feedback.tsx": {},
  });
  const chunk = (id: string) => rendererBuild.output.manualChunks(id, graph);

  it("leaves the entry's icons in the entry and groups the rest with the dialogs", () => {
    expect(chunk("/node_modules/lucide-react/dist/esm/icons/check.mjs")).toBeUndefined();
    expect(chunk("/node_modules/lucide-react/dist/esm/icons/plus.mjs")).toBe("common");
    expect(chunk("/node_modules/lucide-react/dist/esm/icons/x.mjs")).toBe("common");
    expect(chunk("/repo/src/renderer/components/ui/Dialog.tsx")).toBe("common");
  });

  it("groups the listed helpers unless the entry imports them itself", () => {
    expect(chunk("/repo/src/renderer/components/ui/escape-layers.ts")).toBe("common");
    expect(chunk("/repo/src/shared/runtime-version.ts")).toBe("common");
    expect(chunk("/repo/src/renderer/components/ui/Feedback.tsx")).toBeUndefined();
    expect(chunk("/repo/src/renderer/components/Composer.tsx")).toBeUndefined();
  });
});

describe("COMMON_MODULES", () => {
  it("names modules that exist and bring no stylesheet", () => {
    for (const path of COMMON_MODULES) expect(readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8"), path).not.toMatch(/\.css["']/u);
  });
});

describe("rendererBuild.onwarn", () => {
  it("fails the build on a chunk cycle and passes other warnings on", () => {
    const passed: string[] = [];
    expect(() => rendererBuild.onwarn({ code: "CIRCULAR_CHUNK", message: "Circular chunk: a -> b -> a" }, () => undefined)).toThrow(/a -> b -> a/u);
    rendererBuild.onwarn({ code: "EMPTY_BUNDLE", message: "empty" }, (warning) => passed.push(warning.code!));
    expect(passed).toEqual(["EMPTY_BUNDLE"]);
  });
});
