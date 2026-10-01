import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const here = (path: string) => new URL(path, import.meta.url);
const INITIAL = [here("./tokens.css"), here("./styles.css"), here("./profile-compact.css")];

/** Stylesheets that load with a lazy chunk, the module that imports each, and selectors only it may hold. */
const LAZY = [
  { sheet: "./settings/settings.css", module: "./settings/SettingsScreen.tsx", owns: [".settings-nav", ".settings-row-main", ".setting-origin", ".provider-card", ".keybinding-row", ".extension-row"] },
  { sheet: "./settings/controls.css", module: "./settings/controls.tsx", owns: [".switch", ".tau-segmented", ".tau-select", ".tau-field", ".tau-button", ".tau-badge", ".tau-danger-zone"] },
  { sheet: "./components/model-picker.css", module: "./components/ModelPicker.tsx", owns: [".model-picker", ".model-rail", ".model-row", ".model-star"] },
  { sheet: "./components/command-palette.css", module: "./components/CommandPalette.tsx", owns: [".command-palette", ".palette-results"] },
  { sheet: "./components/reload-conflict.css", module: "./components/ReloadConflictDialog.tsx", owns: [".reload-conflict", ".reload-choice"] },
  { sheet: "./components/ui/toasts.css", module: "./components/ui/Toasts.tsx", owns: [".toast-stack", ".toast-item"] },
  { sheet: "./touch/touch.css", module: "./touch/TouchLayer.tsx", owns: [".touch-browser", ".touch-thread-row", ".swipe-row", ".action-sheet-list", ".touch-fab", ".touch-panel-sheet"] },
  { sheet: "./touch/sheet.css", module: "./touch/Sheet.tsx", owns: [".touch-sheet", ".touch-sheet-content"] },
  { sheet: "./components/stage-panels.css", module: "./components/Stage.tsx", owns: [".stage-strip", ".stage-tabs", ".stage-tab", ".stage-strip-actions"] },
  { sheet: "./components/thread-tree.css", module: "./components/ThreadTreeModal.tsx", owns: [".thread-tree", ".thread-tree-list", ".thread-tree-label", ".project-modal-help"] },
  { sheet: "./components/reload-curtain.css", module: "./components/ReloadCurtain.tsx", owns: [".reload-mark", ".reload-orbit", ".reload-pulse", ".reload-constant"] },
  { sheet: "./components/attachment-lightbox.css", module: "./components/AttachmentLightbox.tsx", owns: [".attachment-lightbox", ".lightbox-stage", ".lightbox-thumb"] },
  { sheet: "./renderer-benchmark.css", module: "./RendererBenchmark.tsx", owns: [".renderer-benchmark", ".benchmark-list-row"] },
];

/** Rule selectors, keyframe steps left out. */
function selectors(css: string): string[] {
  const plain = css.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/gu, "");
  return [...plain.matchAll(/([^{}@]+)\{[^{}]*\}/gu)].flatMap(([, list]) => list.split(",").map((part) => part.trim().replace(/\s+/gu, " ")));
}

const mentions = (selector: string, name: string) => new RegExp(`${name.replace(".", "\\.")}(?![\\w-])`, "u").test(selector);

// The initial stylesheet is budgeted (scripts/performance-budgets.json); these
// rules left it for their feature's chunk, and Vite loads a chunk's stylesheet
// before the chunk resolves, so its first paint is never unstyled.
describe("stylesheets loaded with lazy chunks", () => {
  it.each(LAZY)("$sheet is imported by $module", async ({ sheet, module }) => {
    const source = await readFile(here(module), "utf8");
    const name = sheet.split("/").at(-1);
    expect(source).toMatch(new RegExp(`^import "\\./${name?.replace(".", "\\.")}";$`, "mu"));
  });

  it.each(LAZY)("$sheet keeps its rules out of the initial stylesheet", async ({ sheet, owns }) => {
    const initial = (await Promise.all(INITIAL.map((url) => readFile(url, "utf8")))).flatMap(selectors);
    const lazy = selectors(await readFile(here(sheet), "utf8"));
    for (const name of owns) {
      expect(lazy.some((selector) => mentions(selector, name)), `${name} in ${sheet}`).toBe(true);
      expect(initial.filter((selector) => mentions(selector, name)), `${name} in the initial stylesheet`).toEqual([]);
    }
  });
});
