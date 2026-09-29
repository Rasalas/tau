// Screen 10: Settings: the first page, Appearance, Providers, Keybindings and a search.
import { probes } from "./probes.mjs";

const PROBES = probes({
  tau: {
    nav: ".settings-nav",
    navItem: ".settings-nav-list button@^Pi$",
    navActive: ".settings-nav-list [aria-current=page], .settings-nav-list .active",
    navHeading: ".settings-nav-heading",
    breadcrumb: ".settings-topbar",
    sectionTitle: ".settings-section-head",
    card: ".settings-section > .settings-rows, .settings-section > div + div",
    rowTitle: ".settings-row-title",
    rowHint: ".settings-row-text p, .settings-row-text > div + *",
    label: ".settings-label",
    search: ".settings-nav-search",
  },
  reference: {
    nav: "[data-slot=sidebar-inner]",
    navItem: "[data-slot=sidebar-inner] a, [data-slot=sidebar-inner] button@^Appearance$",
    navActive: "[data-slot=sidebar-inner] [data-active=true], [data-slot=sidebar-inner] [aria-current=page]",
    navHeading: "[data-slot=sidebar-group-label]",
    breadcrumb: "main[data-slot=sidebar-inset] header",
    sectionTitle: "main h2, main section > div:first-child",
    card: "main [class*=rounded-2xl], main [class*=rounded-xl]",
    rowTitle: "main [class*=rounded-2xl] [class*=font-medium]",
    rowHint: "main [class*=rounded-2xl] [class*=text-muted-foreground]",
    search: "[data-slot=sidebar-inner] input",
  },
});

const PAGES = { tau: ["Appearance", "Providers", "Keybindings"], reference: ["Appearance", "Providers", "Keybindings"] };

async function run(ctx, { shot }) {
  await ctx.click("button[aria-label=Settings]");
  await ctx.wait(1_500);
  await ctx.moveMouse(1300, 860);
  await shot("general", { probes: PROBES, tabs: 6 });
  for (const page of PAGES[ctx.id]) {
    await ctx.clickText("a, button", new RegExp(`^${page}$`, "u"));
    await ctx.wait(1_200);
    await ctx.moveMouse(1300, 860);
    await shot(page.toLowerCase(), { probes: PROBES });
  }
  await ctx.click("input", /./u).catch(() => undefined);
  await ctx.eval(`(() => { const input = [...document.querySelectorAll("input")].find((el) => /search/i.test((el.getAttribute("aria-label") ?? "") + (el.placeholder ?? ""))); input?.focus(); return !!input; })()`);
  await ctx.type("theme");
  await ctx.wait(1_000);
  await shot("search", { probes: PROBES });
}

export default { id: "10-settings", title: "Settings: pages and search", tau: run, reference: run };
