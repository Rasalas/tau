import { describe, expect, it } from "vitest";
import { fuzzyMatch, rankFuzzy } from "./fuzzy.js";

const paths = [
  "src/renderer/components/Stage.tsx",
  "src/renderer/components/StageTabs.tsx",
  "src/workbench/stage.ts",
  "src/workbench/stage.test.ts",
  "docs/adr/0011-stage-tabs.md",
  "kits/search/desktop.tsx",
  "src/renderer/settings/settings-search.ts",
];

describe("fuzzy scorer", () => {
  it("matches the characters in order anywhere, and nothing that lacks one", () => {
    expect(fuzzyMatch("stg", "src/workbench/stage.ts")).toBeDefined();
    expect(fuzzyMatch("gts", "stage")).toBeUndefined();
    expect(fuzzyMatch("stagez", "src/workbench/stage.ts")).toBeUndefined();
  });

  it("reports where it matched, preferring a consecutive run in the file name", () => {
    expect(fuzzyMatch("stage", "src/workbench/stage.ts")?.positions).toEqual([14, 15, 16, 17, 18]);
    expect(fuzzyMatch("sd", "kits/search/desktop.tsx")?.positions).toEqual([5, 12]);
  });

  it("ranks the file name over directories, word starts over scattered letters and the shorter path on a tie", () => {
    expect(rankFuzzy(paths, "stage", 3).map((entry) => entry.path)).toEqual([
      "src/workbench/stage.ts",
      "src/workbench/stage.test.ts",
      "src/renderer/components/Stage.tsx",
    ]);
    expect(rankFuzzy(paths, "StageTabs", 1)[0]!.path).toBe("src/renderer/components/StageTabs.tsx");
    expect(rankFuzzy(paths, "set sea", 1)[0]!.path).toBe("src/renderer/settings/settings-search.ts");
    expect(rankFuzzy(paths, "ksd", 1)[0]!.path).toBe("kits/search/desktop.tsx");
  });

  it("lists the shallowest files for an empty query", () => {
    expect(rankFuzzy(paths, " ", 2).map((entry) => entry.path)).toEqual(["src/workbench/stage.ts", "kits/search/desktop.tsx"]);
  });
});
