// Screen 08: the diff of uncommitted changes, unified and split.
// The pull request view (overview, code, checks) is skipped in both: the
// isolated workspace has no remote, and neither app shows a PR without one.
// The reference app shows its panel empty: unpackaged, its review service only diffs inside
// its own app root (packaged, inside HOME), and the harness workspace is in neither.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHROME, probes } from "./probes.mjs";
import { openThread } from "./steps.mjs";

const PROBES = probes(CHROME, {
  tau: { panel: ".review-mode, .stage, [class*=review]", fileHeader: "[class*=review-file] header, .review-file-head, [class*=diff-file]", addLine: "[class*=diff] .add, .diff-line.add, [class*=add]", gutter: "[class*=gutter], [class*=line-number]" },
  reference: { panel: "[data-slot=sheet-popup], aside, [data-diff-panel]", fileHeader: "[data-diffs-header], [class*=file-header]", addLine: "[data-line-type=change-addition], [data-line-type=addition]", gutter: "[data-column-number]" },
});

/** Changes both apps read from the workspace: one edited file, one new file. */
function editWorkspace({ workspace }) {
  writeFileSync(join(workspace, "README.md"), "# Comparison workspace\n\nScratch repository for the comparison harness.\n\nThis line was added by the screen comparison, and so was the file below.\n");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "rail.ts"), [
    "export interface Row {",
    "  id: string;",
    "  title: string;",
    "  settledAt?: number;",
    "}",
    "",
    "export function visibleRows(rows: Row[], limit = 10): Row[] {",
    "  return rows.filter((row) => row.settledAt === undefined).slice(0, limit);",
    "}",
    "",
  ].join("\n"));
}

async function run(ctx, { shot, note }) {
  await openThread(ctx, "Small thread 6");
  await ctx.wait(1_500);
  await ctx.press("mod+d");
  await ctx.wait(2_000);
  await ctx.moveMouse(700, 860);
  await shot("default", { probes: PROBES });
  const toggled = await ctx.eval(`(() => {
    const button = [...document.querySelectorAll("button")].find((el) => /^Split( diff view)?$/i.test((el.getAttribute("aria-label") ?? el.textContent).trim()));
    button?.click();
    return button ? (button.getAttribute("aria-label") ?? button.textContent).trim() : null;
  })()`);
  note("layoutToggle", toggled ?? "no Split control found");
  await ctx.wait(1_000);
  if (toggled) await shot("split", { probes: PROBES });
}

export default { id: "08-diff", title: "Diff of uncommitted changes, split and unified", beforeLaunch: editWorkspace, tau: run, reference: run };
