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
];

const KNOWN_DEBT: Record<string, Record<string, string>> = {
  "src/shared/contracts.ts": {
    // Ticket 02 stage B: text-empty assistant messages stay visible because of their checkpoint anchor.
    turnCheckpoints: "checkpoint summaries in thread detail and pages",
    supportsCheckpointRestore: "checkpoint capability flag in thread detail",
    UiTurnCheckpoint: "type of the two entries above",
    "turn-checkpoint": "checkpoint host event the transcript anchors read",
    checkpoint: "payload field of that event",
    "turn-checkpoint-status": "live checkpoint status event",
    "turn-checkpoint-types": "import path of the type above",
    // Pi's own dialog kinds; `editor` is ctx.ui.editor, not an external editor.
    editor: "Pi dialog kind",
  },
  "src/main/index.ts": {},
};

function words(source: string): string[] {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
  return [...new Set(stripped.match(/[A-Za-z][\w-]*/gu) ?? [])];
}

describe("core boundary", () => {
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
