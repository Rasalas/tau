// Screen 06: the composer: empty, several lines, file and image chips, the
// slash menu, the @ menu, and a message queued while a turn runs.
import { CHROME, probes } from "./probes.mjs";
import { openThread, startTurn } from "./steps.mjs";

const PROBES = probes(CHROME, {
  tau: {
    slashMenu: ".composer-command-menu",
    slashItem: ".composer-command-menu > button",
    slashSource: ".composer-command-source",
    mentionMenu: ".composer-command-menu, [class*=mention]",
    fileChip: ".composer-surface [class*=chip]",
    imageThumb: ".composer-surface img",
    modelChip: ".composer-surface button@GPT",
    queued: "[class*=queue]",
    footerRow: ".composer-chips",
    overflow: "[aria-label='More composer controls']",
  },
  reference: {
    slashMenu: "[data-slot=composer-shell] ~ *, [role=listbox]",
    slashItem: "[role=option]",
    mentionMenu: "[role=listbox]",
    fileChip: "[data-testid=composer-editor] [class*=chip], [data-testid=composer-editor] [data-lexical-decorator]",
    imageThumb: "[data-slot=composer-shell] img",
    modelChip: "[data-slot=composer-shell] button@GPT",
    queued: "[class*=queue], [data-composer-shoulder-tab]",
  },
});

/** A pasted image, the way a screenshot arrives from the clipboard. */
const PASTE_IMAGE = `(async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 320; canvas.height = 200;
  const g = canvas.getContext("2d");
  g.fillStyle = "#3b82f6"; g.fillRect(0, 0, 320, 200);
  g.fillStyle = "#ffffff"; g.font = "32px sans-serif"; g.fillText("screenshot", 70, 110);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  const data = new DataTransfer();
  data.items.add(new File([blob], "screenshot.png", { type: "image/png" }));
  document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
})()`;

async function run(ctx, { shot }) {
  const input = ctx.id === "tau" ? "textarea" : "[data-testid=composer-editor]";
  await openThread(ctx, "Small thread 6");
  await ctx.click(input);
  await ctx.moveMouse(1300, 120);
  await shot("empty", { probes: PROBES, tabs: 8 });
  // A narrow window: the footer controls drop their labels, then fold into an overflow menu.
  await ctx.viewport(820);
  await shot("narrow", { probes: PROBES });
  await ctx.viewport();
  await ctx.click(input);
  await ctx.type("First line of a longer prompt\nsecond line\nthird line\nfourth line");
  await shot("multiline", { probes: PROBES });
  await ctx.clearField();
  await ctx.type("/");
  await ctx.wait(500);
  await shot("slash", { probes: PROBES });
  await ctx.press("Backspace");
  await ctx.type("@READ");
  await ctx.wait(1_200);
  await shot("mention", { probes: PROBES });
  await ctx.press("Enter");
  await ctx.wait(400);
  await ctx.type(" summarize this file");
  await ctx.eval(PASTE_IMAGE);
  await ctx.wait(1_200);
  await shot("chips", { probes: PROBES });
  await ctx.clearField();
  await ctx.eval(`[...document.querySelectorAll("button")].filter((b) => /^Remove|remove attachment|Remove image/i.test(b.getAttribute("aria-label") ?? "")).forEach((b) => b.click())`);
  await startTurn(ctx, "Small thread 7");
  await ctx.type("Also run the tests once more.");
  // Tau queues on Enter while a turn runs; the reference app queues through its "Queue message" button.
  if (ctx.id === "tau") await ctx.press("Enter");
  else await ctx.click("button[aria-label='Queue message']");
  await ctx.wait(800);
  await shot("queue", { probes: PROBES, settleMs: 100 });
}

export default { id: "06-composer", title: "Composer: lines, chips, menus, queue", tau: run, reference: run };
