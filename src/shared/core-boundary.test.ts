import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The completion check of docs/CORE.md: no feature name in the core contracts
 * or the Electron entry. Words listed under KNOWN_DEBT are tracked leaks with
 * a reason; a new match anywhere fails.
 */
const FORBIDDEN: Array<{ label: string; test: RegExp }> = [
  { label: "checkpoint", test: /checkpoint/iu },
  { label: "git", test: /(^|[^a-z])git($|[^a-z])|[a-z]Git[A-Z]|Git[A-Z]/u },
  { label: "commit", test: /commit/iu },
  { label: "editor", test: /editor/iu },
  { label: "clone", test: /clone/iu },
  { label: "title generation", test: /titleGenerat|generateTitle|ThreadTitle|completeTitle/iu },
  { label: "tier", test: /(^|[^a-z])tier($|[^a-z])|Tier[A-Z]|[a-z]Tier/u },
  { label: "access", test: /access/iu },
  { label: "claude", test: /claude/iu },
];

const KNOWN_DEBT: Record<string, Record<string, string>> = {
  "src/shared/contracts.ts": {
    // Pi's own dialog kinds; `editor` is ctx.ui.editor, not an external editor.
    editor: "Pi dialog kind",
  },
  "src/main/index.ts": {},
};

function words(source: string): string[] {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
  return [...new Set(stripped.match(/[A-Za-z][\w-]*/gu) ?? [])];
}

/** The host keeps thread and title handling; only the moved features are checked there. */
const HOST_RULES = new Set(["checkpoint", "git", "editor", "tier", "access", "claude"]);
const HOST_FORBIDDEN_IMPORTS = ["git-coordinator", "workspace-git", "workspace-kit-checkpoints", "pi-turn-checkpoint-extension", "turn-checkpoint-codec", "claude-code/"];

describe("core boundary", () => {
  it("src/main/pi-host.ts names no moved feature and imports no feature module", () => {
    const source = readFileSync("src/main/pi-host.ts", "utf8");
    const offenders = words(source).filter((word) => FORBIDDEN.some((rule) => HOST_RULES.has(rule.label) && rule.test.test(word)));
    expect(offenders).toEqual([]);
    const imports = HOST_FORBIDDEN_IMPORTS.filter((name) => source.includes(`./${name}.js`) || source.includes(`/${name}.js`));
    expect(imports).toEqual([]);
  });

  for (const [file, debt] of Object.entries(KNOWN_DEBT)) {
    it(`${file} names no feature outside the known debt`, () => {
      const offenders = words(readFileSync(file, "utf8"))
        .filter((word) => !(word in debt))
        .filter((word) => FORBIDDEN.some((rule) => rule.test.test(word)));
      expect(offenders).toEqual([]);
      // Debt that no longer exists should leave the list.
      const stale = Object.keys(debt).filter((word) => !readFileSync(file, "utf8").includes(word));
      expect(stale).toEqual([]);
    });
  }
});
