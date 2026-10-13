import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * What a person reads says "extension", never "kit"; "access key", never "host
 * token"; "machine", never "host", in Settings; and "Runtimes" or "Simulators",
 * never the pages those became (CONTEXT.md). These read the shipped source for
 * the words that crept back, as `machine-wording.test.ts` does for "computer".
 */
const ROOTS = ["kits", "src/renderer", "src/main", "src/shared", "src/workbench", "src/web"];

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (name === "node_modules" || name === "fixtures" || name.startsWith(".")) continue;
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.[cm]?tsx?$/u.test(name) && !/\.test\.[cm]?tsx?$/u.test(name)) found.push(path);
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

const FILES = ROOTS.flatMap(sourceFiles);

/** Every line of `files` (all shipped source by default) whose text matches `pattern`, minus the files that keep the word on purpose. */
function textsMatching(pattern: RegExp, options: { files?: readonly string[]; except?: readonly string[] } = {}): string[] {
  const except = options.except ?? [];
  return (options.files ?? FILES)
    .filter((path) => !except.some((keeps) => path === keeps || (keeps.endsWith("/") && path.startsWith(keeps))))
    .flatMap((path) => visibleTexts(path).filter(({ text }) => pattern.test(text)).map(({ line, text }) => `${path}:${line}: ${text.slice(0, 160)}`));
}

describe("how Settings and the app name things", () => {
  it("reads at least the shipped source", () => {
    expect(FILES.length).toBeGreaterThan(1000);
  });

  it("says extension, never kit", () => {
    // `tau kit new` is the command's own name; the rest are folders and build steps, or old words the search still finds.
    const kit = /(?<![\w./:-])kits?(?![\w/.-]|\s+new\b)/iu;
    const keeps = [
      "src/main/bundled-kits.ts",
      "src/renderer/settings/settings-search.ts",
      "kits/review/guide-test-support.ts",
    ];
    expect(textsMatching(kit, { except: keeps })).toEqual([]);
  });

  it("says access key, never host token", () => {
    const token = /(?<![\w-])host tokens?(?![\w-])/iu;
    // The search keeps the old name as a word to find the row by.
    expect(textsMatching(token, { except: ["src/renderer/settings/settings-search.ts"] })).toEqual([]);
  });

  it("says machine, not host, on the pages that speak of this machine", () => {
    const host = /(?<![\w-])hosts?(?![\w-])/iu;
    const files = [
      "src/renderer/settings/ConnectionsPage.tsx",
      "src/renderer/settings/HostServiceSection.tsx",
      "src/renderer/settings/NetworkAccessSection.tsx",
      "src/renderer/settings/ConnectSettings.tsx",
      "src/renderer/settings/NearbyMachines.tsx",
      "src/renderer/settings/NearbyMachineList.tsx",
      "kits/tailscale/section.tsx",
    ];
    // The environment variables name it (TAU_HOST_LISTEN), which `\w` keeps whole.
    expect(textsMatching(host, { files })).toEqual([]);
  });

  it("sends no one to a Settings page that became another", () => {
    const gone = /Settings\s*[→›]\s*(?:Providers|Models|Pi|Inspector|Devices)\b|\b(?:Providers|Models|Devices) page\b|\bProviders card\b/u;
    expect(textsMatching(gone)).toEqual([]);
  });

  it("sends no one to a Settings page an extension gave up for a section of another", () => {
    // Packages is Extensions', Push is Notifications', Review is Source control's, SnapShots and Evidence are Screenshots', and so on (API 1.61.0).
    const gone = /Settings\s*[→›]\s*(?:Packages|Push|Review|SnapShots|Evidence|Signals|Agents|Thread rail|Resume compaction|Usage statistics|Remote work)\b/u;
    expect(textsMatching(gone)).toEqual([]);
  });
});
