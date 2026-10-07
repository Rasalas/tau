# Control sizes

Tau's shared control rules, revised 7 October 2026. Typography builds on
[ADR 0029](../adr/0029-type-scale-per-device-class.md). The
[T3 Code comparison](../research/t3code-control-sizes-2026-10-07.md) records
equivalent controls and the upstream source revision.

## Text roles

Use the role of the text, regardless of the component that contains it.

| Role | Token | Desktop default | Examples |
|---|---|---:|---|
| Control label | `--text-control` | 14 px | Buttons, menu choices, model and reasoning selectors, segmented choices |
| Input | `--text-input` | 14 px | Search, prompt, settings fields, including paths and keys |
| Body | `--text-md` | 14 px | Thread names, prose, settings labels |
| Secondary | `--text-sm` | 13 px | Descriptions and explanatory sub-lines |
| Metadata | `--text-xs` | 12 px | Shortcuts, counts, status, model badges |
| Code | `--text-code` | 13 px | File contents and diffs |

`--text-control` aliases the existing body role. It follows the same device
scale and Text size setting, without adding an independent type scale.
Density changes spacing and control boxes, never font or icon size.

Use whole roles. Do not subtract a pixel from a text token to make a field
smaller, hard-code 12.5 px in a control, or shrink a monospace input with
`em`. User-entered text keeps the input role even when it is a file path.

## Control and icon roles

| Role | Box token | Desktop default | Icon token | Default icon | Examples |
|---|---|---:|---|---:|---|
| Regular | `--control-size` | 32 px | `--icon-size` | 16 px | Search, composer controls, settings fields, toolbars |
| Large | `--control-size-large` | 36 px | `--icon-size-large` | 18 px | Sidebar footer navigation |
| Inline helper | `--control-size-small` | 24 px | `--icon-size-small` | 14 px | Copy, close and small row actions |

The box tokens include `--density`. Prefer `min-height` for controls holding
text. Settings' `--control-h` also leaves room for the label's line height,
so compact density cannot clip larger text. The workspace context card uses
the large row height with regular 16 px icons and control labels.

An icon-only action has a square target. A labelled action takes its width
from its content. Main action icons use the role's icon token, including
icons supplied by kits. A chevron is an indicator, not the main action icon,
and may remain 12 px. Provider logos, project marks, notification dots,
switch tracks and usage bars are separate graphics, not action icons.

Help, origin and reset actions use the inline helper role too. Their
information is secondary, but their action still needs a consistent target.
Do not enlarge a switch's track to the dimensions of a text field.

## Touch and narrow layouts

Touch controls keep `--touch-target` as their minimum target. Existing compact
profile rules take precedence over desktop box sizes. Inputs stay at least
16 px on touch devices. Metadata and descriptions use the same text roles
with the device-specific values from ADR 0029.

A narrow desktop window still uses desktop typography. Let choices wrap,
use the existing overflow menu, or truncate a secondary label. Do not shrink
the primary label to fit. Virtual lists retain their declared row pitch;
badges must fit that row without increasing its height independently.

## Where the rules apply

The shared tokens live in `src/renderer/tokens.css`. The following consumers
use them: sidebar search and footer, composer footer, stage toolbar,
workspace context card, settings fields and choices, shared menus, model
picker controls and badges, command palette text, and review controls.

T3 Code uses 32 px targets, 16 px icons and 14 px labels for ordinary desktop
controls, with 28 px and 24 px variants for tighter contexts. Tau uses the
same regular role and retains the larger sidebar footer requested here.
T3's resting composer intentionally uses 12 px labels; Tau keeps its
composer labels at the readable control role.

## Verification

Measure computed CSS sizes in the isolated Tau instance, not SVG attributes
or screenshot pixels. Check normal density and text first, then compact and
comfortable density, all three Text size settings, and a narrow window.
Verify that inputs, choices and icons stay visible and that touch targets
retain their larger minimum. Run the existing token, settings, composer,
model picker and sidebar tests after changes to shared rules.
