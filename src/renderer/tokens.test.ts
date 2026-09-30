import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { glob } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const TOKENS = new URL("./tokens.css", import.meta.url);
const STYLES = new URL("./styles.css", import.meta.url);
/** Core stylesheets that load with their own chunk rather than with the first paint. */
const LAZY_STYLES = [
  "./components/ui/toasts.css",
  "./settings/settings.css",
  "./settings/controls.css",
  "./components/model-picker.css",
  "./components/command-palette.css",
  "./components/reload-conflict.css",
  "./renderer-benchmark.css",
  "./components/diff-view.css",
  "./components/attachment-lightbox.css",
].map((path) => new URL(path, import.meta.url));
const KITS = fileURLToPath(new URL("../../kits", import.meta.url));

/** A colour written out rather than named: what only `tokens.css` may contain. */
const RAW_COLOUR = /#[0-9a-fA-F]{3,8}\b|(?<!\/\* )\brgba?\(|\bhsla?\((?!var\()/gu;

/** Custom properties the client sets on an element at runtime, not tokens a theme owns. */
const RUNTIME_PROPERTIES = [
  "--project-hue",
  // What the on-screen keyboard leaves of a compact client's screen (touch/TouchLayer.tsx).
  "--tau-viewport-top",
  "--tau-viewport-height",
  "--used",
  "--keep-clear-x",
  "--menu-shift-x",
  "--menu-shift-y",
  "--composer-inset",
  // How far Run on rises over the composer and moves to its edge (kits/environments/run-on.tsx).
  "--run-on-up",
  "--run-on-left",
  // The unfolded dock's height, kept free at the transcript's end (components/ComposerReserve.tsx).
  "--composer-reserve",
  // Actual dock coverage for the transcript mask, including when folded.
  "--composer-dock-height",
  // The chat's width beside the stage, from its divider (Workbench.tsx).
  "--chat-width",
  "--font-family-override",
  "--font-size-override",
  // Typography a client sets on <html> beside the two above (Appearance Kit).
  "--prompt-font-family",
  "--prompt-font-size",
  "--code-font-family",
  "--code-font-scale",
  "--page-zoom",
  // How long a panel takes to open or close (Appearance Kit); unset, it does at once.
  "--panel-motion",
  // The on-screen keyboard's height on a touch layout (touch/TouchLayer.tsx).
  "--tau-keyboard-inset",
];

/** The surfaces text is read on. `--raised` and `--sunken` carry chips and code, not prose. */
const TEXT_SURFACES = ["shell", "stage", "chrome", "field", "overlay", "rail", "float", "inset"];
/** Tokens that carry running text: WCAG AA, 4.5:1. */
const AA_TEXT = ["ink", "ink-prose", "ink-2", "ink-3", "ink-code", "muted"];
/** Accent and status tokens used as text or as an icon beside it. */
const AA_ACCENT = [
  "brand-ink",
  "acid-text", "working", "ready", "removed", "cyan", "info-ink", "merged", "danger", "warn", "fail-ink",
  "syntax-fn", "diff-add-ink", "diff-del-ink", "diff-add-edge", "diff-del-edge",
];
/** Marks, fills and small print: AA for large text and non-text contrast, 3:1. */
const AA_LARGE = ["muted-2", "faint", "stop", "info", "done", "fail", "focus", "acid", "stale", "folder", "provider-openai", "provider-anthropic", "provider-google", "provider-pi", "provider-other"];
/** Ink that sits on a fill rather than on a surface. */
const ON_FILL: ReadonlyArray<[string, string]> = [
  ["acid-ink", "acid"], ["acid-ink", "acid-strong"],
  ["diff-add-mark-ink", "diff-add-mark"], ["diff-del-mark-ink", "diff-del-mark"],
  ["diff-add-ink", "diff-add-bg"], ["diff-del-ink", "diff-del-bg"], ["acid-text", "acid-chip"],
  ["acid-text", "acid-bg"], ["user-bubble-ink", "user-bubble"], ["warn", "warn-chip"], ["danger", "danger-bg"],
];

/** A shape rather than a glyph: non-text contrast, 3:1. */
const MARK_ON_FILL: ReadonlyArray<[string, string]> = [["stop-ink", "stop"], ["qr-ink", "qr-paper"]];

/** `--name: value;` for every token, with `light-dark()` left whole. */
async function readTokens(): Promise<Map<string, string>> {
  const css = await readFile(TOKENS, "utf8");
  return new Map([...css.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gmu)].map(([, name, value]) => [name, value.trim()]));
}

function colour(tokens: Map<string, string>, name: string, scheme: "light" | "dark"): string {
  const value = tokens.get(`--${name}`);
  if (value === undefined) throw new Error(`no token --${name}`);
  const pair = /^light-dark\((.+),\s*(.+)\)$/u.exec(value);
  return (pair ? (scheme === "light" ? pair[1] : pair[2]) : value).trim();
}

