# T3 interaction parity, 29 October 2026

Compared upstream changes after the 11 October audit against Tau `4df3128d4`.
Upstream checkout was `/tmp/tau-t3code-upstream-20261029`, pinned to
[`7a4f5b6188fed54ddc866723e39446a198b5835c`](https://github.com/pingdotgg/t3code/commit/7a4f5b6188fed54ddc866723e39446a198b5835c).
Read AGENTS.md, CONTEXT.md and ADRs 0002, 0003, 0019 and 0030 before editing.
This was a bounded source review, not a full parity audit.

## Implemented

1. Dollar amounts no longer open the skill menu. Upstream
   [`1ee0241730ef5d2592347280118a2c77e8fb797c`](https://github.com/pingdotgg/t3code/commit/1ee0241730ef5d2592347280118a2c77e8fb797c)
   fixes prices such as `$9.99`, `$.99`, `$1,000` and `$10k.`. Tau still opened
   its leading `$` menu for these. `ComposerAutocomplete.tsx` now suppresses
   amounts, including inline amounts when multiple skills are supported.
   It checks the rest of the current token too, so editing `$1password` after
   `$1` preserves the skill menu. `$`, `$1password` and `$2fa` still work.
   Submission text and selected-skill metadata are unchanged.
2. Double-click selects the complete ordinary inline code span. Upstream
   [`725573f35850b3414f2e71a55ea7b8412fcfac1e`](https://github.com/pingdotgg/t3code/commit/725573f35850b3414f2e71a55ea7b8412fcfac1e)
   makes commands such as `migration-gate --dry-run` easy to select.
   Tau's `Markdown.tsx` now does the same. Fenced code retains native word
   selection; file chips retain their existing interactions. No styling changes.
3. Terminal links retain complete Unicode relative paths. Upstream
   [`9ac1355e01efd84c0aded502b44b41b24ebb4130`](https://github.com/pingdotgg/t3code/commit/9ac1355e01efd84c0aded502b44b41b24ebb4130)
   replaces ASCII filename matching. Tau's `kits/terminal/links.ts` still used
   `\w`, truncating names such as `src/żółć.ts:12:7` or detecting a slash inside
   Unicode prose as an absolute path. Matching now includes Unicode letters,
   combining marks and numbers, with Unicode-aware boundaries.
   The same review found that Tau mapped UTF-16 offsets directly to terminal
   columns. It now reads xterm's actual cells for non-ASCII rows, so combining
   marks, surrogate pairs and wide glyphs preserve the clickable range across
   wrapped lines. `view.tsx` includes the full final cell when a link ends in a
   wide glyph. ASCII rows keep the inexpensive direct mapping.

Changed implementation files:

- `src/renderer/components/ComposerAutocomplete.tsx`
- `src/renderer/components/Markdown.tsx`
- `kits/terminal/links.ts`
- `kits/terminal/view.tsx`

Added regressions in `Composer.inline.test.tsx`, `Composer.commands.test.tsx`,
new `Markdown.selection.test.tsx`, and `kits/terminal/links.test.ts`. They cover
amount syntax and caret edits, numeric skill names, sending an amount unchanged,
whole-command selection, unchanged fenced-code selection, Unicode path positions
and wrapped terminal cell coordinates.

## Existing coverage and deferred work

- Tau already has the slash-path suppression from upstream
  [`deb5b3941dc4c8b3f770621dca37ddb57c4ccec9`](https://github.com/pingdotgg/t3code/commit/deb5b3941dc4c8b3f770621dca37ddb57c4ccec9),
  including text after the caret. See `ComposerAutocomplete.tsx` and
  `Composer.inline.test.tsx`. IME Enter protection is also present.
- Palette Back already restores each level's query, as in upstream
  [`6567ffd55937d5af1f7b1e1a21c11a98f5bf640e`](https://github.com/pingdotgg/t3code/commit/6567ffd55937d5af1f7b1e1a21c11a98f5bf640e).
  See `CommandPalette.tsx` and its existing nested-level tests.
- Tau already searches thread message content and shows snippets through
  `kits/search`, including unopened runtime threads. Do not treat upstream
  [indexed search](https://github.com/pingdotgg/t3code/commit/bb7783e295506ad423f527ed28a019836e331e8c)
  as a wholly missing feature. Its relevance ranking and
  [excluding children from search](https://github.com/pingdotgg/t3code/commit/4812dcad02a86874533540e6a0c4b7f5eaea297a)
  remain useful follow-ups. Tau currently sorts title matches by recency and
  permits child threads for nonempty queries in `kits/search/palette-sources.ts`.
  That kit is outside this assignment; no cross-scope edits were made.
- [Searching submenu options directly](https://github.com/pingdotgg/t3code/commit/e9d61252f6fd8369b80fe8f7e07209cbbb7221d9)
  is still missing. Tau's menu API supports asynchronous, context-sensitive
  children, so a bounded search/enumeration policy belongs in a separate change.
- Windows terminal links, Markdown Windows-path preservation, heading anchors,
  wide-table controls and terminal window-edge selection scrolling already exist.
  The earlier audit's recommendations were not used as a list of current gaps.
- Upstream's [numbered-list nesting fix](https://github.com/pingdotgg/t3code/commit/fec83a18e363cd0817064baeff181c3dd7e37f7d)
  builds on richer composer editing than Tau's textarea currently offers.
  Rich editing and [LaTeX rendering](https://github.com/pingdotgg/t3code/commit/cb0553ea3941efd084aea57b0d096048fdc8ea15)
  were left for separately scoped work. Quoted terminal filenames with spaces
  also remain a gap; this patch retains the existing unquoted-path rules.

## Validation for the integrating parent

No tests, typechecks, builds, installs or app sessions were run. Scoped
`git diff --check` passed. Run the combined checks once after integration:

```sh
npm test -- kits/terminal/links.test.ts kits/terminal/view.test.tsx src/renderer/components/Composer.inline.test.tsx src/renderer/components/Composer.commands.test.tsx src/renderer/components/Markdown.selection.test.tsx src/renderer/components/Markdown.render.test.tsx
npm run typecheck:kits
node scripts/check.mjs typecheck -p tsconfig.json --noEmit
```

For real-app verification, use the isolated Tau instance workflow. Check a
leading price, double-click a command in a reply, and Ctrl/Cmd-click an accented
or wide-character terminal path. Native browser word-selection behavior is not
simulated by jsdom; the regression verifies the selection handler and that the
fence leaves the selected range alone.
