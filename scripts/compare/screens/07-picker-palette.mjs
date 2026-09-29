// Screen 07: the model picker and the command palette, empty and with a query.
import { CHROME, probes } from "./probes.mjs";
import { openThread } from "./steps.mjs";

const PROBES = probes(CHROME, {
  tau: {
    picker: ".model-picker",
    pickerSearch: ".model-picker input",
    pickerRow: ".model-picker [role=option], .model-picker button",
    palette: ".palette",
    paletteInput: ".palette input",
    paletteRow: ".palette [role=option], .palette-results button, .palette li",
    paletteGroup: ".palette [class*=group], .palette [class*=heading]",
  },
  reference: {
    picker: "[data-slot=popover-popup], [data-slot=combobox-popup]",
    pickerSearch: "[data-slot=popover-popup] input, [data-slot=combobox-popup] input",
    pickerRow: "[data-slot=popover-popup] [role=option], [data-slot=combobox-popup] [role=option]",
    palette: "[data-slot=dialog-popup], [data-slot=command-dialog-popup]",
    paletteInput: "[data-slot=dialog-popup] input, [data-slot=command-dialog-popup] input",
    paletteRow: "[role=option]",
    paletteGroup: "[data-slot=command-group-label], [role=group] > div:first-child",
  },
});

async function run(ctx, { shot, note }) {
  await openThread(ctx, "Small thread 6");
  await ctx.click(ctx.id === "tau" ? "textarea" : "[data-testid=composer-editor]");
  await ctx.moveMouse(1300, 860);
  await ctx.press("mod+shift+m");
  await ctx.wait(700);
  await shot("model-picker", { probes: PROBES, tabs: 4 });
  await ctx.press("Escape");
  await ctx.wait(300);
  note("focusAfterPicker", await ctx.eval(`document.activeElement?.tagName + " " + (document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.className ?? "")`));
  await ctx.press("mod+k");
  await ctx.wait(700);
  await shot("palette", { probes: PROBES });
  await ctx.type("settings");
  await ctx.wait(700);
  await shot("palette-search", { probes: PROBES });
  await ctx.press("Escape");
  await ctx.wait(300);
  note("focusAfterPalette", await ctx.eval(`document.activeElement?.tagName + " " + (document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.className ?? "")`));
}

export default { id: "07-picker-palette", title: "Model picker and command palette", tau: run, reference: run };
