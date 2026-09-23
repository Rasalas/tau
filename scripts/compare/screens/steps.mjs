// Steps several screens share, one implementation per app.

export const SCREEN_TURN_PROMPT = "Replay the recorded comparison turn.";

const titled = (title) => new RegExp(`${title}:`, "u");

/** Clicks a thread's row and waits until the app shows that thread as the open one. */
export async function openThread(ctx, title) {
  if (ctx.id === "tau") {
    await ctx.click("article.thread-row button.thread-main", titled(title));
    await ctx.waitFor(`/${title}:/u.test(document.querySelector("article.thread-row.active .thread-title")?.textContent ?? "") && !!document.querySelector("#thread-transcript")`);
  } else {
    await ctx.click("[data-testid=sidebar-row-card], [data-testid=sidebar-row-slim]", titled(title));
    await ctx.waitFor(`/${title}:/u.test(document.querySelector("nav[aria-label='Thread breadcrumb'] h2")?.textContent ?? "")`);
  }
  await ctx.wait(400);
}

/**
 * Brings each app's rail into the same mix: the newest threads active, two
 * pinned, one snoozed, the rest settled.
 */
export const railState = {
  /** Tau imports every thread as active: settle all but the newest five. */
  async tau(ctx) {
    for (let guard = 0; guard < 40; guard += 1) {
      const done = await ctx.eval(`(() => {
        const rows = [...document.querySelectorAll("[data-rail-thread]")];
        const main = rows[0]?.dataset.railSection;
        const active = rows.filter((row) => row.dataset.railSection === main);
        const more = [...document.querySelectorAll("button")].some((button) => /show \\d+ more/i.test(button.textContent));
        if (active.length <= 6 && !more) return true;
        active.at(-1).querySelector("button.thread-settle").click();
        return false;
      })()`);
      if (done) break;
      await ctx.wait(150);
    }
    for (const title of ["Small thread 1", "Small thread 2"]) {
      await openThread(ctx, title);
      await ctx.press("mod+shift+p");
      await ctx.waitFor(`[...document.querySelectorAll("[data-rail-section=pinned]")].some((row) => /${title}:/u.test(row.textContent))`);
    }
    await openThread(ctx, "Small thread 3");
    await tauPaletteRun(ctx, "Snooze thread");
    await ctx.click("section.thread-rail-snooze button", /^Snooze$/u);
    await ctx.wait(400);
  },
  /** T3 files every imported thread under Settled: un-settle the newest five. */
  async t3(ctx) {
    for (const title of ["Large thread", "Small thread 1", "Small thread 2", "Small thread 3", "Small thread 4"]) {
      await ctx.eval(`(() => {
        const row = [...document.querySelectorAll("[data-testid=sidebar-row-slim]")].find((row) => ${titled(title)}.test(row.textContent.trim()));
        row?.querySelector("button[aria-label='Un-settle thread']")?.click();
      })()`);
      await ctx.wait(400);
    }
    for (const title of ["Small thread 1", "Small thread 2"]) {
      await openThread(ctx, title);
      await ctx.press("mod+shift+p");
      await ctx.wait(600);
    }
    await t3OpenSnooze(ctx, "Small thread 3");
    await ctx.click("[data-slot=popover-popup] button", /^In 1 hour/u);
    await ctx.wait(400);
  },
};

/** Runs a palette command by typing its label and pressing Enter the way a keyboard does. */
export async function tauPaletteRun(ctx, label) {
  await ctx.press("mod+k");
  await ctx.waitFor(`document.activeElement?.tagName === "INPUT"`);
  await ctx.type(label);
  // Enter runs the highlighted row, so wait until the palette has caught up with the query.
  await ctx.waitFor(`[...document.querySelectorAll("[role=option], [role=dialog] button")].some((row) => row.textContent.trim().startsWith(${JSON.stringify(label)}))`);
  await ctx.wait(300);
  await ctx.press("Enter");
  await ctx.wait(500);
}

export async function t3OpenSnooze(ctx, title) {
  await ctx.hover("[data-testid=sidebar-row-card]", titled(title));
  await ctx.wait(300);
  await ctx.eval(`[...document.querySelectorAll("[data-testid=sidebar-row-card]")].find((row) => /${title}:/u.test(row.textContent)).querySelector("button[aria-label='Snooze thread']").click()`);
  await ctx.waitFor(`!!document.querySelector("[data-slot=popover-popup]")`);
}

// T3's rail row reads "Working 3s" for as long as the turn runs.
const T3_WORKING = `/Working\\s*\\d/u.test(document.querySelector("[data-slot=sidebar-inner]")?.innerText ?? "")`;

/** Opens a thread by title and sends the replay prompt; resolves once the app shows the turn running. */
export async function startTurn(ctx, title) {
  await openThread(ctx, title);
  await ctx.click(ctx.id === "tau" ? "textarea" : "[data-testid=composer-editor]");
  await ctx.type(SCREEN_TURN_PROMPT);
  await ctx.wait(200);
  await ctx.press("Enter");
  await ctx.waitFor(ctx.id === "tau" ? `!!document.querySelector("button.send-button.stop")` : T3_WORKING, { timeoutMs: 20_000 });
}

export async function waitTurnDone(ctx) {
  await ctx.waitFor(ctx.id === "tau" ? `!document.querySelector("button.send-button.stop")` : `!(${T3_WORKING})`, { timeoutMs: 60_000, pollMs: 200 });
}
