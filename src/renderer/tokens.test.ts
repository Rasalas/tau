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
  "./components/model-picker.css",
  "./components/command-palette.css",
  "./components/reload-conflict.css",
  "./renderer-benchmark.css",
  "./components/diff-view.css",
].map((path) => new URL(path, import.meta.url));
const KITS = fileURLToPath(new URL("../../kits", import.meta.url));

/** A colour written out rather than named: what only `tokens.css` may contain. */
const RAW_COLOUR = /#[0-9a-fA-F]{3,8}\b|(?<!\/\* )\brgba?\(|\bhsla?\((?!var\()/gu;

/** Custom properties the client sets on an element at runtime, not tokens a theme owns. */
const RUNTIME_PROPERTIES = [
  "--project-hue",
  "--used",
  "--keep-clear-x",
  "--menu-shift-x",
  "--menu-shift-y",
  "--composer-inset",
  "--font-family-override",
  "--font-size-override",
  // Typography a client sets on <html> beside the two above (Appearance Kit).
  "--prompt-font-family",
  "--prompt-font-size",
  "--code-font-family",
  "--code-font-scale",
  "--page-zoom",
];

/** The surfaces text is read on. `--raised` and `--sunken` carry chips and code, not prose. */
const TEXT_SURFACES = ["shell", "stage", "chrome", "field", "overlay"];
/** Tokens that carry running text: WCAG AA, 4.5:1. */
const AA_TEXT = ["ink", "ink-prose", "ink-2", "ink-3", "ink-code", "muted"];
/** Accent and status tokens used as text or as an icon beside it. */
const AA_ACCENT = [
  "acid-text", "working", "ready", "removed", "cyan", "info-ink", "danger", "warn", "fail-ink",
  "syntax-fn", "diff-add-ink", "diff-del-ink", "diff-add-edge", "diff-del-edge",
];
/** Marks, fills and small print: AA for large text and non-text contrast, 3:1. */
const AA_LARGE = ["muted-2", "faint", "stop", "info", "done", "fail", "focus", "stale", "folder"];
/** Ink that sits on a fill rather than on a surface. */
const ON_FILL: ReadonlyArray<[string, string]> = [
  ["acid-ink", "acid"], ["acid-ink", "acid-strong"],
  ["diff-add-mark-ink", "diff-add-mark"], ["diff-del-mark-ink", "diff-del-mark"],
  ["diff-add-ink", "diff-add-bg"], ["diff-del-ink", "diff-del-bg"], ["acid-text", "acid-chip"],
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
    // The mark on the stop button and a QR code are the same in both schemes on
    // purpose; anything else with one value is a token that was not themed.
    expect(single.map(([name]) => name).sort()).toEqual(["--qr-ink", "--qr-paper", "--stop-ink"]);
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
