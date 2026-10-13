import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * A computer that runs Tau is a "machine" wherever a person reads, as in
 * Settings → Machines, and the Tau process on it is not the "host". These read
 * the shipped source for the words that crept back (CONTEXT.md, "Home machine").
 */
const ROOTS = ["kits", "src/renderer", "src/main", "src/shared", "src/workbench"];

function sourceFiles(root: string, extension: RegExp): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (name === "node_modules" || name === "fixtures" || name.startsWith(".")) continue;
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (extension.test(name) && !/\.test\.[cm]?tsx?$/u.test(name)) found.push(path);
    }
  };
  walk(root);
  return found;
}

/** The text a person reads in a file: string literals, template text and JSX text. */
function visibleTexts(path: string): { line: number; text: string }[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: { line: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      found.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: node.text.replace(/\s+/gu, " ") });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("how a machine is named", () => {
  const COMPUTER = /\b(?:this|that|another|other|your) computers?\b/iu;
  /** `machine: "this computer"` in an agent definition written before "machine" stays accepted. */
  const ACCEPTED_SPELLINGS: Record<string, RegExp> = { "kits/agents/protocol.ts": /LOCAL_ALIASES/u };

  it("never says this computer, the other computer or your computer", () => {
    const files = ROOTS.flatMap((root) => sourceFiles(root, /\.(?:[cm]?tsx?|css|json)$/u));
    expect(files.length).toBeGreaterThan(500);
    const found = files.flatMap((path) => readFileSync(path, "utf8").split("\n").flatMap((text, index) =>
      COMPUTER.test(text) && !ACCEPTED_SPELLINGS[path]?.test(text) ? [`${path}:${index + 1}: ${text.trim()}`] : []));
    expect(found).toEqual([]);
  });

  const HOST = /\b(?:this host|host half|Electron host)\b/iu;
  /** Text meant for the model, and SSH or Git hosts: "host" is their word. */
  const KEEPS_HOST_WORD = [
    "src/renderer/App.tsx",
    "kits/agents/host.ts",
    "kits/thread-rail/agent-tools.ts",
    "kits/review/guide-host.ts",
    "kits/devices/desktop.tsx",
  ];

  it("says this machine, not this host, where a phone or a browser reads", () => {
    const files = ["kits", "src/renderer"].flatMap((root) => sourceFiles(root, /\.[cm]?tsx?$/u))
      .filter((path) => !/\.electron\.ts$/u.test(path) && !KEEPS_HOST_WORD.some((keeps) => path === keeps || path.startsWith(keeps) && keeps.endsWith("/")));
    expect(files.length).toBeGreaterThan(500);
    const found = files.flatMap((path) => visibleTexts(path).filter(({ text }) => HOST.test(text)).map(({ line, text }) => `${path}:${line}: ${text}`));
    expect(found).toEqual([]);
  });
});
