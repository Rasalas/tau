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
const SRC = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");

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
/** Tokens that carry running text, small print included: WCAG AA, 4.5:1. */
const AA_TEXT = ["ink", "ink-prose", "ink-2", "ink-3", "ink-code", "muted", "muted-2", "faint"];
/** Accent and status tokens used as text or as an icon beside it. */
const AA_ACCENT = [
  "brand-ink",
  "acid-text", "working", "ready", "removed", "cyan", "info-ink", "merged", "danger", "warn", "fail-ink",
  "syntax-fn", "diff-add-ink", "diff-del-ink", "diff-add-edge", "diff-del-edge", "stale", "folder",
];
/** Marks and fills, never small print: non-text contrast, 3:1. Text takes `fail-ink`, `info-ink` or `ready` instead. */
const AA_LARGE = ["stop", "info", "done", "fail", "focus", "acid", "provider-openai", "provider-anthropic", "provider-google", "provider-pi", "provider-other"];
/** Ink that sits on a fill rather than on a surface. */
const ON_FILL: ReadonlyArray<[string, string]> = [
  ["acid-ink", "acid"], ["acid-ink", "acid-strong"],
  ["diff-add-mark-ink", "diff-add-mark"], ["diff-del-mark-ink", "diff-del-mark"],
  ["diff-add-ink", "diff-add-bg"], ["diff-del-ink", "diff-del-bg"], ["acid-text", "acid-chip"],
  ["acid-text", "acid-bg"], ["user-bubble-ink", "user-bubble"], ["term-ink", "term"], ["warn", "warn-chip"], ["danger", "danger-bg"],
];

/** A shape rather than a glyph: non-text contrast, 3:1. */
const MARK_ON_FILL: ReadonlyArray<[string, string]> = [["stop-ink", "stop"], ["qr-ink", "qr-paper"]];

/**
 * A letter or a count inside a tile with a fixed pixel box (a project's mark, a provider's, a checkbox,
 * a badge on an icon). Anything else under 11px is text and takes `--text-2xs`, the floor.
 */
const FIXED_TILE_TEXT = new Set([
  ".thread-project-icon", ".provider-icon", ".provider-icon-stack.stacked > .provider-icon-fallback",
  ".thread-row.compact .thread-project-icon", ".checkbox", ".sidebar-footer .page-badge", ".stage-tab-dirty",
  ".rail-instance", ".project-filter-tile.thread-project-icon", ".project-switcher-pick > i",
  ".thread-card-icon > .thread-project-icon", ".agent-row-model .provider-icon-fallback", ".rv-tile",
  ".token-gate-help > summary::before",
]);

/** Where `color: var(--fainter)` is allowed: a glyph (slash, chevron, icon button) or a disabled control, never a word or a number. */
const HINT_GLYPHS = new Set([
  "kits/files/styles.css: .files-crumb-sep",
  "kits/questionnaire/styles.css: .extension-pager > button:disabled",
  "kits/workspace/styles.css: .restore-dialog > footer > button:disabled",
  "renderer/components/model-picker.css: .model-row-action",
  "renderer/components/review-layout.css: .review-tree-file:hover .review-tree-viewed, .review-tree-viewed:focus-visible",
  "renderer/settings/settings.css: .settings-page-head li + li::before",
  "renderer/settings/settings.css: .setting-origin-trigger, .setting-reset",
  "renderer/settings/settings.css: .runtimes-star",
  "renderer/settings/settings.css: .extension-row-chevron",
]);

async function cssUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  for await (const path of glob(`${root}/**/*.css`)) found.push(path);
  return found;
}

/** Every stylesheet in core and in the kits except the token contract itself. */
async function allStylesheets(): Promise<Array<{ name: string; css: string }>> {
  const files = (await Promise.all([cssUnder(SRC), cssUnder(KITS)])).flat().filter((path) => !path.includes("node_modules") && !path.endsWith("/tokens.css"));
  return Promise.all(files.map(async (path) => ({ name: path.replace(`${SRC}/`, "").replace(`${KITS}/`, "kits/"), css: await readFile(path, "utf8") })));
}

