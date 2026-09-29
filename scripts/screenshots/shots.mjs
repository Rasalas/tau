// The named shots. Each `run` drives the app through `ctx` (see run.mjs) and
// returns the PNG; desktop shots start from the thread list with nothing open.
// Reviews comes first: a thread opened live leaves the list until its runtime settles.

const byTitle = (title) => `[...document.querySelectorAll("article.thread-row")].find((row) => row.querySelector(".thread-title")?.textContent.trim() === ${JSON.stringify(title)})?.querySelector("button.thread-main")`;
const byLabel = (pattern) => `[...document.querySelectorAll("button[aria-label]")].find((button) => ${pattern}.test(button.getAttribute("aria-label")))`;

const byText = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.textContent.trim() === ${JSON.stringify(text)})`;

/** A Settings page, from its entry in the settings sidebar. */
async function openSettings(ctx, page, ready) {
  await ctx.click(byLabel("/^Settings$/"));
  await ctx.click(byText("button, a", page));
  await ctx.waitFor(ready);
  await ctx.rest();
}

const TERMINAL_ROWS = `[...document.querySelectorAll(".xterm-accessibility-tree > div")].map((row) => row.textContent.trimEnd()).filter(Boolean)`;

const atPrompt = `/%$/.test(${TERMINAL_ROWS}.at(-1) ?? "")`;

/**
 * A command typed into the focused terminal, key by key, once its shell waits
 * at a prompt; resolves when the shell is back at one. The screen redraws a
 * little behind the keys, so each step waits for what it caused.
 */
async function typeInTerminal(ctx, line) {
  const echoed = `${TERMINAL_ROWS}.findLastIndex((row) => row.endsWith(${JSON.stringify(`% ${line}`)}))`;
  await ctx.waitFor(atPrompt, 15_000);
  for (const key of line) await ctx.key(key);
  await ctx.waitFor(`${echoed} >= 0 && ${echoed} === ${TERMINAL_ROWS}.length - 1`);
  await ctx.key("Enter");
  await ctx.waitFor(`${echoed} < ${TERMINAL_ROWS}.length - 1 && ${atPrompt}`, 15_000);
}

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
    name: "threads",
    device: "desktop",
    description: "The thread list: project, title, branch, runtime and age of every thread",
    async run(ctx) {
      await openWorkbenchThread(ctx);
      await ctx.waitFor(`!!document.querySelector('button[aria-label^="Plan limits"]')`, 30_000);
      // The clicked row would wear its focus ring.
      await ctx.evaluate(`document.activeElement?.blur()`);
      await ctx.rest();
      const rail = await ctx.rect(`document.querySelector(".session-rail")`);
      return ctx.screenshot({ x: 0, y: 0, width: rail.x + rail.width, height: ctx.viewport.height });
    },
  },
  {
    name: "stage",
    device: "desktop",
    description: "The stage beside a thread: a terminal in the thread's worktree",
    async run(ctx) {
      await openWorkbenchThread(ctx);
      await ctx.click(byLabel("/^Terminal$/"));
      await ctx.waitFor(`!!document.querySelector(".xterm")`, 30_000);
      // A second theme finds the same shell: it starts from a clear screen. The first key after focus may be dropped.
      await ctx.evaluate(`document.querySelector(".xterm-helper-textarea")?.focus()`);
      await ctx.key("Enter");
      await ctx.waitFor(atPrompt, 15_000);
      for (const key of "clear") await ctx.key(key);
      await ctx.key("Enter");
      await ctx.waitFor(`${TERMINAL_ROWS}.length === 1 && ${atPrompt}`, 15_000);
      await typeInTerminal(ctx, "git log --oneline --graph --all -12");
      await typeInTerminal(ctx, "git status --short");
      // Off the terminal, whose toolbar shows while it has the mouse or the focus.
      await ctx.evaluate(`document.activeElement?.blur()`);
      await ctx.rest({ x: 300, y: 600 });
      const stage = await ctx.rect(`document.querySelector("section.stage")`);
      return ctx.screenshot({ x: stage.x, y: 0, width: ctx.viewport.width - stage.x, height: 500 });
    },
  },
  {
    name: "runtimes",
    device: "desktop",
    description: "Settings → Runtimes: Pi, the Agent SDK runtime, Codex, Antigravity, OpenCode and more, each with its version",
    async run(ctx) {
      await openSettings(ctx, "Runtimes", `/OpenCode/.test(document.body.textContent) && [...document.querySelectorAll("*")].filter((el) => el.children.length === 0 && /^Installed/.test(el.textContent.trim())).length >= 5`);
      return ctx.screenshot();
    },
  },
  {
    name: "usage",
    device: "desktop",
    description: "Usage: spend and plan value, the activity calendar and the daily chart, in Tau and outside it",
    async run(ctx) {
      await ctx.click(`document.querySelector(".usage-juicebars")`);
      const activity = `[...document.querySelectorAll(".usage-section")].find((section) => section.querySelector("h2, h3")?.textContent.trim() === "Activity")`;
      await ctx.waitFor(`!!(${activity}) && /active days/.test((${activity}).textContent) && !/\\b[0-4] active days/.test((${activity}).textContent)`, 30_000);
      await ctx.evaluate(`(${activity}).scrollIntoView({ block: "start" })`);
      await ctx.rest();
      // Down to the chart's legend; the lists below it are the page's, not the picture's.
      const legend = await ctx.rect(`[...(${activity}).querySelectorAll("summary")].find((summary) => /Show as a table/.test(summary.textContent))`);
      return ctx.screenshot({ x: 0, y: 0, width: ctx.viewport.width, height: Math.min(ctx.viewport.height, Math.ceil(legend.y + legend.height + 16)) });
    },
  },
  {
    name: "kits",
    device: "desktop",
    description: "Settings → Extensions: every kit Tau ships, each one a package you can turn off or replace",
    async run(ctx) {
      await openSettings(ctx, "Extensions", `!!${byText("button, a", "All extensions")}`);
      await ctx.click(byText("button, a", "All extensions"));
      await ctx.waitFor(`/Bundled with Tau/.test(document.body.textContent)`);
      await ctx.rest();
      return ctx.screenshot();
    },
  },
  {
    name: "machines",
    device: "desktop",
    needs: ["studio"],
    description: "A second machine: its threads in the list, and a new thread's Run on menu",
    async run(ctx) {
      // One draft for both themes: the second pass opens the one the first left.
      const draft = `[...document.querySelectorAll("article.thread-row")].find((row) => row.querySelector(".thread-title")?.textContent.trim() === "New thread")?.querySelector("button.thread-main")`;
      if (await ctx.evaluate(`!!(${draft})`)) {
        await ctx.click(draft);
      } else {
        await ctx.click(byLabel("/^New thread$/"));
        await ctx.click(`[...document.querySelectorAll(".project-picker button, .project-picker [role=option]")].find((row) => /shop-api/.test(row.textContent))`);
      }
      await ctx.waitFor(`/What should shop-api do next/.test(document.body.textContent)`);
      const menu = `/The machine with the most room/.test(document.body.textContent) && /online/.test(document.body.textContent)`;
      // studio's status can still be on its way when the menu first opens; it is asked again then.
      for (let attempt = 0; ; attempt += 1) {
        await ctx.click(byText("button", "MacBook Pro"));
        try {
          await ctx.waitFor(menu, 10_000);
          break;
        } catch (error) {
          if (attempt >= 2) throw error;
          await ctx.key("Escape");
        }
      }
      await ctx.rest({ x: 640, y: 120 });
      return ctx.screenshot();
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
