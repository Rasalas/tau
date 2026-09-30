import type { ManualChunkMeta } from "rollup";
import { describe, expect, it } from "vitest";
import { entryIconFiles, rendererBuild } from "./renderer-build";
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

describe("entryIconFiles", () => {
  it("lists the icons the entry's static graph imports, by file", () => {
    const graph = meta({
      "/src/index.html": { isEntry: true, importedIds: ["/src/main.tsx"] },
      "/src/main.tsx": { importedIds: ["/src/rail.tsx", "/node_modules/lucide-react/dist/esm/lucide-react.mjs"], body: [lucideImport("CheckIcon")] },
      "/src/rail.tsx": { body: [lucideImport("Check", "Plus")] },
      // Reached only through `import()`, so not in `importedIds`.
      "/src/Settings.tsx": { body: [lucideImport("X")] },
      "/node_modules/lucide-react/dist/esm/lucide-react.mjs": { importedIds: ["/node_modules/lucide-react/dist/esm/icons/x.mjs"] },
    });
    expect(entryIconFiles(graph, EXPORTS)).toEqual(new Set(["check", "plus"]));
  });

  it("skips names that are no icon and gives up on the whole namespace", () => {
    expect(entryIconFiles(meta({ "/src/main.tsx": { isEntry: true, body: [lucideImport("Check", "createLucideIcon")] } }), EXPORTS)).toEqual(new Set(["check"]));
    const namespace = { type: "ImportDeclaration", source: { value: "lucide-react" }, specifiers: [{ type: "ImportNamespaceSpecifier", local: { type: "Identifier", name: "lucide" } }] };
    expect(entryIconFiles(meta({ "/src/main.tsx": { isEntry: true, body: [namespace] } }), EXPORTS)).toBeUndefined();
  });

  it("maps every name lucide's entry exports", () => {
    const exports = readLucideExports();
    expect(exports.get("Check")).toBe("check");
    expect(exports.get("LucideCheck")).toBe("check");
    expect(exports.get("CheckIcon")).toBe("check");
  });
});

describe("rendererBuild.output.manualChunks", () => {
  const graph = meta({ "/src/main.tsx": { isEntry: true, body: [lucideImport("Check")] } });
  const chunk = (id: string) => rendererBuild.output.manualChunks(id, graph);

  it("leaves the entry's icons in the entry and groups the rest with the dialogs", () => {
    expect(chunk("/node_modules/lucide-react/dist/esm/icons/check.mjs")).toBeUndefined();
    expect(chunk("/node_modules/lucide-react/dist/esm/icons/plus.mjs")).toBe("dialogs");
    expect(chunk("/node_modules/lucide-react/dist/esm/icons/x.mjs")).toBe("dialogs");
  });
});
