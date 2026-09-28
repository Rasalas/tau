import { parseHex } from "./color.js";

/**
 * The colour tokens a theme may set (docs/EXTENSIONS.md §8), grouped the way
 * the table groups them. `tokens.test.ts` holds this list against tokens.css.
 */
export const TOKEN_GROUPS: ReadonlyArray<{ id: string; title: string; tokens: ReadonlyArray<readonly [name: string, role: string]> }> = [
  {
    id: "surfaces",
    title: "Surfaces",
    tokens: [
      ["--shell", "the window"], ["--well", "an inset control"], ["--rail", "the sidebar"], ["--chrome", "title bar, panel chrome"],
      ["--stage", "the document area and panel bodies"], ["--sunken", "a well inside a surface"], ["--field", "an input"],
      ["--thread-active", "the selected thread row"], ["--raised", "a chip or inline code"], ["--raised-strong", "a raised surface, hovered"],
      ["--raised-hover", "a raised control, hovered"], ["--overlay", "a modal panel"], ["--float", "a menu, a toast, a popover"],
      ["--hover", "a hovered row"], ["--hover-strong", "a hovered row that needs to read"], ["--code-bg", "code blocks and diffs"],
      ["--inset", "a block inside a settings page"], ["--chip", "a small label"], ["--chip-hover", "a small label, hovered"], ["--track", "an empty progress track"],
    ],
  },
  {
    id: "hairlines",
    title: "Hairlines",
    tokens: [
      ["--line", "the ordinary hairline"], ["--line-soft", "a hairline that barely shows"], ["--line-inset", "between rows of a list"],
      ["--line-card", "the edge of a card"], ["--line-control", "the edge of a button"], ["--line-strong", "an edge to be read as one"],
      ["--line-field", "the edge of an input"], ["--line-focus", "a field with focus"], ["--line-float", "a menu edge"], ["--line-hover", "an edge, hovered"],
    ],
  },
  {
    id: "ink",
    title: "Ink",
    tokens: [
      ["--ink", "headings and emphasis"], ["--ink-prose", "assistant prose"], ["--ink-2", "body text of the chrome"], ["--ink-3", "secondary text"],
      ["--ink-code", "code and diff bodies"], ["--muted", "labels"], ["--muted-2", "small print"], ["--faint", "glyphs and disabled text"],
      ["--fainter", "a hint of a mark"], ["--scrollbar", "the scrollbar thumb"], ["--scrollbar-hover", "the thumb, hovered"],
    ],
  },
  {
    id: "accent",
    title: "Accent",
    tokens: [
      ["--acid", "the accent as a fill"], ["--acid-text", "the accent as text"], ["--acid-ink", "text on the accent fill"],
      ["--acid-strong", "the accent fill, hovered"], ["--acid-bg", "the accent as a surface"], ["--acid-line", "the accent as an edge"],
      ["--acid-chip", "the accent behind accent text"], ["--acid-track", "the accent as a filled track"], ["--focus", "the focus ring"],
      ["--user-bubble", "the user's own message"], ["--user-bubble-ink", "its text"],
    ],
  },
  {
    id: "status",
    title: "Status",
    tokens: [
      ["--working", "a file a turn changed"], ["--ready", "a run that finished"], ["--removed", "something taken away"], ["--stop", "the abort control"],
      ["--cyan", "numbers and types"], ["--danger", "destructive text"], ["--warn", "a caution"], ["--fail", "a failed run's mark"],
      ["--info", "a run or a step in progress"], ["--done", "a step that finished"], ["--merged", "a merged request"],
    ],
  },
  {
    id: "diff",
    title: "Diff",
    tokens: [
      ["--diff-add-bg", "an added line"], ["--diff-add-ink", "its text"], ["--diff-del-bg", "a removed line"], ["--diff-del-ink", "its text"],
      ["--syntax-fn", "function and class names"],
    ],
  },
];

export const TOKEN_NAMES: ReadonlySet<string> = new Set(TOKEN_GROUPS.flatMap((group) => group.tokens.map(([name]) => name)));

/** The tokens the basic editor derives from its three colours. */
export const DERIVED_GROUPS = new Set(["surfaces", "hairlines", "ink", "accent"]);

export interface TokenProblem { token: string; message: string }

/**
 * What a theme file may carry: known names with an opaque hex colour each. The
 * values end up inside a stylesheet, so anything else — a `;`, a brace, a
 * function — is refused rather than escaped.
 */
export function validateTokens(tokens: Readonly<Record<string, string>>): TokenProblem[] {
  const problems: TokenProblem[] = [];
  for (const [token, value] of Object.entries(tokens)) {
    if (!TOKEN_NAMES.has(token)) problems.push({ token, message: `${token} is not a colour token a theme may set` });
    else if (!/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/iu.test(value) || !parseHex(value)) problems.push({ token, message: `${token} needs a colour like #1c1b15, not ${JSON.stringify(value)}` });
  }
  return problems;
}

/** A theme's id from its name: what the file is called and what `data-theme` says. */
export function themeIdFromName(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48);
}

export function isThemeId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,47}$/u.test(id);
}
