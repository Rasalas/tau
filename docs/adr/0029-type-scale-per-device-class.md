# ADR 0029: Type scale per device class

## Status

Accepted, 2026-09-29 (ticket K105). Builds on K96, which set the desktop to the
design's sizes, and on K94's Text size setting.

Revised 2026-09-30: desktop body and input are 14 px, matching T3 Code.
The user found the 13 px desktop text too small on their screen. Meta,
secondary, lead rows and code also increase by 1 px; headings and touch
device sizes keep their existing values.

## Context

The workbench design (`.scratch/design/tau-workbench-2026-09-29/`) draws a
desktop at meta 11, controls 12, body 13, a thread's heading 17 and a page's
heading 24 px, and K96 set the type tokens to exactly that. Its mobile screens
(1m–1x, 2l–2p, 390 × 844) reuse the same numbers: body 13, secondary 12, meta 11,
the title bar 15, sheet rows 14, the composer 14, a page title 22.

The phone and the tablet read the desktop's tokens, and the touch stylesheets
raised some places to fixed 15, 16 or 17 px. The result was a mix: a thread row
at 16, the chat at 13, meta anywhere from 10 to 13. The user found the text on
the phone too small and asked for the platform rules to be checked; the design
stays the reference for layout.

What the platforms say:

- **Reading distance and width.** A phone is held at 30–40 cm, a tablet a little
  further, a laptop's screen at 50–70 cm. A phone's column is 360–430 px wide,
  so lines are short and a larger size costs little.
- **Apple HIG.** macOS body 13 pt. iOS at the default text size: Body 17,
  Callout 16, Subheadline 15, Footnote 13, Caption 12 and 11; nothing under
  11 pt.
- **Material 3.** Body Large 16 sp, Body Medium 14, Body Small 12, Label Small
  11.
- **iOS input rule.** WebKit zooms the page into a focused field whose text is
  under 16 px.
- **System text size.** Both platforms let the user choose a text size (iOS
  Dynamic Type, Android's font scale), and an app should follow it. WKWebView
  leaves pixel sizes alone. Android's WebView sets its text zoom from the font
  scale, which scales text but not the boxes around it, so fixed-height rows
  clip.

### Where the design falls below the platforms

Measured with K96's scripts on the rendered design (K105's table has every
element):

| Element (screen) | Design | iOS (HIG) | Android (M3) | Gap |
|---|---|---|---|---|
| Body: chat, thread rows, settings rows (1m, 1n, 1s) | 13 | Body 17, Callout 16 | Body Large 16 | 3–4 px under |
| Secondary: tool steps, option details, chips (1n, 1p) | 12 | Subheadline 15, Footnote 13 | Body Medium 14 | 1–3 px under |
| Meta: branch, age, title-bar details, counts (1m, 1n, 1p) | 11 | Footnote 13; 11 is the minimum | Body Small 12 | at Apple's minimum, under Material's 12 |
| Bottom navigation labels (1m) | 10.5 | tab bar 10 | Label Medium 12 | under Material |
| A file's status letter (2l) | 10 | 11 minimum | Label Small 11 | under both minimums |
| Code and diffs (1q, 2l, 2o) | 11 mono | 11 minimum | – | at the minimum; hard to read in a diff |
| Composer and search fields (1n, 1o, 1w) | 14 | Body 17 | Body Large 16 | under 16: iOS zooms on focus |
| Title bar (1n, 1t, 2l) | 15 | Headline 17 | Title Large 22 | 2 px under |
| Page title (1p, 1r, 1s) | 22 | Title 1 28, Large Title 34 | Headline Small 24 | under both |
| Sheet rows and model names (1w, 1x) | 14 | Body 17 | Body Large 16 | 2–3 px under |
| Segments, "Ready 4" (1p) | about 30 px high | 44 pt target | 48 dp target | under the touch target |

On an iPad the design's desktop sizes apply, 4 px under iPadOS's Body 17.

## Decision

### Three device classes

`src/renderer/type-scale.ts` decides the class once, before the first render:
a client with the compact profile and a touch pointer is a **phone** when its
screen's shorter side is under 600 px (`TABLET_SCREEN_MIN_SIDE_PX`), else a
**tablet**; everything else, a narrowed desktop window included, is a
**desktop**. The screen decides, not the window: an iPad in Slide Over keeps the
tablet's sizes. The web client and the native app set `data-device` on
`<html>`; the desktop sets nothing.

### The table

Each role is a `--type-*` base per class. Desktop sizes use the readability
revision above; the design remains the layout reference.

