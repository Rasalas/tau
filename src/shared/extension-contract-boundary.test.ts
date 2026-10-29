import { readFileSync } from "node:fs";
import { build } from "esbuild";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const parse = (path: string) => ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
const exported = (node: ts.Node) => ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

// Contracts stay usable without following a type import back into a registry.
// In particular, ThreadMenuLookup describes what the menu reads itself.
describe("extension contracts", () => {
  for (const [registry, contracts] of [
    ["src/renderer/extension-system.tsx", "src/renderer/extension-contracts.ts"],
    ["src/main/host-extensions.ts", "src/main/host-extension-contracts.ts"],
  ]) {
    it(`${registry} keeps public contract definitions in ${contracts}`, () => {
      const declarations = parse(registry).statements
        .filter((node) => exported(node) && (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)))
        .map((node) => (node as ts.InterfaceDeclaration | ts.TypeAliasDeclaration).name.text);
      expect(declarations).toEqual([]);
    });

    it(`${contracts} has no executable declarations or imports of registry implementations`, () => {
      const source = parse(contracts);
      const invalid = source.statements.filter((node) => {
        if (ts.isImportDeclaration(node)) return !node.importClause?.isTypeOnly || /extension-system|host-extensions/u.test(node.moduleSpecifier.getText(source));
        if (ts.isExportDeclaration(node)) return !node.isTypeOnly;
        return !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node);
      });
      expect(invalid.map((node) => node.getText(source))).toEqual([]);
    });
  }
});

describe("extension API helper bundles", () => {
  for (const [entry, platform, symbol] of [
    ["src/main/host-extension-api.ts", "node", "HostCommandError"],
    ["src/renderer/extension-api.ts", "browser", "HostUnavailableError"],
  ] as const) {
    it(`${entry} can publish ${symbol} without emitting either registry`, async () => {
      const result = await build({
        stdin: { contents: `export { ${symbol} } from "./${entry}";`, resolveDir: process.cwd(), loader: "ts" },
        bundle: true,
        write: false,
        metafile: true,
        format: "esm",
        platform,
        packages: "external",
        loader: { ".svg": "text", ".png": "dataurl", ".css": "empty" },
      });
      const registryCode = Object.values(result.metafile.outputs).flatMap((output) =>
        Object.entries(output.inputs).filter(([path, input]) => /extension-system|host-extensions/u.test(path) && input.bytesInOutput > 0));
      expect(registryCode).toEqual([]);
      expect(result.outputFiles[0].text).toContain(symbol);
    });
  }
});
