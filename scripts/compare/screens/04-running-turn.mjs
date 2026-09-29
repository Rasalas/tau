// Screen 04: a turn while it runs: after thinking, a running command, the answer streaming.
// No approval question: the replayed Codex turn asks none in either app.
import { CHROME, TRANSCRIPT, probes } from "./probes.mjs";
import { startTurn, waitTurnDone } from "./steps.mjs";

const PROBES = probes(CHROME, TRANSCRIPT);
const seen = (pattern) => `${pattern}.test(document.body.innerText)`;

async function run(ctx, { shot }) {
  await startTurn(ctx, "Small thread 4");
  await ctx.moveMouse(900, 120);
  // Before the first tool: the run's own live line.
  await ctx.waitFor(seen(/Working for|Working…/u), { timeoutMs: 15_000, pollMs: 20 });
  await shot("live", { probes: PROBES, settleMs: 0 });
  // The thinking summary streams first; the intro follows it.
  await ctx.waitFor(seen(/streaming path first/u), { timeoutMs: 15_000, pollMs: 50 });
  await shot("thought", { probes: PROBES, settleMs: 50 });
  await ctx.waitFor(seen(/Running (rg|npm)/u), { timeoutMs: 20_000, pollMs: 50 });
  await shot("tool-running", { probes: PROBES, settleMs: 50 });
  await ctx.waitFor(seen(/Finding 2/u), { timeoutMs: 30_000, pollMs: 100 });
  await shot("streaming", { probes: PROBES, settleMs: 50 });
  await waitTurnDone(ctx);
}

export default { id: "04-running-turn", title: "A running turn: thinking, commands, streaming", tau: run, reference: run };