| Role | Token | Desktop | Tablet | Phone | Why |
|---|---|---|---|---|---|
| Meta: age, branch, counts, section labels | `--text-xs` | 12 | 12 | 13 | never under 12 on a touch device; HIG Footnote 13, M3 Body Small 12 |
| Secondary: sub-lines, controls, chips | `--text-sm` | 13 | 13 | 14 | M3 Body Medium 14; one step under body, as in the design |
| Body: chat, rows, titles in a list | `--text-md` | 14 | 15 | 16 | HIG Callout 16, M3 Body Large 16; a tablet sits between |
| Lead row of a sheet or menu | `--text-lg` | 15 | 16 | 17 | the design draws sheet rows one step over body; HIG Body 17 |
| A thread's heading, a sheet's title | `--text-title` | 17 | 17 | 17 | HIG Headline 17; already the desktop's |
| A page's heading | `--text-display` | 24 | 24 | 27 | the mobile design's 22 over its 13 body, at a 16 body |
| Code, diffs, the file tree | `--text-code` | 13 | 13 | 14 | a step under body: mono runs wider |
| What the user types | `--text-input` | 14 | 16 | 16 | iOS zooms into a field under 16 |

Line heights stay relative (`1.3`, `normal`, `em`), so they scale with the text.
The layout of the mobile design (spacing, order, pills, sheets) stays; its
sizes are replaced by this table. A phone's tab pages (Threads, Reviews, Usage,
Settings) carry their title at `--text-display`, as 1p, 1r and 1s draw it.

### The order: the system's text size, then Tau's

```
--text-<role> = --type-<role> × --text-scale + --text-step
```

- `--text-scale` is the system's text size on a touch device, 1 at the system's
  default, so the default gives exactly the table. It is clamped to 1–1.5.
  Smaller system sizes keep the default: meta would fall under 12 px. Above
  1.5, a 390 px phone's rows stop holding their line. iOS's largest standard
  size is 1.35 and Android's 1.3, so both are followed in full.
- `--text-step` is Tau's Text size (Appearance Kit): −1, 0 or +1 px on every
  role but the page heading.
- `--text-input` never goes under 16 px on a touch device, whatever the step.

Per platform:

- **iOS, app and Safari:** WebKit draws `font: -apple-system-body` at the Body
  size Dynamic Type chose. A hidden probe carries it, and the scale is its size
  over 17 px. A `ResizeObserver` on the probe and the page's
  `visibilitychange` re-read it, so a change in Settings applies without a
  reload. Verified in the iOS 27 Simulator with `simctl ui content_size`:
  XL 1.12, XXL 1.24, XXXL 1.35, AX5 held at 1.5, xS and L 1.
- **Android app:** the Tau Native plugin sets the web view's text zoom to 100
  and reports `Configuration.fontScale` (`textScale()`), then sends a
  `textScale` event on a change. The manifest lists `fontScale` in
  `configChanges`, so a change does not recreate the activity.
- **Android browser:** Chrome applies its own accessibility scaling to the page;
  a page cannot read the font scale, so the scale stays 1.
- **Desktop:** no system text size; the window's zoom (View → Zoom) and Tau's
  Text size are the desktop's.

### Rows and touch targets

- `--touch-target` is 44 px × `--text-scale`. A row or button that holds text
  takes it as its `min-height`. Icon-only buttons keep 44 px, so a larger text
  size does not take the title bar's width from the title.
- A container that holds text gets a `min-height` or an `em` height, not a fixed
  pixel height. The phone's title bar grows with its title and two lines of
  details.
- Virtual lists (the file tree, the model picker, the project picker) keep the
  fixed pitch their component gives the list. Their rows are sized to hold one
  line at 1.5.

### Adding a text role

1. First use an existing role: the list above covers meta, secondary, body,
   a lead row, headings, code and input.
2. A new role gets a `--type-<role>` base on `:root` in `tokens.css` (the
   desktop size), a value in both `data-device` blocks (by the reasons
   in the table: body 16 on a phone, meta at least 12, input at least 16), and
   `--text-<role>: calc(var(--type-<role>) * var(--text-scale) + var(--text-step))`
   (a page-level heading leaves out the step).
3. Add it to `tokens.test.ts`, to the token table in `docs/EXTENSIONS.md` and to
   the table above.
4. Stylesheets read `var(--text-<role>)`; never a pixel font size in a touch
   rule.

## Consequences

- Desktop body and input read at 14 px; secondary text and code increase
  with them. Tau's Text size still moves every role by a pixel except page
  headings.
- Screenshots of the phone no longer match the mobile design pixel for pixel.
  They match its layout, and sizes follow the table.
- At the default size, the phone's title bar is about 61 px high rather than
  the design's 48, because its two lines of details read at 13 px.
- `kits/usage` still has fixed sizes (10.5 and 21 px) on the phone. It follows
  the table once its own ticket moves it onto the tokens.
- A kit's touch rules must use the `--text-*` tokens and `--touch-target`.
  Otherwise the system's text size passes them by.