/** Style rules, comments removed; an at-rule's inner rules count, the at-rule's own head does not. */
function rules(css: string): Array<{ selector: string; body: string }> {
  return [...css.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map(([, head, body]) => ({ selector: head!.trim(), body: body! }));
}

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

/** `color-mix(in srgb, <top> <percent>%, <under>)` for two opaque `#rrggbb` colours. */
function mixOver(top: string, percent: number, under: string): string {
  const channel = (hex: string, index: number) => Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  return `#${[0, 1, 2].map((index) => Math.round(channel(top, index) * percent / 100 + channel(under, index) * (1 - percent / 100)).toString(16).padStart(2, "0")).join("")}`;
}

/** The token a rule's `property` names with `var(--x)`, found by its exact selector. */
function declaredToken(css: string, selector: string, property: string): string {
  const body = rules(css).find((rule) => rule.selector === selector && new RegExp(`(?:^|[;\\s])${property}:`, "u").test(rule.body))?.body;
  const token = body === undefined ? undefined : new RegExp(`(?:^|[;\\s])${property}:\\s*(?:color-mix\\(in srgb,\\s*)?var\\(--([\\w-]+)\\)`, "u").exec(body)?.[1];
  if (token === undefined) throw new Error(`${selector} sets no ${property}: var(--token)`);
  return token;
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

  it("holds small print to 4.5:1 on the darkest surface text sits on, in both schemes", async () => {
    const tokens = await readTokens();
    for (const scheme of ["light", "dark"] as const) {
      const lowest = Math.min(...TEXT_SURFACES.map((surface) => ratio(colour(tokens, "muted-2", scheme), colour(tokens, surface, scheme))));
      expect(lowest, `${scheme}: --muted-2 on its worst surface`).toBeGreaterThanOrEqual(4.5);
      expect(colour(tokens, "faint", scheme), `${scheme}: --faint is --muted-2`).toBe(colour(tokens, "muted-2", scheme));
      // The hint tier stays a hint: it is for marks, never for words.
      expect(ratio(colour(tokens, "fainter", scheme), colour(tokens, "shell", scheme))).toBeLessThan(3);
    }
  });

  it("sets no text under 11px except a letter in a fixed tile", async () => {
    const small: string[] = [];
    const sheets = await allStylesheets();
    expect(sheets.map(({ name }) => name)).toEqual(expect.arrayContaining(["renderer/styles.css", "kits/review/styles.css", "web/web.css"]));
    for (const { name, css } of sheets) {
      for (const { selector, body } of rules(css)) {
        const size = /(?:^|[;\s])font(?:-size)?:\s*(?:[a-z0-9-]+\s+)*?(\d*\.?\d+)px/u.exec(body)?.[1];
        if (size !== undefined && Number(size) < 11 && !selector.split(",").every((part) => FIXED_TILE_TEXT.has(part.trim()))) small.push(`${name}: ${selector} ${size}px`);
      }
    }
    expect(small, "use var(--text-2xs), which scales with the system's text size").toEqual([]);
  });

  it("never colours running text with the hint tier or a mark-only colour", async () => {
    const weak: string[] = [];
    for (const { name, css } of await allStylesheets()) {
      for (const { selector, body } of rules(css)) {
        const words = /(?:^|[;\s])font(?:-size)?:/u.test(body) || selector.includes("::placeholder");
        const colourName = /(?:^|[;\s])color:\s*var\(--(fainter|info|done|fail)\)/u.exec(body)?.[1];
        if (words && colourName) weak.push(`${name}: ${selector} uses --${colourName}`);
      }
    }
    // Text takes --faint, --info-ink, --ready or --fail-ink; the others are 3:1 marks.
    expect(weak).toEqual([]);
  });

  it("uses the hint tier for glyphs only, never for a number or a word", async () => {
    const used = new Set<string>();
    const words: string[] = [];
    for (const { name, css } of await allStylesheets()) {
      for (const { selector, body } of rules(css)) {
        if (!/(?:^|[;\s])color:\s*var\(--fainter\)/u.test(body)) continue;
        const key = `${name}: ${selector.replace(/\s+/gu, " ")}`;
        used.add(key);
        if (!HINT_GLYPHS.has(key)) words.push(key);
      }
    }
    // A line number or a label takes --muted or --faint (4.5:1); add a glyph to HINT_GLYPHS only if it has no letters or digits.
    expect(words).toEqual([]);
    expect([...HINT_GLYPHS].filter((key) => !used.has(key)), "drop what no longer uses --fainter").toEqual([]);
    const editor = await readFile(new URL("../../kits/files/editor-theme.ts", import.meta.url), "utf8");
    expect(editor).not.toMatch(/\bcolor:\s*"var\(--fainter\)"/u);
  });

  it("reads every line number at 4.5:1 on the rows it sits on, in both schemes", async () => {
    const tokens = await readTokens();
    const diff = await readFile(new URL("./components/diff-view.css", import.meta.url), "utf8");
    const styles = await readFile(STYLES, "utf8");
    const editor = await readFile(new URL("../../kits/files/editor-theme.ts", import.meta.url), "utf8");
    const gutters: ReadonlyArray<[string, string, string[]]> = [
      ["the diff gutter", declaredToken(diff, ".diff-gutter", "color"), ["stage", "diff-add-bg", "diff-del-bg"]],
      ["the file source gutter", declaredToken(styles, ".source-gutter", "color"), ["stage"]],
      ["the editor gutter", /"\.cm-gutters":\s*\{[^}]*\bcolor:\s*"var\(--([\w-]+)\)"/u.exec(editor)?.[1] ?? "none", ["stage"]],
    ];
    for (const scheme of ["light", "dark"] as const) {
      for (const [what, token, rows] of gutters) {
        for (const row of rows) {
          const contrast = ratio(colour(tokens, token, scheme), colour(tokens, row, scheme));
          expect(contrast, `${scheme}: ${what} (--${token}) on --${row} is ${contrast.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("reads a draft row's texts at 4.5:1, open or not, in both schemes", async () => {
    const tokens = await readTokens();
    const styles = await readFile(STYLES, "utf8");
    const tint = (selector: string, property: string) => {
      const body = rules(styles).find((rule) => rule.selector === selector && rule.body.includes(property))?.body ?? "";
      const mix = new RegExp(`${property}:\\s*color-mix\\(in srgb,\\s*var\\(--([\\w-]+)\\)\\s*(\\d+)%,\\s*(?:var\\(--([\\w-]+)\\)|transparent)\\)`, "u").exec(body);
      if (!mix) throw new Error(`${selector} sets no ${property}: color-mix(in srgb, var(--x) N%, var(--y))`);
      // A tint over transparent lies on the sidebar.
      return { top: mix[1]!, percent: Number(mix[2]), under: mix[3] ?? "rail" };
    };
    const resting = tint(".thread-draft-row", "background");
    const open = tint(".thread-draft-row.active", "--row-bg");
    const rows: ReadonlyArray<[string, typeof resting, string]> = [
      ["a draft row", resting, ".thread-draft-row .thread-title"],
      ["the open draft row", open, ".thread-draft-row.active .thread-title"],
    ];
    const texts: ReadonlyArray<[string, string]> = [
      ["the branch", declaredToken(styles, ".thread-branch", "color")],
      ["the Draft mark", declaredToken(styles, ".thread-draft-mark", "color")],
    ];
    for (const scheme of ["light", "dark"] as const) {
      for (const [row, { top, percent, under }, titleRule] of rows) {
        const ground = mixOver(colour(tokens, top, scheme), percent, colour(tokens, under, scheme));
        for (const [what, token] of [...texts, ["the title", declaredToken(styles, titleRule, "color")] as [string, string]]) {
          const contrast = ratio(colour(tokens, token, scheme), ground);
          expect(contrast, `${scheme}: ${what} (--${token}) on ${row} is ${contrast.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("gives every colour token a value in both schemes", async () => {
    const tokens = await readTokens();
    const single = [...tokens].filter(([, value]) => /^#|^hsl\(/u.test(value) && !value.startsWith("light-dark("));
    // The mark on the stop button, a QR code, the dark picture viewer and a command's dark output
    // are the same in both schemes on purpose; anything else with one value was not themed.
    const media = ["--media", "--media-control", "--media-faint", "--media-hover", "--media-ink", "--media-muted", "--media-shade", "--media-well", "--scrim-deep"];
    expect(single.map(([name]) => name).sort()).toEqual([...media, "--qr-ink", "--qr-paper", "--stop-ink", "--term-ink"].sort());
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

  it("sets text in the platform face and loads no font of its own", async () => {
    const tokens = await readTokens();
    expect(tokens.get("--sans")).toMatch(/^-apple-system, BlinkMacSystemFont,/u);
    expect(tokens.get("--mono")).toMatch(/^ui-monospace,/u);
    expect(await readFile(TOKENS, "utf8")).not.toContain("@font-face");
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
    const roles = (css: string) => Object.fromEntries([...css.matchAll(/--type-(2xs|xs|sm|md|lg|title|display|code|input):\s*(\d+)px/gu)].map((m) => [m[1]!, Number(m[2])]));
    const root = /^:root\s*\{([\s\S]*?)^\}/mu.exec(tokens)?.[1] ?? "";
    const desktop = roles(root);
    const device = (name: string) => ({ ...desktop, ...roles(new RegExp(`:root\\[data-device="${name}"\\]\\s*\\{([^}]*)\\}`, "u").exec(tokens)?.[1] ?? "") });
    // Desktop readability revision: body 14, with secondary roles one pixel larger.
    expect(desktop).toEqual({ "2xs": 11, xs: 12, sm: 13, md: 14, lg: 15, title: 17, display: 24, code: 13, input: 14 });
    expect(device("tablet")).toEqual({ "2xs": 12, xs: 12, sm: 13, md: 15, lg: 16, title: 17, display: 24, code: 13, input: 16 });
    expect(device("phone")).toEqual({ "2xs": 12, xs: 13, sm: 14, md: 16, lg: 17, title: 17, display: 27, code: 14, input: 16 });
    // Every size is the role times the system's text size, then Tau's own step; a page head takes no step.
    for (const role of ["xs", "sm", "md", "lg", "title", "code"]) {
      expect(root).toContain(`--text-${role}: calc(var(--type-${role}) * var(--text-scale) + var(--text-step));`);
    }
    expect(root).toContain("--text-display: calc(var(--type-display) * var(--text-scale));");
    // The floor does not follow the Small step under 11px.
    expect(root).toMatch(/--text-2xs: max\(11px, calc\(var\(--type-2xs\) \* var\(--text-scale\) \+ var\(--text-step\)\)\);/u);
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
