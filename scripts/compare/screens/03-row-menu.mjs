// Screen 03: the row's context menu, snooze choices and the custom snooze dialog.
// Both apps draw the row menu natively (Electron Menu.popup); it is captured
// with `screencapture -l` of the app's own menu window and follows the OS
// appearance, not the emulated scheme. The app is stopped to close it.
import { CHROME, probes } from "./probes.mjs";
import { railState, t3OpenSnooze, tauOpenSnooze } from "./steps.mjs";

const PROBES = probes(CHROME, {
  tau: { popover: ".rail-row-popover", popoverItem: ".rail-row-popover button", dialog: "section.thread-rail-snooze", dialogTitle: "section.thread-rail-snooze h2, section.thread-rail-snooze strong", primary: "section.thread-rail-snooze button@^Snooze$", field: "section.thread-rail-snooze input" },
  t3: { dialog: "[data-slot=dialog-popup]", dialogTitle: "[data-slot=dialog-popup] h2", primary: "[data-slot=dialog-popup] button@^Snooze$", field: "[data-slot=dialog-popup] input", popover: "[data-slot=popover-popup]", popoverItem: "[data-slot=popover-popup] button" },
});

export default {
  id: "03-row-menu",
  title: "Row menu, snooze choices, custom snooze",
  async tau(ctx, { shot, nativeShot }) {
    await railState.tau(ctx);
    await tauOpenSnooze(ctx, "Small thread 4");
    await shot("snooze", { probes: PROBES });
    await ctx.click(".rail-row-popover button", /^Custom/u);
    await ctx.waitFor(`!!document.querySelector("section.thread-rail-snooze")`);
    await shot("snooze-dialog", { probes: PROBES, tabs: 5 });
    await ctx.press("Escape");
    await ctx.wait(300);
    await ctx.rightClick("article.thread-row", /Small thread 4/u);
    await ctx.wait(800);
    await nativeShot("menu");
  },
  async t3(ctx, { shot, nativeShot }) {
    await railState.t3(ctx);
    await t3OpenSnooze(ctx, "Small thread 4");
    await shot("snooze", { probes: PROBES });
    await ctx.click("[data-slot=popover-popup] button", /^Custom/u);
    await ctx.waitFor(`!!document.querySelector("[data-slot=dialog-popup]")`);
    await shot("snooze-dialog", { probes: PROBES, tabs: 5 });
    await ctx.press("Escape");
    await ctx.wait(300);
    await ctx.rightClick("[data-testid=sidebar-row-card]", /Small thread 4/u);
    await ctx.wait(800);
    await nativeShot("menu");
  },
};
