# ADR 0042: The user customizes every part by name

Accepted, 2026-10-14. Builds on [ADR 0002](0002-core-owns-placement-extensions-own-features.md)
(core owns placement) and draws user code on [ADR 0032](0032-sandbox-frame-and-mcp-apps.md)'s
frame, within [ADR 0041](0041-remote-code-stays-out-of-native-clients.md).

## Context

A kit could change another kit only where that kit offered a service for it.
Usage asked a fixed list of kits for limits, and nothing could take Usage's
juicebars out of the sidebar's foot short of turning Usage off. The user wants
the freedom of a browser's user styles and user scripts, without what makes
those break: selectors on markup that changes with every release.

## Decision

**Parts have names.** Every renderable contribution of the kinds below is a
part with a name, `<kind>:<id>`; a component a contribution carries besides
its body is `<kind>:<id>/<Field>`. Core draws each part with
`data-tau-part="<name>"`. A name is API: renaming one needs an alias for a
release.

| Kind | Name | Fields |
|---|---|---|
| region | `region:<id>` | |
| status item | `status:<id>` | |
| panel | `panel:<id>` | |
| page | `page:<id>` | `Summary`, `Sidebar` |
| sidebar module | `sidebar:<id>` | |
| composer control | `composer-control:<id>` | |

**Core applies one customization layer.** `registerCustomizations(layer)`
(API 1.62.0) hands core `{ hidden, order, placement, replaced }`, keyed by part
name. Core applies it where it lists contributions: a hidden part is left out,
`order` and a region's `placement` override the kit's, and a replaced
component is drawn instead of the original with the original's props plus
`Original`. One layer applies, the last registered; a missing part is skipped
and listed. Behaviour (hooks, gates, send modes, keybindings, tool cards) and
core's own surfaces (Settings, the palette, approvals, the Read-only notice)
are not parts and cannot be customized.

**Customize Kit owns the feature.** `kits/customize` keeps the user's
customizations on the host (`customizations.json` in its state folder), so
every device of that machine follows them, and lends them to core as the
layer. It adds user styles (CSS a device mounts after every kit's sheet),
user scripts (HTML and JavaScript that replace a part or add one at a
placement), a picker that names the part under the pointer, and Settings →
Customize to undo any of it. Turning the kit off, or safe mode, restores
Tau as shipped.

**User scripts run on the sandbox frame, on every client.** The host publishes
a script as a frame document with Tau's theme tokens and a small bridge; it
runs in an opaque origin and never in the workbench's realm, so ADR 0041
holds and a phone shows the same script as the desktop. Through the bridge a
script reads data a kit shared (a service of the `SharedData` shape),
opens a page and runs a command; it reports its height. Usage shares its
limits as `tau.usage/limits`.

## Consequences

- Hiding, ordering and moving are data and reach every client at once.
- A script that replaces a part is a box: it cannot reach into the original's
  React tree, and each one costs a frame.
- Freedom inside the realm stays with packages: a local package uses the same
  `registerCustomizations` seam and the development loop.
- Not decided here: per-device customizations (all are per machine now),
  customizations from a project's `.tau` folder, and a picker on touch.