/** WCAG relative luminance; an alpha channel is ignored, as these tokens are opaque. */
function luminance(value: string): number {
  const digits = value.replace("#", "");
  const full = digits.length < 6 ? [...digits.slice(0, 3)].map((c) => c + c).join("") : digits.slice(0, 6);
  const channels = [0, 2, 4].map((index) => Number.parseInt(full.slice(index, index + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(foreground: string, background: string): number {
  const [a, b] = [luminance(foreground), luminance(background)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function stylesheets(): Promise<Array<{ name: string; css: string }>> {
  const files = [STYLES, ...LAZY_STYLES];
  for await (const path of glob(`${KITS}/*/styles.css`)) files.push(new URL(`file://${path}`));
  return Promise.all(files.map(async (url) => ({ name: fileURLToPath(url), css: await readFile(url, "utf8") })));
}

describe("the token contract", () => {
  it("keeps every colour in tokens.css and nowhere else", async () => {
    for (const { name, css } of await stylesheets()) {
      expect(css.match(RAW_COLOUR) ?? [], `${name} writes a colour instead of naming a token`).toEqual([]);
    }
  });

  it("keeps first paint offline and unblurred", async () => {
    const tokens = await readFile(TOKENS, "utf8");
    expect(tokens).not.toMatch(/@import\s+url\(/u);
    expect(tokens).not.toMatch(/backdrop-filter\s*:/u);
  });

  it("holds text tokens to WCAG AA in both schemes", async () => {
    const tokens = await readTokens();
    for (const scheme of ["light", "dark"] as const) {
      const pick = (name: string) => colour(tokens, name, scheme);
      for (const [group, minimum] of [[AA_TEXT, 4.5], [AA_ACCENT, 4.5], [AA_LARGE, 3]] as const) {
        for (const name of group) {
          for (const surface of TEXT_SURFACES) {
            const contrast = ratio(pick(name), pick(surface));
            expect(contrast, `${scheme}: --${name} on --${surface} is ${contrast.toFixed(2)}:1`).toBeGreaterThanOrEqual(minimum);
          }
        }
      }
      for (const [pairs, minimum] of [[ON_FILL, 4.5], [MARK_ON_FILL, 3]] as const) {
        for (const [ink, fill] of pairs) {
          const contrast = ratio(pick(ink), pick(fill));
          expect(contrast, `${scheme}: --${ink} on --${fill} is ${contrast.toFixed(2)}:1`).toBeGreaterThanOrEqual(minimum);
        }
      }
    }
  });

  it("gives every colour token a value in both schemes", async () => {
    const tokens = await readTokens();
    const single = [...tokens].filter(([, value]) => /^#|^hsl\(/u.test(value) && !value.startsWith("light-dark("));
    // The mark on the stop button, a QR code and the dark picture viewer are the same in
    // both schemes on purpose; anything else with one value is a token that was not themed.
    const media = ["--media", "--media-control", "--media-faint", "--media-hover", "--media-ink", "--media-muted", "--media-shade", "--media-well", "--scrim-deep"];
    expect(single.map(([name]) => name).sort()).toEqual([...media, "--qr-ink", "--qr-paper", "--stop-ink"].sort());
  });

  it("sets the side surface lighter than the document area in the dark scheme only", async () => {
    const tokens = await readTokens();
    const lighter = (scheme: "light" | "dark") => luminance(colour(tokens, "rail", scheme)) > luminance(colour(tokens, "stage", scheme));
    expect(lighter("dark")).toBe(true);
    expect(lighter("light")).toBe(false);
  });

  it("keeps the dark scheme near-black with a cool cast, and menus a step above the sidebar", async () => {
    const tokens = await readTokens();
    const dark = (name: string) => colour(tokens, name, "dark");
    const [r, g, b] = [1, 3, 5].map((index) => Number.parseInt(dark("shell").slice(index, index + 2), 16));
    expect(luminance(dark("shell"))).toBeLessThan(0.008);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThanOrEqual(g);
    expect(luminance(dark("float"))).toBeGreaterThan(luminance(dark("rail")));
    expect(luminance(dark("rail"))).toBeGreaterThan(luminance(dark("sunken")));
  });

  it("paints the window and the browser bar in the dark ground before the first frame", async () => {
    const tokens = await readTokens();
    const shell = colour(tokens, "shell", "dark");
    const pages = ["./index.html", "../web/index.html", "../../mobile/index.html"];
    const htmls = await Promise.all(pages.map((page) => readFile(new URL(page, import.meta.url), "utf8")));
    htmls.forEach((html, index) => expect(html, pages[index]).toMatch(new RegExp(`<meta name="theme-color" content="${shell}" data-scheme="dark"`, "u")));
    const main = await readFile(new URL("../main/index.ts", import.meta.url), "utf8");
    expect(main).toContain(`backgroundColor: "${shell}"`);
  });

  it("ships Figtree as the sans with its own local files, never a font server", async () => {
    const tokens = await readTokens();
    expect(tokens.get("--sans")).toMatch(/^"Figtree", system-ui,/u);
    expect(tokens.get("--mono")).toMatch(/^ui-monospace,/u);
    const css = await readFile(TOKENS, "utf8");
    const sources = [...css.matchAll(/src:\s*url\("([^"]+)"\)/gu)].map((match) => match[1]);
    expect(sources).toHaveLength(4);
    for (const source of sources) {
      expect(source).toMatch(/^\.\/assets\/fonts\/figtree\/figtree-[\w-]+\.woff2$/u);
      await expect(readFile(new URL(source, TOKENS))).resolves.toBeTruthy();
    }
    await expect(readFile(new URL("./assets/fonts/figtree/OFL.txt", TOKENS), "utf8")).resolves.toMatch(/SIL OPEN FONT LICENSE Version 1\.1/u);
  });

  it("resolves a project's tint on its mark, where the hue is set", async () => {
    const tokens = await readFile(TOKENS, "utf8");
    // On :root, var(--project-hue) has no value, and the tint would be invalid on every mark.
    const root = /^:root\s*\{([\s\S]*?)^\}/mu.exec(tokens)?.[1] ?? "";
    expect(root).not.toMatch(/--project-(tint|ink):/u);
    const mark = /^\.thread-project-icon\s*\{([\s\S]*?)^\}/mu.exec(tokens)?.[1] ?? "";
    expect(mark).toMatch(/--project-tint:\s*light-dark\(hsl\(var\(--project-hue\)/u);
    expect(mark).toMatch(/--project-ink:\s*light-dark\(hsl\(var\(--project-hue\)/u);
  });

  it("sets each role per device class: readable desktop defaults and touch sizes (ADR 0029)", async () => {
    const tokens = await readFile(TOKENS, "utf8");
    const roles = (css: string) => Object.fromEntries([...css.matchAll(/--type-(xs|sm|md|lg|title|display|code|input):\s*(\d+)px/gu)].map((m) => [m[1]!, Number(m[2])]));
    const root = /^:root\s*\{([\s\S]*?)^\}/mu.exec(tokens)?.[1] ?? "";
    const desktop = roles(root);
    const device = (name: string) => ({ ...desktop, ...roles(new RegExp(`:root\\[data-device="${name}"\\]\\s*\\{([^}]*)\\}`, "u").exec(tokens)?.[1] ?? "") });
    // Desktop readability revision: body 14, with secondary roles one pixel larger.
    expect(desktop).toEqual({ xs: 12, sm: 13, md: 14, lg: 15, title: 17, display: 24, code: 13, input: 14 });
    expect(device("tablet")).toEqual({ xs: 12, sm: 13, md: 15, lg: 16, title: 17, display: 24, code: 13, input: 16 });
    expect(device("phone")).toEqual({ xs: 13, sm: 14, md: 16, lg: 17, title: 17, display: 27, code: 14, input: 16 });
    // Every size is the role times the system's text size, then Tau's own step; a page head takes no step.
    for (const role of ["xs", "sm", "md", "lg", "title", "code"]) {
      expect(root).toContain(`--text-${role}: calc(var(--type-${role}) * var(--text-scale) + var(--text-step));`);
    }
    expect(root).toContain("--text-display: calc(var(--type-display) * var(--text-scale));");
    expect(root).toMatch(/--text-input: max\(var\(--type-input-min\), calc\(var\(--type-input\) \* var\(--text-scale\) \+ var\(--text-step\)\)\);/u);
    expect(tokens).toMatch(/:root\[data-device="phone"\][^}]*--type-input-min: 16px/u);
    const appearance = await readFile(new URL("../../kits/appearance/styles.css", import.meta.url), "utf8");
    expect(appearance).toMatch(/\[data-text-size="small"\]\s*\{\s*--text-step: -1px;\s*\}/u);
    expect(appearance).toMatch(/\[data-text-size="large"\]\s*\{\s*--text-step: 1px;\s*\}/u);
  });

  it("defines every token the stylesheets ask for", async () => {
    const tokens = await readFile(TOKENS, "utf8");
    const defined = new Set([...tokens.matchAll(/^\s*(--[\w-]+):/gmu)].map((match) => match[1]));
    // A token a rule sets on itself (a layout variable, a per-project hue) is
    // the component's own; only the ones a theme may set live in tokens.css.
    const local = new Set<string>(RUNTIME_PROPERTIES);
    const used = new Set<string>();
    for (const { css } of await stylesheets()) {
      for (const match of css.matchAll(/^\s*(--[\w-]+):/gmu)) local.add(match[1]);
      for (const match of css.matchAll(/var\((--[\w-]+)/gu)) used.add(match[1]);
    }
    const missing = [...used].filter((name) => !defined.has(name) && !local.has(name));
    expect(missing).toEqual([]);
  });
});
