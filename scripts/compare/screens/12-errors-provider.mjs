// Screen 12b: the provider's CLI is missing. The harness's codex stand-in is
// moved aside before launch and put back after, so both apps look for it and fail.
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { CHROME, probes } from "./probes.mjs";

const PROBES = probes(CHROME, {
  tau: { providerRow: ".settings-row@Codex", status: ".settings-row-status", composerNotice: ".composer-zone [class*=notice], .composer-zone [class*=warning]" },
  t3: { providerRow: "main [class*=rounded-2xl]@Codex", status: "main [class*=text-destructive], main [class*=text-warning]", composerNotice: "[data-slot=composer-shell] [class*=warning], [data-slot=composer-shell] [role=alert]" },
});

const shim = (root) => join(root, "bin", "codex");

async function run(ctx, { shot }) {
  // Not steps.openThread: without its CLI a thread may not open at all, and that is the screen.
  await ctx.click(ctx.id === "tau" ? "article.thread-row button.thread-main" : "[data-testid=sidebar-row-card], [data-testid=sidebar-row-slim]", /Small thread 6:/u);
  await ctx.wait(4_000);
  await ctx.moveMouse(1300, 120);
  await shot("thread", { probes: PROBES });
  await ctx.click("button[aria-label=Settings]");
  await ctx.wait(1_000);
  await ctx.clickText("a, button", /^Providers$/u);
  await ctx.wait(2_500);
  await ctx.moveMouse(1300, 860);
  await shot("providers", { probes: PROBES });
}

export default {
  id: "12-errors-provider",
  title: "Errors: the provider CLI is missing",
  beforeLaunch: ({ root }) => { if (existsSync(shim(root))) renameSync(shim(root), `${shim(root)}.off`); },
  afterClose: ({ root }) => { if (existsSync(`${shim(root)}.off`)) renameSync(`${shim(root)}.off`, shim(root)); },
  tau: run,
  t3: run,
};
