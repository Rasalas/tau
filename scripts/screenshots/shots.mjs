// The named shots. Each `run` drives the app through `ctx` (see run.mjs) and
// returns the PNG; desktop shots start from the thread list with nothing open.
// Reviews comes first: a thread opened live leaves the list until its runtime settles.

const byTitle = (title) => `[...document.querySelectorAll("article.thread-row")].find((row) => row.querySelector(".thread-title")?.textContent.trim() === ${JSON.stringify(title)})?.querySelector("button.thread-main")`;
const byLabel = (pattern) => `[...document.querySelectorAll("button[aria-label]")].find((button) => ${pattern}.test(button.getAttribute("aria-label")))`;

/** The workbench thread, with its reply on screen. */
async function openWorkbenchThread(ctx) {
  await ctx.click(byTitle("Add cursor pagination to list endpoints"));
  await ctx.waitFor(`/All five list routes/.test(document.getElementById("thread-transcript")?.textContent ?? "")`);
}

export const SHOTS = [
  {
    name: "reviews",
    device: "desktop",
    description: "Reviews: finished threads' branches as local merge requests",
    async run(ctx) {
      await ctx.click(byLabel("/^Reviews/"));
      await ctx.waitFor(`/Ready to merge/.test(document.body.textContent) && document.querySelectorAll(".rv-row").length >= 5`);
      await ctx.rest();
      return ctx.screenshot();
    },
  },
  {
    name: "workbench",
    device: "desktop",
    description: "A thread with the stage beside it: Files with the thread's diff, and a terminal tab",
    async run(ctx) {
      await openWorkbenchThread(ctx);
      // The terminal stays a tab behind Files; its shell only has to exist.
      await ctx.click(byLabel("/^Terminal$/"));
      await ctx.waitFor(`!!document.querySelector(".xterm")`, 30_000);
      await ctx.click(byLabel("/^Files$/"));
      await ctx.click(`[...document.querySelectorAll("button.file-row")].find((row) => row.querySelector(".name")?.textContent.trim() === "envelope.ts")`);
      await ctx.waitFor(`/One more row than asked/.test(document.body.textContent)`);
      await ctx.rest();
      return ctx.screenshot();
    },
  },
  {
    name: "juicebars",
    device: "desktop",
    description: "The sidebar's foot with the plan-limit bars and their card",
    async run(ctx) {
      await openWorkbenchThread(ctx);
      await ctx.hover(`document.querySelector(".usage-juicebars")`);
      await ctx.waitFor(`!!document.querySelector(".usage-juicecard")`);
      const card = await ctx.rect(`document.querySelector(".usage-juicecard")`);
      const margin = 24;
      const top = Math.max(0, card.y - margin);
      return ctx.screenshot({ x: 0, y: top, width: card.x + card.width + margin, height: ctx.viewport.height - top });
    },
  },
  {
    name: "phone",
    device: "phone",
    description: "The paired phone's thread list",
    async run(ctx) {
      await ctx.waitFor(`document.querySelectorAll(".touch-thread-row").length >= 6`, 30_000);
      return ctx.screenshot();
    },
  },
];

export const SHOT_NAMES = SHOTS.map((shot) => shot.name);

/** The shots `--only` names, in the list's order; an unknown name is an error. */
export function selectShots(only) {
  if (!only?.length) return SHOTS;
  const unknown = only.filter((name) => !SHOT_NAMES.includes(name));
  if (unknown.length) throw new Error(`unknown shot ${unknown.join(", ")} (known: ${SHOT_NAMES.join(", ")})`);
  return SHOTS.filter((shot) => only.includes(shot.name));
}
