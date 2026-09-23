// Screen 12a: a turn that fails, then the host (Tau) or server (T3) gone.
// The backend is killed by its own pid, found in the app's process tree.
import { CHROME, TRANSCRIPT, probes } from "./probes.mjs";
import { startTurn } from "./steps.mjs";
import { descendants, processRole, processTable } from "../processes.mjs";

export const FAILURE = "stream disconnected before completion: the replay ended this turn on purpose";

const PROBES = probes(CHROME, TRANSCRIPT, {
  tau: { errorRow: "#thread-transcript [class*=error], #thread-transcript [class*=fail]", banner: "[class*=connection], [class*=reconnect], .toast", toast: ".toast, [class*=toast]" },
  t3: { errorRow: "[class*=destructive], [role=alert]", banner: "[class*=reconnect], [role=status], [data-slot=toast]", toast: "[data-slot=toast], [role=status]" },
});

async function run(ctx, { shot, note }) {
  await startTurn(ctx, "Small thread 4");
  await ctx.waitFor(`document.body.innerText.includes("stream disconnected")`, { timeoutMs: 20_000, pollMs: 100 });
  await ctx.wait(1_000);
  await ctx.moveMouse(1300, 120);
  await shot("turn-error", { probes: PROBES });
  const backend = descendants(processTable(), [ctx.pid]).find((row) => processRole(row.command) === "backend");
  note("backend", backend ? backend.command.slice(0, 120) : "not found");
  if (!backend) return;
  process.kill(backend.pid, "SIGKILL");
  await ctx.wait(1_500);
  await shot("backend-gone", { probes: PROBES, settleMs: 100 });
  await ctx.wait(6_000);
  await shot("backend-gone-later", { probes: PROBES, settleMs: 100 });
}

export default { id: "12-errors", title: "Errors: a failed turn, the backend gone", turn: { failWith: FAILURE }, tau: run, t3: run };
