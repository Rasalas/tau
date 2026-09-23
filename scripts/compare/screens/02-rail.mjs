// Screen 02: the rail with 30 threads: active, pinned, snoozed, settled, one running.
// "Needs you" is missing in both: the replayed Codex turn asks no question.
import { CHROME, RAIL, probes } from "./probes.mjs";
import { railState, startTurn, waitTurnDone } from "./steps.mjs";

const PROBES = probes(CHROME, RAIL, {
  tau: { pinnedLabel: ".thread-group-label@[Pp][Ii][Nn][Nn][Ee][Dd]", settledToggle: ".settled-shelf-toggle", runningRow: "article.thread-row.activity-working", rowHover: "article.thread-row:hover" },
  t3: { pinnedLabel: "[data-testid=sidebar-pinned-header]", settledToggle: "[data-testid=sidebar-settled-shelf-toggle]", runningRow: "[data-testid=sidebar-row-card]@Working", rowHover: "[data-testid=sidebar-row-card]:hover" },
});

async function run(ctx, { shot }) {
  await railState[ctx.id](ctx);
  await startTurn(ctx, "Small thread 4");
  await ctx.moveMouse(900, 300);
  await shot("running", { probes: PROBES, settleMs: 250 });
  await waitTurnDone(ctx);
  await ctx.wait(800);
  await shot(undefined, { probes: PROBES });
  // Hover over an idle row: the actions each app offers there.
  await ctx.hover(ctx.id === "tau" ? "article.thread-row" : "[data-testid=sidebar-row-card]", /Small thread 1/u);
  await shot("hover", { probes: PROBES, settleMs: 300 });
}

export default { id: "02-rail", title: "Rail with 30 threads in every state", tau: run, t3: run };
