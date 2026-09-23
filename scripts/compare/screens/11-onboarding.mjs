// Screen 11: first run: the onboarding's three steps, on a profile with the
// session fixture waiting to be imported.
// Tau: Agents → Projects → Conversations. T3: Connect → Agents → Projects.
import { probes } from "./probes.mjs";
import { SCREEN_PLAN } from "./harness.mjs";
import { writeCodexSessions } from "../sessions-fixture.mjs";

const PROBES = probes({
  tau: { dialog: "section.onboarding-dialog", title: ".onboarding-title", stepper: ".onboarding-steps, [class*=onboarding-step]", primary: "section.onboarding-dialog button@^(Continue|Add|Import|Do not)", secondary: "section.onboarding-dialog button@^(Back|Skip)" },
  t3: { dialog: "[role=dialog]", title: "[role=dialog] h2", stepper: "[role=dialog] ol, [role=dialog] [class*=step]", primary: "[role=dialog] button@^(Continue|Import)", secondary: "[role=dialog] button@^(Back|Skip)" },
});

const DIALOG = { tau: "section.onboarding-dialog", t3: "[role=dialog]" };

async function run(ctx, { shot, note }) {
  const dialog = DIALOG[ctx.id];
  await ctx.waitFor(`!!document.querySelector(${JSON.stringify(dialog)}) && [...document.querySelectorAll(${JSON.stringify(`${dialog} button`)})].some((b) => /Continue/.test(b.textContent))`, { timeoutMs: 60_000 });
  await ctx.wait(1_500);
  await ctx.moveMouse(1400, 880);
  await shot("step-1", { probes: PROBES, tabs: 5 });
  for (const step of ["step-2", "step-3"]) {
    const before = await ctx.eval(`document.querySelector(${JSON.stringify(dialog)}).innerText.slice(0, 200)`);
    await ctx.click(`${dialog} button`, /^(Continue|Do not add projects)/u);
    await ctx.waitFor(`document.querySelector(${JSON.stringify(dialog)})?.innerText.slice(0, 200) !== ${JSON.stringify(before)}`, { timeoutMs: 30_000 });
    await ctx.wait(1_200);
    await ctx.moveMouse(1400, 880);
    await shot(step, { probes: PROBES });
  }
  note("buttons", await ctx.eval(`[...document.querySelectorAll(${JSON.stringify(`${dialog} button`)})].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 12)`));
}

export default {
  id: "11-onboarding",
  title: "First run: onboarding steps 1–3",
  fresh: true,
  beforeLaunch: ({ sessionsHome, workspace }) => { writeCodexSessions(sessionsHome, { cwd: workspace, ...SCREEN_PLAN }); },
  tau: run,
  t3: run,
};
