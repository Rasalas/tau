// Screen 13: the settled and snoozed shelves with many and with few active
// threads, folded and open, at the top and the end of the rail's scroll.
import { CHROME, RAIL, probes } from "./probes.mjs";
import { openThread, t3OpenSnooze, tauPaletteRun } from "./steps.mjs";

const UI = {
  tau: {
    scroller: "aside.session-rail .rail-active",
    toggle: (id) => `[data-rail-heading=${id}]`,
    activeRows: `[data-rail-section=active] article.thread-row, [data-rail-section=pinned] article.thread-row`,
    settledRows: "[data-rail-section=settled] article.thread-row",
    settle: "button.thread-settle",
    unsettle: "button.thread-settle",
  },
  t3: {
    scroller: "[data-slot=sidebar-inner] [data-slot=scroll-area-viewport]",
    toggle: (id) => `[data-testid=sidebar-${id}-shelf-toggle]`,
    activeRows: "[data-testid=sidebar-row-card]",
    settledRows: "[data-testid=sidebar-row-slim]",
    settle: "button[aria-label='Settle thread']",
    unsettle: "button[aria-label='Un-settle thread']",
  },
};

const PROBES = probes(CHROME, RAIL, {
  tau: { settledToggle: "[data-rail-heading=settled]", snoozedToggle: "[data-rail-heading=snoozed]", scroller: "aside.session-rail .rail-active" },
  t3: { settledToggle: "[data-testid=sidebar-settled-shelf-toggle]", snoozedToggle: "[data-testid=sidebar-snoozed-shelf-toggle]", scroller: "[data-slot=sidebar-inner] [data-slot=scroll-area-viewport]" },
});

const count = (ctx, selector) => ctx.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);

async function setShelf(ctx, id, open) {
  const selector = UI[ctx.id].toggle(id);
  const expanded = await ctx.eval(`document.querySelector(${JSON.stringify(selector)})?.getAttribute("aria-expanded") ?? null`);
  if (expanded === null || (expanded === "true") === open) return;
  await ctx.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await ctx.wait(400);
}

async function scroll(ctx, to) {
  const scroller = JSON.stringify(UI[ctx.id].scroller);
  await ctx.eval(`(() => { const el = document.querySelector(${scroller}); if (el) el.scrollTop = ${to === "end" ? "el.scrollHeight" : "0"}; })()`);
  await ctx.wait(300);
}

/** Clicks `button` in the last (or first) row of `rows` until `done` holds. */
async function repeat(ctx, rows, button, { last, done }) {
  for (let guard = 0; guard < 60 && !(await done()); guard += 1) {
    const clicked = await ctx.eval(`(() => {
      const rows = [...document.querySelectorAll(${JSON.stringify(rows)})].filter((row) => row.querySelector(${JSON.stringify(button)}));
      const row = ${last ? "rows.at(-1)" : "rows[0]"};
      row?.querySelector(${JSON.stringify(button)}).click();
      return !!row;
    })()`);
    if (!clicked) {
      // Rows behind "show N more" come into reach one page at a time.
      const more = await ctx.eval(`(() => { const button = [...document.querySelectorAll("button")].find((b) => /show \\d+ more/i.test(b.textContent)); button?.click(); return !!button; })()`);
      if (!more) break;
    }
    await ctx.wait(350);
  }
}

async function shots(ctx, shot, prefix) {
  const ui = UI[ctx.id];
  await setShelf(ctx, "settled", false);
  await scroll(ctx, "top");
  await shot(`${prefix}-collapsed`, { probes: PROBES });
  await scroll(ctx, "end");
  await shot(`${prefix}-collapsed-end`, { probes: PROBES });
  await setShelf(ctx, "settled", true);
  await scroll(ctx, "end");
  await shot(`${prefix}-open-end`, { probes: PROBES });
  return count(ctx, ui.settledRows);
}

async function run(ctx, { shot, note }) {
  const ui = UI[ctx.id];
  // Tau imports every thread as active, T3 as settled: both start from twenty active threads.
  await setShelf(ctx, "settled", true);
  if (ctx.id === "tau") {
    await repeat(ctx, ui.activeRows, ui.settle, { last: true, done: async () => (await count(ctx, ui.settledRows)) >= 10 });
  } else {
    await repeat(ctx, ui.settledRows, ui.unsettle, { last: false, done: async () => (await count(ctx, ui.activeRows)) >= 20 });
  }
  note("manyActive", await count(ctx, ui.activeRows));
  note("manySettledRowsOpen", await shots(ctx, shot, "many"));
  await setShelf(ctx, "settled", true);
  await repeat(ctx, ui.activeRows, ui.settle, { last: true, done: async () => (await count(ctx, ui.activeRows)) <= 4 });
  note("fewActive", await count(ctx, ui.activeRows));
  note("fewSettledRowsOpen", await shots(ctx, shot, "few"));
  // One active thread snoozed for an hour: the snoozed shelf joins, folded.
  const title = (await ctx.eval(`document.querySelector(${JSON.stringify(ui.activeRows)})?.textContent.match(/(Small thread \\d+|Large thread)/u)?.[1] ?? ""`));
  if (ctx.id === "tau") {
    await openThread(ctx, title);
    await tauPaletteRun(ctx, "Snooze thread");
    await ctx.click("section.thread-rail-snooze button", /^Snooze$/u);
  } else {
    await t3OpenSnooze(ctx, title);
    await ctx.click("[data-slot=popover-popup] button", /^In 1 hour/u);
  }
  await ctx.wait(500);
  await setShelf(ctx, "settled", false);
  await scroll(ctx, "top");
  await shot("few-snoozed", { probes: PROBES });
}

export default { id: "13-settled", title: "Settled and snoozed shelves with many and few active threads", tau: run, t3: run };
