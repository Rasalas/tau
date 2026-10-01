# Writing a Tau package

This is the entry document for anyone writing a Tau extension package. It
follows the code, not the aspiration; where the code and an ADR disagreed
while writing this, a footnote says so.

## Your first package

The rest of this document is a reference. The path from nothing to a package
you use is short; [the tutorial](kit-tutorial.md) walks it with a real kit:

1. **Start one**: `tau kit new my-kit` in a terminal writes `my-kit/` with a
   manifest for the extension API this Tau runs (`engines.api`), a desktop half
   with a button in the thread header and a command in the palette, a host
   half in a worker with one command, a stylesheet, a README and a
   `tsconfig.json` with the API's types in `.tau-types/`, so your editor checks
   the package without an `npm install`. Its id is `local.my-kit` unless
   `--id` names one. Settings shows it as `--name`, else as the folder name in
   title case with acronyms kept (`pr-title` → *PR Title*); `--no-host` leaves
   the host half out. Tau compiles the
   entries itself; there is no build step. [§2](#2-a-minimal-example-exampleshello-package)
   is a package written by hand.
2. **Install it**: `/install /path/to/my-kit` in the composer (every project),
   or with `-l` for the project on screen; `tau kit new my-kit --install` asks
   the running Tau to do it. The folder is loaded where it lies.
3. **Approve it**: the install toast's **Review** opens it in Settings →
   Extensions, where it waits under *Needs attention*; **Allow and turn on**.
   It starts at once; no `/reload`.
4. **Edit and save.** The package reloads by itself, host half included, and
   a toast says *Reloaded &lt;name&gt;* ([the development loop](#the-development-loop)).
   A save that does not compile keeps the running version: the toast names the
   file, line and column of the first error, and Settings → Packages →
   *Develop a package* shows the last build of each half with every error.
   Changing `permissions` or `isolation` sends it back to step 3, and the toast
   says *&lt;name&gt; is waiting for approval*.
5. **After updating Tau**, `tau kit types` in the folder copies the new
   [types](#types-for-a-package-of-your-own) in.

**Project trust.** Packages in `<project>/.tau/packages.json` or
`<project>/.tau/extensions` load only where Pi trusts the project. In a project
Pi does not trust they are listed in Settings → Extensions as *Skipped:
project not trusted*, the install toast says so, and **Trust this project**
(in that toast, or in Settings → Packages) records the trust in Pi's
`trust.json` through Pi's own store, the way Pi's `/trust` does; the packages
then load and wait for approval. A global install needs no trust. A project
install writes `.tau/packages.json` into the project. A folder inside the
project is recorded relative to it (`./kits/my-kit`), so every clone finds it.
A folder outside is recorded as its absolute path, and while the file names
only such folders Tau keeps it out of Git through the clone's own
`.git/info/exclude` unless Git already tracks it, so the project shows no change.

**What a package usually needs next:** the thread's branch and pull requests
come from [two services](#a-threads-branch-and-pull-requests-tauworkspacebranch-and-taureviewpull-requests),
not from running `git` yourself; controls that call the host half turn off with
the reason while it does not run ([`useHostAvailability`](#when-the-host-half-does-not-run-usehostavailability));
bad input from a command is a [`HostCommandError`](#5-failure-model), from
`tau/host` in a worker.

## 1. What a package is

A **bundled kit is a package Tau ships.** Everything below is true of both:
the kits under `kits/` in this repository carry the same `tau-extension.json`,
declare the same `permissions` and `isolation`, are compiled by the same two
bundlers and are activated by the same registry, with the same
`guardedServices` in front of the host seam. Two things differ, and only two:
a kit needs no grant (shipping it *is* the approval, so it never appears
waiting for approval and never reaches `~/.tau/extension-grants.json`), and it
is loaded from `dist-kits/` beside the app rather than from a folder in
`~/.tau`. Settings lists it as `bundled` with its permissions.
[ADR 0014](adr/0014-bundled-kits-are-packages.md) has the reasoning;
[`kits/README.md`](../kits/README.md) is the recipe.

The kits together are **`@tau/kits`**, a distribution with a version of its
own: `kits/package.json` declares it and the build ships it as
`dist-kits/manifest.json`. Nothing about it is privileged — a third party
assembles a distribution the same way, out of packages a user installs.

A package is a folder under `~/.tau/extensions` (every project) or
`<project>/.tau/extensions` (that project only, and only where Pi trusts the
project) with a manifest named `tau-extension.json` at its root
(`MANIFEST_FILE` in `src/main/extension-packages.ts`).

A package has up to two halves, sharing one `id`:

- **The host half** (`host` in the manifest) runs in Electron's main process.
  By default it runs isolated in its own worker thread; it may instead run
  **in-process**, a privilege declared in the manifest and granted like a
  permission (see §6). Its default export (or a factory returning it) is a
  `HostExtension`: `{ id?, name?, activate(context) }`. `activate` gets a
  `context` with `context.services` (a curated facade, `HostExtensionServices`
  in-process or `WorkerHostServices` in a worker), `context.registerCommand`,
  `context.emit` and, in-process only, `context.fail`.
- **The desktop half** (`desktop` in the manifest) runs in the renderer. Its
  default export is a `DesktopExtension`: `{ id, name, activate(context) }`,
  where `context` is the same `DesktopExtensionContext` every bundled kit
  gets — panels, sidebars, commands, status items, and so on (see
  `src/renderer/extension-system.tsx`). `context.host.invoke(command, input)`
  is the only way the desktop half reaches its own host half; there is no
  direct call between them, and a package with no host entry gets a
  `context.host` that always rejects.
  `context.hostExtension(extensionId)` gives the same client for *another*
  extension's host half, which is how one package builds on another (Review Kit
  reads Workspace Kit's changes and diffs this way). Those commands belong to
  that extension's contract, not to core: an invoke fails like any other when
  it is not installed.
  Who may call a host command is its `access` (below): Full devices by
  default, Read-only devices too with `"read"`, only the host token on this
  machine with `"owner"`.

Either entry may be omitted, but not both. `id` is lowercase, dot-separated
(`vendor.name`), and must be the same string both halves export — the
manifest's `id` wins if a module disagrees.

**The Pi half** of a runtime Tau owns is not a manifest field: it is a Pi
extension the host half registers itself, in-process, with
`context.services.registerRuntimeExtension(name, factory)`. `factory` is a
plain Pi `ExtensionFactory`, `(pi: ExtensionAPI) => void`, from
`@earendil-works/pi-coding-agent` — the same function shape as a `.pi/extensions`
file, just handed to Tau instead of discovered by Pi. Inside it, `pi.registerTool(...)`
gives the agent a new tool, `pi.on(...)` an event handler, and so on: everything
`ExtensionAPI` offers. Once registered this way, every runtime the host creates
carries it, including a remote host's. `registerRuntimeExtension` is one of the
members a **worker cannot reach** (§6), so a package that wants a Pi tool needs
`"isolation": "in-process"`.

The factory's second argument says which session it serves: `sessionId`, `cwd`
and, for a thread another one spawned (`sessions.start({ parent })`),
`parentThreadId`. The option `shellCommandPrefix(session)` (API 1.15.0) gives
that runtime shell lines Pi runs before every `bash` command, the user's `!`
commands included, ahead of the user's own `shellCommandPrefix` from Pi's
settings. They run in the shell Pi starts, outside whatever a `tool_call`
handler rewrote the command to, so they hold whichever extension loaded first:
Servers wraps a limited project's commands in its sandbox there, and Agents
Kit's line still lowers the shell that starts the sandbox. Tau asks once per
runtime; `undefined` adds nothing. Keep the lines silent and let them fail
quietly (`{ …; } >/dev/null 2>&1`): they share the shell and the output with
the command.

`context.services.loadRuntimeExtension(packageName)` answers with the factory a
Pi extension Tau ships as one of its own npm dependencies exports. The host
resolves the package, so it keeps the layout npm gave it and still finds the
files it ships beside itself — native binaries a driver launches, for instance,
which a copy bundled into an extension would no longer find. It needs
`runtime:extend` like `registerRuntimeExtension`, and a worker cannot reach it
either. Computer Use (`kits/computer-use/`) is the example: it loads
`@amaster.ai/pi-computer-use` this way and registers what it gets back.

`context.services.loadDependency(packageName)` is the same resolution for a
dependency that is not a Pi extension: it answers with the module itself (a
CommonJS module's `module.exports`, an ES module's namespace). It exists for
native addons, which find their binary beside themselves only where npm put
them — Terminal Kit (`kits/terminal/`) loads `node-pty` this way. It needs no
permission, because it hands out nothing the host process did not already
have, but a worker cannot reach it: a module is a live object.

**A runtime Tau does not own** — a Pi TUI that already holds the session, which
Tau attaches to — cannot be handed a closure. That case is the manifest's `pi`
entry: a module default-exporting `(pi: ExtensionAPI, bridge: PiKitBridge) =>
void`. It is compiled with the host bundler (Pi itself external) into
`dist-kits/<id>/pi.cjs`, and `.pi/extensions/tau-session-bridge.ts` requires it
inside the Pi process — so no kit source is ever read by jiti, where no `tau/*`
specifier resolves. `PiKitBridge` (`tau/host-extension`) is what the bridge
lends the half, everything keyed by the package's own id:

| Member | What it does |
|---|---|
| `registerCommand(name, handler)` | Answers `<id>/<name>`, which the host half calls with `services.attachedRuntime(sessionId).invoke(...)`. |
| `publishEvent(name, payload, ctx)` | Publishes an extension event to every attached Tau client; the host routes it to the desktop half. |
| `refreshSnapshot(ctx)` | Re-sends the transcript snapshot, for a new session entry the client must see. |
| `pinEntries(pin)` | Session entries the transcript page must keep, even when their message renders empty (a card anchored to a silent answer). |
| `observeUserTurns(observer)` | A turn Tau accepted, before Pi dispatched it, and a turn Pi refused. |
| `transcript(ctx)` | The branch as Tau projects it: skill wrappers reduced to their visible text. |
| `openSession(file)` | Reads another persisted session, e.g. the source of a fork. |
| `isCurrentSession(ctx)` | Whether this context is still the session the bridge serves. |

Workspace Kit (`kits/workspace/pi.ts`) captures turn checkpoints this way and
answers the historical file and diff queries the host cannot serve while Pi
owns the thread; Thread Title Generator (`kits/thread-titles/pi.ts`) titles the
thread with Pi's own model registry. Both are the same feature their host half
provides in a runtime Tau owns.

A kit words its own model requests. `HostThread` offers one completion seam,
`complete(provider, modelId, { system, prompt, maxTokens })`, and the caller
supplies both halves of the prompt; the title-shaped `completeTitle` it also
carried until 1.3.0 is **gone**, because it obliged core to know how a kit
phrases a title. Thread Title Generator keeps that wording once, in its own
`protocol.ts`, and sends it through `complete` here and through
`ctx.modelRegistry.complete` inside an attached Pi.

### The manifest

```json
{
  "id": "acme.hello",
  "name": "Hello",
  "description": "Says hello in every new thread.",
  "version": "1.0.0",
  "engines": { "api": "^1.0.0", "pi": ">=0.84" },
  "permissions": ["workspace:read", "process"],
  "isolation": "worker",
  "source": { "url": "https://github.com/acme/hello", "commit": "0123456789abcdef" },
  "desktop": "./desktop.tsx",
  "host": "./host.ts",
  "window": "./view.ts",
  "styles": "./styles.css",
  "pi": "./pi.ts"
}
```

| Field | Meaning |
|---|---|
| `id` | Lowercase, dot-separated; both halves must export it. |
| `name` | Shown in Settings. |
| `description` | One sentence, at most 200 characters, that Settings → Extensions shows under the name (optional; new in API 1.18.0). Say what the package does for the user, not how. |
| `icon` | The [Lucide](https://lucide.dev/icons) icon Settings → Extensions shows beside the name, by its component name: `"Search"`, `"KeyRound"` (optional; new in API 1.19.0). A runtime's mark or the icon of a page or panel the package adds comes first; without all three the list shows the name's first letter. |
| `version` | The package's own semver (optional). |
| `engines` | Ranges of `tau`, `pi` and `api` this package runs on (all optional; see below). |
| `permissions` | The permission vocabulary this package asks for (§ below); missing means none. |
| `isolation` | `"worker"` (default) or `"in-process"` (§6). |
| `source` | `{ url, commit? }`, shown in Settings → Inspector. Provenance only — it proves nothing by itself (§4). |
| `desktop` / `host` | Relative entry paths inside the package folder; either may be missing, and both may be when `styles` is there instead. |
| `window` | Relative entry path of the half that runs in the process the user's window lives in (§ below); optional, and only useful together with a `host` entry. |
| `styles` | Relative path of a stylesheet loaded while the package is active. On its own — no `desktop`, no `host` — it makes the package a **theme** (§8). |
| `pi` | Relative entry path of the package's half inside a Pi runtime Tau does not own (see above); optional. |

`desktop` and `host` entries are compiled with esbuild at load time (Node
builtins and `electron` stay external for the host half, `react`, `react-dom`
and `lucide-react` stay external — bound to the renderer's own copies — for the
desktop half, because a second copy of React or of react-dom holds its own
internals and quietly stops working; since API 1.27.0 `@tanstack/react-virtual`
is bound the same way, the copy the transcript runs, so a virtualized list costs
a kit no bundled copy of its own), so a package brings its own dependencies
from its own `node_modules` and needs no build step of its own. The shared list
is one list: `src/shared/shared-modules.ts` names the specifiers, the renderer
publishes exactly those and the kit prebuild takes its externals from the same
file, so a prebuilt kit binds what a compiled-on-the-fly one binds. In the host
bundle `import.meta.url` is the compiled file's own URL, so an ESM dependency
that builds a `require` from it (the Claude Agent SDK does) loads as bundled
code.

`registerKeybinding({ keys, commandId, when? })` adds a chord; the first binding of a
chord wins and a later one is recorded as a conflict. Pass `replaces:
<commandId>` when the chord is meant to *be* that command's key rather than
another one beside it — every other binding of that command is hidden while
yours lives and comes back when it is disposed, and a replacing binding wins
over a default on the same chord instead of colliding with it. Keybindings Kit
uses it for the actions the user rebound in `~/.pi/agent/keybindings.json`:
someone who wrote `app.session.new` there meant that key, not that key and
Tau's default too. Without `replaces`, a binding is additive, which is what a
package adding a chord of its own wants.

`registerUserKeymap({ id, label, setChords, resetAll })` (new in API 1.12.0)
offers the file Settings → Keybindings writes the chords the user records.
`setChords(commandId, chords)` replaces a command's chords (`{ key, when? }`,
`when` absent keeps the replaced default's clause, `"true"` applies
everywhere) and `undefined` gives the command its defaults back;
`resetAll()` gives every command its defaults. Resolve once the new chords
are bound: the owner still binds what the file holds with `registerKeybinding`
and `replaces`, and the page marks those chords, the owner's, as the user's.
One keymap at a time, the last registered wins; without one the page only
lists. Keybindings Kit registers `keybindings.json`. An element marked
`data-keybinding-capture` (new in API 1.12.0) gets every key while it has
the keyboard: no workbench chord runs, so a field that records chords can
take ⌘K.

`when` (new in API 1.10.0) says where a chord applies, as in VS Code:
context names joined by `!`, `&&`, `||` and parentheses, e.g.
`"terminalFocus && !stageFocus"`; `true` and `false` are constants. Contexts
come from the page when the key goes down. Mark an element
`data-keybinding-context="<name>"` (several names may be space-separated) and
`<name>Focus` holds while the keyboard is inside it, `<name>Open` while one is
drawn (`src/renderer/keybinding-context.ts`). Core marks `chat` (the
transcript and the composer), `composer`, `stage` and `modelPicker`; Terminal
Kit marks `terminal`, Files Kit's editor `editor` and Preview Kit's panel
`preview`. Two contexts nothing marks: `editableFocus` (new in API 1.11.0)
holds while a text field, a select or anything `contenteditable` has the
keyboard, so a chord native editing shares yields to it — Thread Rail's
`mod+z` is `"!terminalFocus && !editableFocus"`; `overlayOpen`
holds while an overlay is drawn: anything with `aria-modal="true"`, a
`role="dialog"`, `"alertdialog"` or `"menu"`, an app page (`registerPage`),
or an element marked `data-overlay`. A non-modal tool window that stays open beside the work (the
theme editor) opts out with `data-overlay="false"`. A clause Tau cannot read
throws at registration.

Escape belongs to the topmost overlay. `Dialog`, `Popover` and `Menu` close
the newest open one on Escape and consume the key; an overlay of your own
joins them with `useEscapeLayer`, or closes itself in its own key handler. Either way no chord without a modifier
runs while an overlay was open when the key went down, so core's Escape
(`runtime.abort`, under `chatFocus`) never stops a turn behind a picker.

A clause that needs a context — false when nothing is focused or open, like
`terminalFocus` but unlike `!terminalFocus` — makes the binding *specific*. On
a keydown, of the bindings whose chord and clause match, a config.json
override beats a replacing binding beats a default; within that, a specific
one beats one that is not; then the first registered wins. The winner is
chosen against the page as the key went down, before any handler under it
closes an overlay or moves focus. A specific winner with a modifier runs in
the capture phase, before the focused element sees the key: that is how
Terminal Kit's `mod+d` reaches its command before xterm, and Files Kit's
`mod+s` saves the editor tab before Prompt Tools' stash could hear it. Every
other binding, a bare key under a clause included, waits for the bubble phase,
so a field or a shell that handled a key (`preventDefault()`) keeps it. Two bindings conflict only when they press
the same keys on the platform (`mod+p` is `ctrl+p` off macOS), sit in the same
tier, are both specific or both not, and their clauses can hold together; so
`mod+n` can be a new thread under `!terminalFocus` and a new shell under
`terminalFocus`. A replacing binding without a `when` of its own takes the
clause of the replaced command's first default, so a rebound key keeps its
context.

A surface that wants the text field's own keys — ⌘Z, ⌥-letters, ⌃A on macOS —
calls `stopPropagation()` without `preventDefault()`: the field still acts, and
no bubble-phase binding does. A chord matches punctuation and digits by the
physical key too (⇧ turns `]` into `}`, ⌥ turns `2` into `™`), an `alt` chord
matches letters by the physical key as well, and off macOS no chord takes a
character AltGr typed. `kits/kit-lifecycle.test.tsx` fails when two bindings of
core and the shipped kits conflict on either platform, and checks which
command each shared chord reaches in each context. The defaults are listed in
[`docs/keybindings.md`](keybindings.md).

`registerCommand({ surfaces })` offers a command in a place besides the
palette: `thread-title` puts it in the thread title's menu, and `file-tab`
(new in API 1.10.0) draws it as a button in the header of a file tab on the
stage. A `file-tab` command reads the file from `actions.activeStageTab()` —
the tab the stage shows, of any kind — so the same command also works from
the palette. Files Kit's "Edit file" is the shipped caller. A command marked
`destructive` (new in API 1.11.0) is drawn in the danger colour and, in the
title menu, in a section of its own at the end — Thread Rail's "Delete
thread"; a `MenuItem` takes the same `destructive` flag. `runtime-switch`
(new in API 1.12.0) offers the command in the model picker while a thread that
exists looks at another runtime's models: the picker draws the label with the
runtime's name in place of a trailing ellipsis ("Continue in…" → "Continue in
Codex") and runs it with a second argument, `{ runtime }`; from the palette the
command runs without one. Handoff Kit's "Continue in…" is the shipped caller.
`thread-row` (new in API 1.13.0) offers the command on any thread of the
compact thread list — a phone's or a tablet's — and runs it with `{ threadId }`,
which need not be the open thread; from the palette or the title menu the
command gets no id and acts on the open one. A long press on a row lists every
`thread-row` command (destructive ones last); the swipe tray holds core's Settle
and the first non-destructive `thread-row` command that brings an `Icon` (new in
API 1.13.0, a component like a panel's). Thread Rail's Snooze, Archive and
Delete are the shipped callers, with Snooze in the tray.
On a device paired Read only, every place that offers a command (the palette,
the title menu, the compact list's sheet and tray, a file tab's header) shows
it disabled with the reason unless it declares `access: "read"` (new in API
1.13.0), and its chord shows the reason instead of running it. `"read"` means
the command changes nothing on the host: it only looks, or acts in this window
alone — opens a panel, moves focus, copies to the device's clipboard, changes a
preference, which a Read-only device keeps to itself. A command that only runs
in the client declares it too; core cannot tell by itself. `access: "write"`
says the opposite out loud and is what a missing `access` means. Every command
of core and the shipped kits declares one or the other, and
`kits/kit-lifecycle.test.tsx` fails for one that does not.

`registerPanel` takes `Icon`, a component of your own (`{ size?: number }`) —
`lucide-react` is a shared module, so a package draws its glyph from the set
the workbench itself uses, and core no longer keeps a table of names it would
have to know a kit by. A panel without one gets core's fallback glyph.
`registerSettingsPage` takes the same `Icon`.

#### Where a panel shows: a stage tab or the drawer (new in API 1.11.0, the rule since API 1.27.0)

There is no dock and no panel rail (API 1.27.0, the workbench design). Every
panel opens as a tab of the stage, the column right of the conversation, and
comes to the front; opening it again brings its tab forward, never a second
one. A panel that asks for `placement: "drawer"` draws below the conversation
and the stage instead, full width; one drawer panel shows at a time. The
drawer starts at 280 px, is dragged or moved with the arrow keys from its top
edge, and its height (180 px up to three quarters of the window) is kept per
client. Terminal Kit's "Show the terminal in" setting registers its panel again
with the other placement. `width` is ignored since 1.27.0.

Where a panel is reached from: the right end of the stage's tab strip holds a
button for each panel with `stageButton: true` (API 1.27.0; Files and Terminal
in Tau), what kits place in the `stage-bar` region (Workspace Kit's "Open in"),
then a separator and the maximize. While the stage is hidden the same tools
sit in the thread header, before its stage toggle (design 1k). Every other
panel is under "More tools", by label and icon, and every panel stays reachable from
`actions.openPanel(id)`, a command in the palette and its keybinding. The
button of a drawer panel opens and closes the drawer. The thread header's stage
toggle opens an empty stage on the tool last picked in the project, else the
first with a button. `useBadge` (API 1.27.0) is a hook for a count beside the
panel's tab title — Agents Kit counts the thread's agents that still run or ask; nothing is drawn for
`undefined` or 0. On the stage the tab names the panel, so the panel's own
`h2` in its `.panel-header` is left out there; keep controls in the header,
as icons, and no kit name.

The conversation starts 380 px wide beside the stage, as the workbench design
draws it, and the stage takes the rest; the divider between them is kept per
client (API 1.16.0). The chat keeps at least 360 px, on a desktop and a tablet
alike, so a window short of 380 px narrows it before it gives up showing both.
Chat and stage are side by side whenever both
are open, except for two choices the user makes: the thread header's toggle
hides the stage (and brings it back as it was), and the maximize gives the
stage the whole centre (the strip's button, `rightPanel.toggleMaximized` on
`mod+alt+shift+b`, or dragging the divider well below the chat's minimum). A
maximized stage has no strip for the chat beside it; the strip's toggle, the
keyboard, or a click on the thread in the sidebar (its own or another) brings
the chat back beside it at the width it had. Only a window too narrow for 360 +
360 px shows one of the two, with "Show chat" in the strip and the header's
toggle to switch. Both the maximize and the hiding belong to the thread, as its
tabs do; a restart keeps them, a switch to the thread shows its chat.

`redirect(actions)` (new in API 1.18.0) lets a panel's entry open a view
of its own instead: its button, `actions.openPanel(id)` and every command
ask it first, and it answers true when it showed something else. Workspace
Kit's Changes entry opens Review Kit's review this way (commit bar, staging,
the branch's pull request and the linked ones above the file list); without a
kit that draws the review, it answers false and the Changes panel opens.

`maximizable: true` lets the user move a drawer panel onto the stage: the
button over the end of the panel's header, or `rightPanel.toggleMaximized`,
which acts on the drawer panel the keyboard is in before the stage. Core moves
the *mounted* panel — its DOM host goes from the drawer to the stage and back
— so React state, scroll and a terminal's buffer go with it, and the panel is
never drawn twice. The tab is a core kind (`StagePanelTab`, `kind: "panel"`,
`panelId`) and is restored with the stage; closing it puts a drawer panel back.

`PanelProps.placement` says where the panel is drawn now (`stage`, `drawer`,
or `sheet` on a phone, API 1.20.0; `dock` no more since 1.27.0); a panel that
positions something outside the page, as Preview Kit's native view does,
reports its bounds again when it changes. `active` is false while the panel's
tab is behind another or the stage is hidden. `actions.openPanel(id)` shows a
panel wherever it is, bringing its tab forward; `actions.closePanel(id)` hides
it (the drawer closes, or the tab); `actions.togglePanelMaximized()` is the
command's action, and `actions.toggleDock()` hides or shows the stage.

#### Tool rows and tool cards

`registerToolRenderer(id, match, render)` says how one tool call reads: its
glyph, title, tone and detail. `ToolPresentation` also takes an optional
`source` — what the tool reaches, a browser, a machine, an MCP server. A group
summary hoists a named source to the front of its sentence ("Used the browser
3 times and read 2 files") instead of counting those calls as anonymous tools;
core reads `mcp__<server>__<tool>` as a source by itself, because that spelling
is the protocol's, not a kit's.
`file` (API 1.27.0) names the file a call read or wrote, as the tool gave it:
the settled row then offers to open it on the stage, or bring its tab forward.
Workspace Kit sets it for `read`, `edit` and `write`. A file chip in a reply
(inline code with a path) and an `@file` mention in a prompt open their file
the same way; a relative and an absolute path inside the project are one tab.
A call no renderer claims shows the value of its most telling argument
(`command`, `file_path`, `path`, `pattern`, `query`, `url`, …), so a runtime
whose tools have names of their own should still register a renderer for its
glyphs and tones. A failed call (`status: "error"`) shows why under its line:
the exit status and the last line printed, or the first line of `output`. A
failed command shows its output open instead, dark as a terminal, with "exit 1 ·
2.3s" at the row's end (design 1f).
`glyph` may be an icon (API 1.39.0). `note` (API 1.39.0) is drawn at the row's
end before its state, `body` open under the row in place of the output:
Workspace Kit draws an edit's "+4 −2" and its diff with them, for Pi's `edit`
and `write` and the Agent SDK's `Edit`, `MultiEdit` and `Write`. Consecutive
settled reads share one row ("Read a.ts, b.ts · 2 files") that opens to each.

`registerToolCard({ id, match, Component })` is the other half: a whole batch
of consecutive calls of your tools drawn as one card, instead of a row per
call. The component is given `{ tools, actions }` — every call of the batch in
order, and the workbench's actions. Core never folds, groups or hides a card,
so a card is what to reach for when the thing a tool started outlives the turn
that started it; Agents Kit's spawn card is the caller that motivated it. A
tool a card claims is not offered to `registerToolRenderer`.

Both see a tool as clients receive it. A settled tool whose output is longer
than 16 KB comes without `output`: `outputDeferred` is true and
`outputLength` says how many characters the host holds back. A card that needs
the text asks for it with `actions.toolOutput(tool)` (API 1.11.0), which answers
the output as the transcript would have carried it. A running tool longer than
16 KB carries only its last 4 KB.

```ts
context.registerToolCard({
  id: "agents.spawn",
  match: (tool) => tool.name === "tau_spawn_thread",
  profiles: ["desktop", "web", "compact"],
  Component: SpawnCard,
});
```

#### Stage tabs

The stage is the document area beside the conversation. Core owns the tab
strip, the placement, the preview and pin rules and its own two kinds (a file
and another thread's transcript); `registerStageTab` adds a kind of your own —
a terminal, a pull request, a file editor, a device panel.

```tsx
plugin.registerStageTab<NoteParams>({
  kind: "example.note",
  profiles: ["desktop", "web"],
  title: (params) => `Note: ${params.name}`,
  Icon: StickyNote,
  render: (params, handle) => <Note params={params} handle={handle} />,
  restore: (params) => Boolean(params.name),
});

plugin.registerCommand({
  id: "example.note.open",
  label: "Open a scratch note",
  group: "Extensions",
  run: (app) => { app.openStageTab("example.note", { name: "scratch" }); },
});
```

`actions.openStageTab(kind, params?, { preview?, key? })` opens one and answers
with the tab's id; `actions.closeStageTab(id)` closes any tab and
`actions.stageTabs()` lists what is on the stage. `actions.splitStage?(id?)` (API 1.38.0) shows a
tab beside the active one; without an id it splits off the active tab or joins the two
panes again (a tab dragged onto the stage does the same). **`params` is plain JSON and
is the whole of what the tab is:** two opens with the same params are the same
tab, the params key the tab (`ext:<kind>:<key>` — pass `key` to name one
yourself, or `singleton: true` for a kind with one tab whatever it is opened
with), and they are what a restored tab comes back with. Put an id in them, not
an object. An extension tab opens pinned, because it is opened by a deliberate
action; pass `preview: true` to take the stage's one preview slot instead.

`render` is given the params, a **handle** — the tab's own — and the
workbench's `actions`, the same object a panel receives in its props, so a
tab's content can open a panel, a file or a URL without its kit keeping a
copy from elsewhere (new in API 1.9.0; Terminal Kit opens a link's Preview
this way). The handle:

| Member | What it does |
|---|---|
| `id` | the tab's id, the one `closeStageTab` takes. |
| `setTitle(title)` | renames the tab; the strip and the context menu follow. |
| `setDirty(dirty)` | a dot in the tab, and core asks the user before closing it. |
| `onClose(listener)` | runs when the tab closes, whoever closed it — the ✕, `mod+w`, "Close others", or your kit going away. Returns an unsubscribe. |

Core hands out one handle per tab and keeps it while the tab lives, so the
content may hold on to it. `restore(params)` is asked once for a tab that came
back from storage rather than from your own `openStageTab`: answer `false` and
core drops the tab. A tab whose kind is not registered yet waits — a kit that
activates late still gets its tabs — and a tab whose kind is *withdrawn* goes
with it, without asking about unsaved work, because nobody is left to save it.

The strip follows the workbench design: 40 px on the side surface, the tab in
front on the document's ground and joined to what it shows, each tab its glyph
and title, a file with uncommitted changes marked "M", a tab with unsaved work
a dot (`setDirty`), a panel its count (`useBadge`). Tabs keep their width and
the strip scrolls; once some are out of view, "All tabs" lists them.
The tab strip's own gestures are core's: double-click pins a preview, the
middle button and Escape close, `mod+w` closes the active tab, `ctrl+tab` and
`ctrl+shift+tab` move through them, and the right-click menu offers close,
close others, close to the right and pin/unpin. `examples/desktop-extensions/hello-stage-tab.tsx`
is the whole of the above as one file; Terminal Kit's "open as tab" is the
shipped caller, and Review Kit's pull-request view (`review.pull-request`,
params `{ url, number, service, workspace? }`) the second.

**Stage tabs belong to a thread.** Each thread and each draft has its own
stage (new in API 1.26.0): switching threads shows the tabs and the active one
that thread was left with, across restarts (a maximize only across a restart:
a switch shows the chat beside the stage), and a new thread
starts with none. Hiding a thread's stage unmounts your tab's content, like
any tab behind another, but does not close it: `onClose` does not run and the
handle stays, so keep what must outlive the view (a shell, a page, unsaved
text) outside the component, as Terminal Kit keeps its shells in the host and
Files Kit its buffers in a registry. `actions.stageTabs()`, `openStageTab` and
`closeStageTab` act on the stage on screen. The same tab id can sit on two
threads' stages; closing it on one runs its `onClose` listeners, and the other
thread's tab gets a fresh handle and `restore` when it is shown again.

Core's file tabs are loaded by the document source a kit registers
(`registerDocumentSource`; Workspace Kit's in Tau). A stage belongs to a
thread or draft of one project, and the project a draft shows need not be the
one the host has open, so core calls `loadFile(path, { workspace })` and `loadDiff(path, options,
{ workspace })` with the stage's project: its workspace id, or its path where
the host mints none (new in API 1.26.0). A source reads that project; without
the argument it reads the project it follows. A file or project that is gone
shows "File not found" with the path and Close; a raw `ENOENT` or "not a known
Tau project" from the source is enough for core to tell.

A kind's `render` gets the same project as a fourth argument,
`render(params, handle, actions, from)` with `from: DocumentOrigin` (new in API
1.26.0), so a tab that reads or writes files does so in the project whose stage
it is on. Handles are per tab id, and two projects' stages may hold a tab of
the same id, so key what you keep by `from.workspace` too. `from.workspace` is
absent when the window has no project on screen; Files Kit then opens nothing
and saves nothing.

#### Context in the composer

`registerComposerInline` lets a package put typed context into the composer's
input frame — chips for a file, an excerpt, a pull request — without core
knowing what a chip is. Core owns the frame, the text field and the send; the
contribution owns what it holds, per **draft**:

```tsx
plugin.registerComposerInline({
  id: "example.chips",
  profiles: ["desktop", "web"],
  Component: ({ scope, draftState }) => <Chips scope={scope} persist={draftState} />,
  triggers: [{ char: "#", label: "Issues", search: (query) => issues(query), select: (item, _query, { scope }) => add(scope, item) }],
  pasteText: (text, { scope }) => text.length > 32_768 && foldPaste(scope, text),
  takeFiles: (files, { scope }) => files.filter((file) => !take(scope, file)),
  hasContent: (scope) => has(scope),
  subscribe: (listener) => onChange(listener),
  prepareSend: ({ scope, fileAttachments }) => ({ context: serialize(scope), attachments: files(scope, fileAttachments) }),
  settleSend: (scope, accepted) => accepted ? clear(scope) : restore(scope),
});
```

| Member | What core does with it |
|---|---|
| `Component` | Drawn inside the input frame, above the text. It gets the `ComposerInlineContext` — `scope`, `snapshot`, `fileAttachments`, `imageInput` — and `draftState`, the extension's own slot beside the draft's text in the draft store (`read()`, `write(json)`, `write(undefined)` to drop it), so a reload brings the chips back with the text. |
| `triggers` | A character that opens core's autocomplete menu at the start of a word. `search` answers rows (`{ id, label, description?, hint? }`), `select` gets the chosen row once core has removed the typed trigger. `/` and `$` are core's; an extension's `@` replaces core's own file list. |
| `pasteText` | Asked for every text paste; `true` keeps the text out of the field. |
| `takeFiles` | Offered every file of a drop, a paste or "Attach files" in the composer's "…" menu before core; answers with the files it left, which core treats as images. While any contribution takes files, "Attach files" accepts any type and the thread-wide drop overlay lets any file through — the contribution checks its own limits. |
| `hasContent`, `subscribe` | Whether the draft has something worth sending with no text at all; Send enables on it. |
| `prepareSend` | Runs once per prompt, after `beginSubmission` captured the draft. `context` is put before the user's text (after it when a skill is selected, which reads its instruction first); `attachments` join the images. A throw refuses the send and keeps the draft. A `/command` never asks. |
| `settleSend` | The prompt `prepareSend` contributed to was accepted (clear what went) or refused (put it back). |
| `chips` (new in API 1.12.0) | `{ list(scope), remove(scope, id) }`: chips drawn inside the text rather than by `Component`. See "Chips in the text" below. |
| `keyDown` | A key in the text field, asked before core's own handling while no trigger menu is open. It gets the key, its modifiers and the field's text and selection as plain data, plus `setText(text)`, which replaces the draft's text with the caret at the end; answering `true` claims the key and core does nothing else with it. Prompt Tools recalls earlier prompts this way. |

`scope` is the draft key core persists the text under; a new thread's draft
gets a new one once the thread exists, so a contribution keeps its state by
scope and lets go of it on `settleSend(scope, true)`.

**Chips in the text.** A contribution with `chips` keeps its chips and their
payloads as before; core places them. `list(scope)` answers
`ComposerInlineChip`s — `{ id, label, icon?, title?, state?, Detail? }`, where
`icon` is a component drawn in the chip's icon slot (a lucide icon),
`state` is `"busy"` while it is still being prepared and `"failed"` when it
cannot be sent, and `Detail` is drawn in the popover a click on the chip opens
(props `{ scope, chipId, close }`). `subscribe` announces changes. Core then:

- puts a token for each new chip into the draft's text, at the caret while the
  field has the keyboard and at the end otherwise. The token is
  `U+2063`, two `U+2007`, the label with no-break spaces, `U+2063`: the
  textarea lays it out as plain characters, without a line break inside it,
  and a mirror behind the (then transparent) text draws the same characters as
  a chip, so both wrap alike. `composerDraft()` answers the text with its
  tokens; a label stays on one line, at most 48 characters, and unique within
  the draft (`a.ts`, `a.ts 2`);
- takes the token out when the chip leaves `list` (the kit removed it), and a
  token that comes back with the text (a stash, a reload) takes its chip back;
- lets the user delete a chip like a character: Backspace or Delete takes the
  whole token, the caret steps over it, and the popover has Remove, which calls
  `remove`. A chip whose token the user deleted stays in `list` until the
  prompt is sent, so an undo brings it back; the send calls `remove` for it;
- sends a token as its label, so the prompt reads where each chip sat, and
  hands `prepareSend` the same text; `hasContent` is not asked, since a chip is
  text.

Core draws the images a prompt carries the same way, with a thumbnail in the
slot and the image large from the popover. `Component` still renders, so a
contribution with chips uses it for what is not a chip — an error, its state's
hydration.

**File attachments.** A prompt attachment is an image
(`{ kind: "image", name, mimeType, data, size }`, the bytes) or a file
(`{ kind: "file", name, mimeType, path, size }`, an absolute path on the host,
at most 50 MB). Only a runtime whose adapter declares
`capabilities.fileAttachments` takes a file — Antigravity does, as ACP
`resource_link` blocks — and the host refuses one for any other runtime.
`ComposerInlineContext.fileAttachments` says which case the composer is in, so a
contribution embeds the file as text instead when it is false. A
`ThreadRuntimeBackend` receives both kinds in `attachments` and takes the ones
its runtime understands.

#### The chip service: `tau.composer-context/chips`

Composer Context (`kits/composer-context/`) is the one inline contribution Tau
ships, and it lends its chips to every other package: a terminal hands over an
excerpt, a review comment or a pull request view hands over its PR, without
knowing the composer. Copy the types from `kits/composer-context/protocol.ts`
(a kit never imports another kit) and use the service:

```ts
context.useService<ComposerContextChips>("tau.composer-context/chips", (chips) => {
  const id = chips.addChip({ kind: "text-excerpt", payload: { source: "Terminal", text: selection } });
  return () => chips.removeChip(id);
});
```

| Member | Contract |
|---|---|
| `addChip({ kind, label?, payload, render? })` | Puts a chip into the draft of the composer on screen and answers with its id; throws when no composer is open. `label` defaults to one the payload implies; `render(chip)` may answer a React node to draw instead of the label (it is not persisted). |
| `removeChip(id)` | Takes it out again, from whichever draft holds it. |
| `chips()` | The chips of the draft on screen, in the order they were added. |
| `subscribe(listener)` | Called on any change to any draft's chips. |

The four kinds and what each becomes when the prompt is sent, always in this
order and before the user's text:

| `kind` | `payload` | Sent as |
|---|---|---|
| `file` | `{ path, startLine?, endLine? }`, workspace-relative, lines 1-based | `<file path="…" lines="a-b">…</file>`, read at send time, 200 KB at most |
| `text-excerpt` | `{ source, text, comment? }` | `From <source>:` and the text as a `>` quote, then `My comment on this excerpt: <comment>` when the user wrote one in the chip's popover |
| `pull-request` | `{ number, title, url, branch? }` | `Pull request [#n](url): title` |
| `attachment` | `{ name, mimeType, size, path? }`, `path` on the host | a `kind: "file"` attachment for a runtime that opens files; otherwise the text inline (200 KB at most) or, for anything else, a sentence naming the path |

Composer Context fills `chips`, so its chips sit in the text; a click on an
excerpt opens it in full with a field for the user's comment on it. A draft's
chips persist with its text (the `draftState` slot above) and go when
the prompt was accepted; a refused prompt puts them back. An attachment whose
upload the connection lost after its three retries is uploaded again, from the
start, once the host is back (`host-connection` below). The kit's own limits:
eight attachments a message, 10 MB an image (an image goes to
core as an image whenever the model sees images), 50 MB any other file, and a
paste from 32 KiB on becomes `pasted-text-<n>.txt` with a chip — removing the
chip is the undo. A file travels to the host in 4 MiB pieces, so a 50 MB one
stays under the host socket's 64 MiB frame.

#### A thread's branch and pull requests: `tau.workspace/branch` and `tau.review/pull-requests`

(New with K112, after API 1.29.0.) Two services other packages may read, each
provided by the kit that knows the answer; their ids and types come from `tau`,
so a package of your own needs no kit's protocol file. While the kit is off,
`useService` simply never calls back.

```ts
import { THREAD_BRANCH_SERVICE, type ThreadBranchService } from "tau";

context.useService<ThreadBranchService>(THREAD_BRANCH_SERVICE, (service) => {
  const show = () => console.log(service.current()?.branch);
  show();
  return service.subscribe(show);
});
```

| Service | Provided by | Members |
|---|---|---|
| `THREAD_BRANCH_SERVICE` (`tau.workspace/branch`) | Workspace Kit | `current()`: `{ cwd, isRepo, branch?, upstream? }` for the thread or draft on screen — a worktree thread's own folder and branch — or undefined with no project; the same object until it changes, so `useSyncExternalStore(service.subscribe, service.current)` works. `branch` is absent on a detached HEAD. `subscribe(listener)`. |
| `THREAD_PULL_REQUESTS_SERVICE` (`tau.review/pull-requests`) | Review Kit | `forThread(sessionId)`: the requests linked to the thread, `{ url, number, host, repo, title?, state?, draft?, headRef?, baseRef? }`, as the window last read them; asking reads them when it has not. The same array until they change. `subscribe(listener)`. |

Both answer what the window last read. The branch follows a `git checkout`
outside Tau within a moment: Workspace Kit's host half watches the `HEAD` of
each checkout a window shows (no polling) and reads the branch again, and again
after each turn of the thread on screen.

#### Actions on a message

`registerMessageAction` puts a button on the action bar of a transcript message,
beside Copy and Fork:

```tsx
plugin.registerMessageAction({
  id: "example.cite",
  label: "Cite",
  Icon: Quote,
  roles: ["assistant"],
  profiles: ["desktop"],
  run: (message, { selection }, actions) => actions.setComposerDraft?.(`> ${selection ?? message.text}`),
});
```

`roles` says which messages carry it (assistant replies when absent). `run`
gets the `UiMessage`, `selection` — the text the user had selected inside that
message when the button was pressed, if any; core keeps the selection alive
through the click — and the workbench's actions. A throw is shown as a notice.
Prompt Tools' "Cite" is the shipped caller.

#### Blocks in a reply (new in API 1.11.0)

`registerMessageBlock({ id, tag, Component, profiles })` draws a
`<tag>` … `</tag>` block of an assistant reply itself; the rest of the reply
stays Markdown. The tags count only on lines of their own and outside code
fences. `Component` gets `body` (what stands between the tags), `complete`
(false while the closing tag is still streaming in), the `message` and
`streaming`; `useWorkbenchShell()` has the actions. The text itself is not
changed, so the block survives a restart wherever the runtime keeps text.
Plan Kit draws `proposed_plan` as a plan card this way.

`roles` says whose messages the block is drawn in: assistant replies when it
is absent, `["user"]` for context a prompt carries. A user message draws its
blocks above the bubble and keeps them out of the text the bubble shows, so a
long piece of handed-over context reads as one folded card instead of a wall
of text. Handoff Kit draws `handoff_context` and `merge_back_context` this way.

#### The thread's interaction mode (new in API 1.11.0)

A thread's turns run in a mode: `default`, or one its runtime adds — `plan`
explores and proposes a plan without changing anything. The mode belongs to
the thread like its thinking level and applies from the next turn on.
`snapshot.mode` is the thread's (absent means `default`) and `snapshot.modes`
the modes besides `default` it offers; for a draft both describe the thread it
will become. `actions.setMode(mode)` sets it for the thread on screen or the
draft's thread, and resolves false when the host refused; `actions.activeThread()`
carries `mode` and `modes` too. `actions.submitPrompt(text)` sends text as the
user's next message through the composer's own path (queued while a turn runs)
and leaves the draft alone; `actions.steerQueuedMessage()` sends the oldest
queued message now.

On the host, a backend offers modes through the capability group `mode`
(`modes()`, `current()`, `set(mode)`, refusing a mode it does not offer) and
declares them statically as `adapter.capabilities.modes`, which is what a
draft's picker reads from `runtimeBackends`. A Pi thread offers the modes its
runtime extensions declare with `registerRuntimeExtension(name, factory, {
modes: ["plan"] })`; it records the mode as a `tau.mode` custom entry in its
session (`THREAD_MODE_ENTRY`), and the extension reads it on every turn with
`threadModeFromEntries(ctx.sessionManager.getBranch())` from
`tau/host-extension`. What a mode means is the runtime's: Plan Kit adds plan
instructions to Pi's system prompt and refuses `edit` and `write`, Codex runs
the turn in its own `plan` collaboration mode, the Agent SDK runtime in its
`plan` permission mode. Each of them delivers the finished plan as a reply
holding a `proposed_plan` block.

#### Policy around the model: gates, badges, the thread title

Three seams let a package hold an opinion about models without core having
one. Subscription Login Warning (`kits/subscription-login/`) uses all three;
switching it off removes every trace of its warning.

`registerComposerGate({ id, order?, check, Component })` asks the user before
the composer acts. `check(context)` is called when a model is picked in the
model picker or added to a new thread's model set with Shift-click
(`action: "model"`), and when a prompt is about to go to the thread's model,
the ⌘↵ alternate send included (`action: "prompt"`); `context` carries the `model`, the
`runtime` the thread runs on (or a new thread will start on) and the
`snapshot`. `model` is absent when a new thread will start on another
runtime's default. `newThread` (new in API 1.14.0) is true in a new
thread's draft: its `snapshot` names the draft's project, model and runtime
but still carries the messages of the thread it was opened from, so a gate
for a thread's first prompt asks `newThread`, not `snapshot.messages`. Answer `true` and core draws `Component` over a backdrop,
with `proceed()` and `cancel()`; a click outside or Escape cancels. Gates run
in `order`, and a proceeded gate hands on to the next one that asks. A
cancelled model choice reopens the picker; a cancelled prompt stays in the
composer. A `/command`, a `!` shell command and an answer to a question are not
prompts and pass no gate. Keep `check` cheap and free of side effects: it runs
on every choice and every send, and whatever the user decides belongs in the
dialog.

```tsx
plugin.registerComposerGate({
  id: "example.expensive",
  profiles: ["desktop", "web", "compact"],
  check: ({ model }) => model?.id === "big-and-expensive" && !confirmed(),
  Component: ({ proceed, cancel }) => (
    <section role="dialog" aria-label="Expensive model">
      <p>This model costs ten times as much.</p>
      <button onClick={cancel}>Pick another model</button>
      <button onClick={() => { confirm(); proceed(); }}>Use it</button>
    </section>
  ),
});
```

`registerModelBadge({ id, applies, label, title?, tone?, note? })` marks
models in the picker. `applies(model, runtime)` runs for every listed row, and
a model it answers `true` for wears `label` after its name (`tone: "warning"`
draws it in the caution colours, `title` is its hover text). `note` is one line
under the list, shown while any listed model wears the badge. A badge may also
bring `WayLine` (API 1.46.0), a component the picker draws after the facts under "Runs with"
for the way highlighted there, whether or not the model wears the badge (a badge
with `applies: () => false` is only that line): Usage Kit adds what the plan
behind the way has left. It gets `{ model, runtime }`, draws nothing when it has
nothing to say, and must not throw.

`registerComposerSpeed({ id, order?, read, subscribe, set })` (API 1.41.0) gives a runtime's faster
tier to the composer's thinking chip (K142): core draws ⚡ in the chip while it is
on and a Speed section (Standard / Fast) in the chip's menu and the phone's
Thinking sheet. `read(snapshot)` answers `{ fast, available, reason?, detail? }`
for the thread, or `undefined` for a thread of another runtime; it answers from
what the kit holds, returns the same object until something changes, and calls
the `subscribe` listener once it knows more. `set(fast, snapshot)` switches it.
Where no kit answers, the menu shows Fast greyed with "<runtime> offers no Fast
tier". Service Tier Kit (Pi) and Codex Kit use it; neither puts Fast in the "…"
menu any more.

`registerRegion({ placement: "thread-title", … })` draws before the thread's
title in the conversation header — a mark about the thread on screen, which
reads the `snapshot` it is given. `title-bar` is the thread header's end,
before the stage toggle (API 1.27.0: the window-wide title bar is gone): Workspace
Kit's project actions, "N files changed ›" and the Git action sit there (not for
a new thread's draft, which has nothing to run or commit). It stays mounted
while a maximized stage hides the conversation, only out of sight, so a
kit may keep a dialog layer there; on a phone it is the end of the phone's bar.
`thread-details` and `thread-branch` (API 1.27.0) are the thread header's
sub-line: `thread-details` adds items before the branch, and
`thread-branch` draws the branch itself; while any kit registers for it,
core's plain branch label steps aside. Both are drawn bare in the sub-line,
so draw each item as a `span.thread-detail` (core puts the "·" between
them) and render nothing when there is nothing to say. Workspace Kit's
branch there opens a menu over the thread's checkout (switch or create a
branch, open, add or remove a worktree). For a new thread's draft it says
"project · machine · no worktree yet" (design 1k, K152; the checkout's branch in
place of the last part when the draft runs in the checkout); a phone's bar
draws `thread-branch` for the draft too, "project · machine" (design 1o). A
thread that exists but is still empty shows only `thread-details` and its
branch there.
`draft-actions` (K98, for API 1.28.0) is the row of pills after a new
thread's "What should <project> do next?" and its sentence: core's project
pill leads it (a click opens the project picker at the pill and moves the
draft; a second click on the pill closes it), then the kits' pills, each a `button.draft-pill` that opens its own
popover, or a sheet on a phone or tablet. Machine and branch are no longer
pills here since K152: they are one `lead` composer control (see below).
Render nothing for a thread that started; an older core draws no such row.
`stage-bar` (API 1.27.0) is the right end of the stage's tab strip, after the
tools and before the maximize, for a control about the stage as a whole, such as
Workspace Kit's "Open in". The other placements are
`composer-above`, `composer-controls`, `composer-below`, `transcript-header` and
`transcript-footer`. `composer-controls` is one centred row on the
transcript's bottom edge, before `transcript-footer` and everything over the
composer, for a small control or two. In a thread, that row, `transcript-footer`,
`composer-above` and the composer lie over the transcript's lower end, which keeps
their height free (while the composer is folded, the height it has unfolded), so
the last message is never under them and folding the composer moves nothing; where
a kit's region draws no background, lines scrolled back show through it. What a
kit draws in `composer-controls` gives the row its height, so it never covers the
latest message; it is left out on the start screen.
Core leads the row with the running task list's pill (done of all, "1/3";
hovering or clicking opens the list above it) and ends it with Jump to latest,
which floats while the reader is away from the latest message and never changes
the row's height: beside the pills when there are any (they stay centred), else
centred over the transcript's bottom edge. Draw what goes there as core's
`.control-pill` (a `button`; add `icon-only` for a lone icon): one height
(`--control-pill-height`, 32 px on a desktop, 36 px in `compact` with a 44 px
tap area), edge, fill, 14 px icon (`--control-pill-icon`), tabular figures and
hover, open (`aria-expanded`) and focus states for all of them. A pill whose
detail opens on hover heads that detail with what the pill counts, as the tasks
and the turn's changes do; a lone icon gets a tooltip. Render nothing when
there is nothing to say: a row with no pill has no height. Workspace Kit's turn
pill and, in `compact`, Review Kit's live there; banners and bars stay in
`composer-above`. An older core never draws it. New in API 1.15.0, `look-in` draws under the header of a
tab that shows a thread of another machine (`openThread(id, { machine })`); its
props carry `lookIn: { machine, machineName, sessionId, connected }`, and what
it shows comes from that machine through `context.environments.readExtension`.
Preview Kit puts that machine's page there, small and view only. An older core
never draws the placement. `turn-divider` (API 1.39.0) sits in the line above
each turn after the first ("Turn 3 · Regression tests", design 2d); its props
carry `turn: { number, messages, last }` — the turn's prompt and everything that
answered it, `last` while it may still run. Workspace Kit puts Fork here (a
question first, then `actions.forkFrom(message, { workspace })` through the turn's last saved
message, in a worktree on a branch of the fork's own) and Restore files (the turn's checkpoint, when it verified) there,
shown on hover and, on touch, on a tap.
`thread-list-head` (API 1.30.0) tops a phone's or a tablet's thread list,
under its header and over the rows, and stays put while they scroll: a strip
about the list as a whole. Machines Kit says there which paired machine is out
of reach (Retry) or refused the device (Pair again), and Usage Kit draws the
plans' juicebars; register it with `profiles: ["compact"]` and render nothing
when there is nothing to say. An older core never draws the placement.
`spine` (API 1.39.0) fills the narrow column the conversation collapses to beside the stage
(design 1b), under the thread's title and above its queue and "Open
conversation": Agents Kit draws the thread's state and cost, what runs now, the
turn's steps and its agents there. An older core never draws the placement.

#### Threads of elsewhere in the compact list

`registerThreadListSource({ id, subscribe, threads, here? })` (API 1.30.0)
lists threads that are not this host's among a phone's or tablet's own:
another machine's. Each entry (`ThreadListEntry`) has a `key` that is never a
thread id of this host, the thread's `session` as its own host lists it,
`running`, `waiting` while it waits for an answer there (API 1.35.0), `opening` while `open` is under way, `settled` for the settled
shelf, the `machine` it runs on (`{ name, icon }`, drawn after the project
on the row's project line) and `unavailable`, the reason it cannot be reached
now, which greys the row. The rows stand among the host's by the list's own
order (state, then time); a project filter keeps those whose project has the
filtered one's name. A tap runs `open(actions)`; such a row has no swipe
tray and no action sheet. `threads()` keeps its entries until `subscribe`'s
listener runs. `here()`, when it answers, names the machine this host's own
rows run on, drawn on them while any entry shows. Machines Kit is the shipped
caller, with the same threads it gives Workspace Kit's rail. Call it with `?.`:
an older core has no such method.

#### Rows in the command palette

`registerCommand` puts a fixed row in the palette. `registerPaletteSource` is
for rows that depend on what the user typed — threads, projects, anything a
query finds:

```ts
plugin.registerPaletteSource({
  id: "example.issues",
  label: "Issues",
  order: 20,
  search: async (query, { actions, index, signal }) => {
    const issues = await findIssues(query, { signal });
    return issues.map((issue) => ({ id: issue.id, label: issue.title, detail: `#${issue.number}`, run: () => actions.openExternal(issue.url) }));
  },
});
```

The palette asks every source again on each keystroke, and only for a
non-empty query — unless the source has a `scope` (`"threads"` or `"files"`, API 1.38.0):
then it is also asked for an empty query, in All and in its own tab, and
`context.scope` says which of the two it is (`"all"`, `"threads"`, `"files"`).
The tabs (All, Threads, Files, > Commands) and the prefixes `#`, `/` and `>`
narrow the palette; a source whose `scope` is the chosen one is the only kind
asked. `search` may answer at once or with a promise; `index` is the thread
index this window holds (`projects`, `threads`, `activeThreadId`, and `running`,
the threads with a turn going), and `signal` aborts as soon as the query changes
or the palette closes. An answer that arrives after that is dropped, so a slow
source never paints rows for a query the user already left; a source that talks
to its host half should wait a moment on the signal before it asks. A row is
`{ id, label, detail?, icon?, run, stage? }`: `detail` is shown after the label,
`icon` before it, and `stage` is what ⌘⏎ does instead of `run` (open it in the
stage). A row takes `access` like a command (new in API 1.13.0): on a Read-only
device a row without `"read"` is shown disabled, with "Read only" and the reason
in its tooltip, which a tap shows on a touch screen; the cursor passes over it. A
group of commands of which none declares `"read"` is left out there, as is a
source none of whose rows does, so the list holds no section of dead rows.

What the list shows, in sections under a heading (design 2b): each source
`label`'s rows in `order` (eight at most per source in All; sources with the
same label share one section), then Commands — the commands whose label
matches, core's own Settings rows (a page or a row of one found by the words
Settings search uses, "Settings › page"), and last the commands that matched
only by their group. An empty query lists the recent threads and then every
command. Search Kit (`kits/search/`) is the shipped caller: threads by title and
by what was said in them, the files of the thread on screen, and projects;
Workspace Kit adds other machines' threads.

#### Levels under a row (new in API 1.12.0)

A command or a row may open a level of the palette instead of running: give
it a `submenu`, a `PaletteMenu` with a `title`, an optional `placeholder` and
`empty` line, and `items(query, context)`:

```ts
plugin.registerCommand({
  id: "example.pick-issue",
  label: "Link issue…",
  group: "Project",
  submenu: {
    title: "Link issue",
    placeholder: "Search open issues…",
    items: async (query, { actions, signal }) => (await openIssues({ signal })).map((issue) => ({
      id: issue.id,
      label: issue.title,
      detail: `#${issue.number}`,
      keywords: [String(issue.number)],
      run: () => linkIssue(issue),
    })),
  },
  // What a chord or another surface does; here, the palette on the level.
  run: (actions) => actions.openCommandPalette({ menu: "example.pick-issue" }),
});
```

The level has its own search field: the palette asks `items` when the level
opens and again per keystroke, with the context and the signal rules of a
source, and hands it the query as typed, case and all (a path or a URL). It
keeps the rows whose label, `detail` or `keywords` hold every word of the
query, the label's matches first; `searches: true` says the answer already is
the search and is shown as it comes. A row with its own `submenu` opens the
next level — a folder in a folder browser, say — so levels nest as deep as
the data does. The breadcrumb above the field names them and goes back to any;
the back button and Backspace in an empty field go back one, and the level
below gets its query back. A row may carry an `icon` (a node; name it with
`aria-label` when it means something, as a runtime drawn only as its logo) and
`current: true`, which the row shows as "Current", and `access` as on a source's
row; a level under a command that writes does not open on a Read-only device.
An `items` that throws
shows its message in place of the rows. `run` on a row is optional when it has
a `submenu`; on a command it stays what a chord or a `surfaces` entry does,
and `actions.openCommandPalette({ menu: id })` opens the palette on the
command's level. Core's levels are Set model… (every runtime's models,
through `actions.runtimeModels()`), Change theme… and New thread on…
(`actions.startThreadOn(runtime, model?)`); Workspace Kit's Add project…
browses the host's folders level by level and opens the clone form with
`actions.openProjectSources("workspace.git-clone")`; Review Kit's Link pull
request… lists the project's open requests.

#### Which clients draw it

Every contribution the workbench draws — panels, settings pages, stage tabs,
regions, status items, overlays, composer controls, composer inlines, composer
gates, model badges, the sidebar, project sources, prompt renderers, the
document source, transcript rows, tool renderers, tool cards and message
actions — takes an optional `profiles`:

```ts
context.registerPanel({ id: "agents", label: "Agents", profiles: ["desktop", "web", "compact"], Component: AgentsPanel });
context.registerToolRenderer("git.rows", match, render, { profiles: ["desktop", "web", "compact"] });
```

`"desktop"` is the Electron window, `"web"` a browser at the same host,
`"compact"` a phone or tablet: a browser that starts narrower than 720 px or on
a touch screen, and the native app around the web client. There the thread list
is a screen of its own and diffs do not split. On a phone a panel that claims
`compact` is not a stage tab: its glyph sits in the phone's bar over the chat and opens the panel as
a sheet over the thread, with `placement` reading `sheet` (API 1.20.0; `stage`
before). A phone draws no stage, so `openFile` and `openStageTab` show nothing
there: a panel that opens documents shows them itself in the sheet, as Workspace
Kit's Files panel reads a file with `FileSource`. The first two such panels keep
their glyphs in the bar (design 1n); from three on, all but the first fold into
the bar's More menu, by label and icon.
`actions.openPanel(id)` and `actions.closePanel(id)` open and close that sheet
there (API 1.13.0), so a panel can close itself after it handed something to the composer.
A tablet (a compact client on a tablet's screen, at least 720 px wide) is laid out
as the desktop: the same panels open as stage tabs beside the chat, from the
strip's tools, and where the tablet has no room for both one of them shows,
with "Show chat" in the strip. Terminal, Review and Preview do this for their compact panels.
That is where a phone's terminal or review goes: claim `compact` on the panel. A panel that draws differently there registers twice under one id, once for `compact` and once for the other profiles: each client registers only its own, and Terminal Kit does this for its key bar; Review Kit registers a panel for `compact` alone, since the desktop reviews in an overlay. The default is `["desktop"]`, so a package that says nothing keeps
working and stays honest: it claims no client it was never tried on.

A client whose profile is not in the list never registers the contribution, so
your component never mounts there — but the extension still activates and **its
host half still runs**. Settings → Inspector lists what this client leaves out
under "Not on this client", with the kind and the profiles you did claim. Claim
a profile only for a contribution you have actually seen work there; a Git
panel over the machine's own files or a native view over the window is
desktop-only, and saying so is the correct answer, not a gap.

Commands, palette sources, keybindings, slash commands, prompt hooks and services carry no
profile: they are not surfaces, and they work wherever the workbench does. See
[ADR 0016](adr/0016-client-profiles.md).

`styles` is not compiled: the loader reads the file, the host publishes it
beside the desktop bundle over `tau-ext://bundles/<id>/<hash>.css`, and the
renderer links it in `document.head` when the extension activates and removes
it when the extension stops — switching a package off in Settings takes its
rules with it. The rules are ordinary global CSS, so prefix them with something
of your own (Tau's own kits use their id: `.preview-*`, `.agent-*`); they land
after the workbench's own stylesheet. Core's own class vocabulary — the panel
frame, the menu, the chips, the prompt frame, the thread row — stays in core
and is documented in [CORE.md](CORE.md): use it, do not restyle it.

Write no colour of your own: name a token, or mix one
(`color-mix(in srgb, var(--acid) 25%, transparent)`). §8 is the table, and a
package that brings a stylesheet and nothing else is a theme.

### When the host half does not run: `useHostAvailability`

(New with K112, after API 1.29.0.) A package's host half may not run while its
desktop half does: it waits for approval, it failed to start (a permission it
lacks: "… lacks permission process"), or it was stopped after failing. A control
that calls it then does nothing, so turn it off with the reason instead:

```tsx
import { hostAvailability, useHostAvailability } from "tau";

function Button({ actions }: RegionProps) {
  const { available, reason } = useHostAvailability("me.my-kit");
  return <button disabled={!available} title={reason} onClick={…}>Go</button>;
}

context.registerCommand({
  id: "me.my-kit.go", label: "Go", group: "My kit",
  unavailable: () => hostAvailability("me.my-kit").reason,
  run: …,
});
```

`hostAvailability(extensionId)` answers `{ available, reason? }` from the
host's list of host halves, which the window reads once and again after every
package change and deactivation; until the host has answered it counts as
available, so nothing flickers off at startup. `useHostAvailability` is the
same for a component and draws again when the answer changes. A command's
`unavailable()` — any reason, not only this one — disables it on every surface
(the palette, the thread's title menu, a file tab, its key chord) with the
reason as the tooltip, the way a Read-only device's refusal does. Calling a
host half that is not active rejects with `Host extension <name> is not
active: <why>`.

### The three modules a package imports from Tau

| Specifier | Resolves to | For |
|---|---|---|
| `tau` | `src/renderer/extension-api.ts` | the desktop half |
| `tau/host-extension` | `src/main/host-extension-api.ts` | an `in-process` host half |
| `tau/host` | `src/main/host-extension-worker-protocol.ts` | a `worker` host half |

Both bundlers resolve them for you, so a package never ships a copy. `tau`
arrives in the renderer through `globalThis.__tauShared`; `tau/host-extension`
is an esbuild alias onto Tau's own compiled module, which is why
`HostCommandError` thrown from a package is the same class the registry checks.

`DesktopExtensionContext` additionally offers `registerSettingsPage` — a page
of Settings with its own nav entry, typed `SettingsPageContribution` (`id`,
`label`, an optional `description` — a sentence or two on what the page
governs, shown under the title in the page's head and found by the search (new
in API 1.26.0) — an optional `Icon` the way panels pass theirs, an optional
`order`, optional `keywords` — the words the Settings search field and the
palette find the page by besides its label — an optional `scope` (below) and a `Component`
receiving `SettingsPageProps`: `cwd`, `onNotify`, and `onOpenSettings(target)`, which opens another place in Settings, new in API 1.19.0). A page that also names a
`runtime` — a backend kind — gets no nav entry: core draws it as that runtime's
card on its Providers page, under the runtime's mark and `label`, in `order`,
and opens Providers for its `id`. The backend kits Tau ships put the CLI, its
version and update, the login and a path override there, one card per
instance (below). Such a card's `runtimeRows` (new in API 1.27.0) name the
rows Settings → Runtimes opens: `program`, where the program is installed and
updated (its Update and Install buttons), and `addInstance`, on the default
instance's card, where another setup is added ("Add a custom runtime").
Without them the buttons open the card. Runtimes is core's: a table of every
backend in `runtimeBackends` with its state, version, the model providers its
catalog names and Make default, Update, Install, Config and Permissions. Its
buttons only open places in Settings and set the client's runtime for new
threads; installing, updating and signing in stay on the kit's card.
`inspectPackages(cwd)`
answers core's own scan of the package folders and the shipped kits
(`ExtensionInspection`) without loading any code — including `distribution`,
the name and version of the set the `bundled` entries came in, absent in safe
mode, which loads none, and `skipped`, the folders the scan passed over, each
with its `reason` and, where Pi's project trust was why, the
`untrustedProject` and the `packages` it holds (K112). Core keeps General, Models, Runtimes, Pi, Keybindings,
Connections, Extensions and the Inspector; every other page is a contribution
and is gone with its extension. The search field at the top of the Settings
column finds core's own rows (and scrolls to the row), a page by its label,
its description and `keywords` and the `rows` it names, an extension's page by its
name and its options, and every live keybinding — which opens the Keybindings
page filtered to its command.

#### App pages: `registerPage`

New in API 1.17.0.

`registerPage` adds a page of the app like Settings — Usage and Reviews
are two — typed `PageContribution`: `id`, `label`, an `Icon` and an `order`
(the sidebar's foot lists every page in that order,
`registry.getPages()`, which a phone's navigation can take as well), optional `description`, `keywords`, `profiles`, a `layout`
and a `Component` receiving `PageProps`. `actions.openPage(id, params?)` opens
it and `actions.closePage()` closes it; both are optional on `WorkbenchActions`,
absent in a client without pages.

On a desktop the page takes the place of the thread and the stage, in
Settings' frame: Settings' page head (new in API 1.27.0) over the page — its
label as the title, its `description`, and at the right the action it draws with
`SettingsPageAction` — under the strip the window is dragged by. The sidebar stays beside it, and its foot is Back to thread alone while
the page shows (API 1.28.0; before, Back led the whole foot). Showing a thread, a file, a stage tab or a panel (`switchSession`,
`newSession`, `openFile`, `openThread`, `openStageTab`, `openPanel`,
`focusComposer`, `openWorkspace`) closes the page first, and so does another
thread coming on screen. Settings opens over a page and returns to it. The
page counts as an overlay (`overlayOpen`, see "Keybindings"): the window's
plain keybindings (Escape stopping a run among them) stay off while it shows,
chords still run, and Escape leaves it once no dialog, menu or popover over it
takes the key. On a phone (`compact` without the split list)
the page is a screen of its own, addressed as `?page=<id>`: a link opens it.
The first three pages that claim `compact` are destinations of the phone's
bottom navigation, beside Threads and Settings, so a page for a phone keeps its
label short. The navigation remembers them, label and drawn icon, so on the next
start they are there before the packages load; one opened then shows "Loading…"
until its package registers it (`ExtensionRegistry.isLoadingExtensions()`). A
package whose page draws a host's answer does well to draw the last one it had
at once and replace it when the fresh one arrives, as Usage does. There the page is a main page without a back button; a view it
steps into hides the navigation, gets Back and a history entry, and the
system's back gesture steps out of it, then out of the page to the thread list.

`layout` is `"readable"` (Settings' reading column, the default), `"wide"`
(1240 px) or `"fill"`: the page gets the whole area below the bar and scrolls
itself, as a stage tab does. `PageProps` carries `actions`, the `params` of the
view on screen, `navigate(params, { label?, replace?, root? })` and `close()`;
`root` (API 1.28.0) leaves every view for the page's own, opened on `params`
(a page's `Sidebar` switching what the page lists while a detail is open), and
an older host ignores it, so pass `replace` with it. A page
steps into a view of itself with `navigate` — a request's detail, a sub-page —
and `label` is the head's title then, with the page and the views below as a
breadcrumb over it (on a phone the title sits in the bar beside Back); Escape
and a crumb step back out, and at the page's own view Escape closes it.
`description` (API 1.27.0) is a sentence or two under the title of the page's
own view; `SettingsPageAction` in an app page draws in its head since API
1.27.0, and in place on an older host.

```tsx
plugin.registerPage({
  id: "acme.reports", label: "Reports", Icon: ChartColumn, order: 30, layout: "wide",
  profiles: ["desktop", "web", "compact"],
  Component: ({ params, navigate }) => params.report
    ? <Report id={String(params.report)} />
    : <ReportList onOpen={(report) => navigate({ report: report.id }, { label: report.title })} />,
});
plugin.registerCommand({ id: "acme.reports.open", label: "Reports", group: "Extensions", access: "read", run: (actions) => actions.openPage?.("acme.reports") });
```

`Sidebar` (API 1.28.0) is an optional component the sidebar draws in place of
the thread list while the page is open on a desktop, in Settings' column: Back
to thread above it and at its foot, the component between, filling the column
and scrolling itself. It receives the page's own `PageProps` (the `params` of the
view on screen, `navigate`, `close`, `actions`), so a click in it can
`navigate` the page — `{ root: true, replace: true }` to switch what it lists,
out of any detail — and it marks what the page shows from `params`. The thread list stays mounted out of sight and comes
back as it was. `PageProps.sidebar` is `true` for the page while its `Sidebar`
is on screen: the page then leaves out the navigation the sidebar carries (Review
Kit drops its tabs). It is `false` on a phone, on a tablet's split layout
(the touch thread list stays), with the sidebar hidden (`mod+b`) and on an
older host, where the page keeps its own navigation. A page without `Sidebar`
keeps the thread list. The component can use Settings' column classes
(`settings-nav-search`, `settings-nav-group`, `settings-nav-heading`) and core's
thread row (`thread-row`, `thread-main`, `thread-project-line`, `thread-title`,
`thread-meta-line`) for rows that read like the rail's.

```tsx
plugin.registerPage({
  id: "acme.reports", label: "Reports", layout: "fill",
  Component: ({ params, sidebar }) => params.report ? <Report id={String(params.report)} /> : <Overview withTabs={!sidebar} />,
  Sidebar: ({ params, navigate }) => (
    <ReportList current={params.report} onOpen={(report) => navigate({ report: report.id }, { replace: true })} />
  ),
});
```

`useBadge` (API 1.26.0) is an optional hook the page's entry calls — the
sidebar's foot and a phone's bottom navigation — for a count drawn on the
page's icon, and read out with its label ("Pull requests, 3"); `undefined` or
0 draws nothing. Review Kit counts the reviews waiting for the user (ready to
merge or in conflict) and the open pull requests of the threads the rail knows. Being a hook, it may subscribe to a store with
`useSyncExternalStore`, and it should stay cheap: it runs with the foot.

The sidebar's foot (API 1.28.0): pages with `prominent: true` lead it, then
the other pages and the commands kits put there, each as its icon with its
`useBadge` count as a badge and its label in the tooltip ("Reviews, 4"); at
its end come what pages sum up, a Tau release waiting for a restart and
Settings. Before API 1.28.0 a prominent page wrote its label and count beside
the icon ("Reviews 4") and Settings came second. `Summary` (API 1.28.0) is an
optional component the foot draws for the page at its end, in place of the
icon and of `useSummary`: Usage's juicebars. It gets `{ actions }`, opens the
page itself (`actions.openPage(id, params)`, Usage at `{ section: "limits" }`)
and draws the page's icon when it has nothing to show. A phone has no foot:
Usage draws the same bars in `thread-list-head` instead. `useSummary()` (API
1.27.0) is an optional hook for a short figure `{ text, short?, hint? }` the
foot shows at its end instead of the icon when there is no `Summary`; `short`
stands in where the foot has no room for `text`, `hint` is the tooltip, and
`undefined` draws the icon. A click on either opens the page.

`useAppUpdate()` from `tau` (API 1.28.0) answers the Tau release the host
downloaded, `{ version, install() }`, or undefined; `install()` restarts into
it. Core offers it in a toast; Workspace Kit's foot keeps an icon for it after
the toast is closed.

`useOpenPage()` from `tau` answers the page on screen (`{ id, views }`) or
undefined, for a sidebar that marks it. A `standalone` Settings page (API
1.15.0) still opens alone, without Settings' navigation; it is deprecated in
favour of `registerPage`.

#### Settings pages: the full page, the levels and the rows

Settings is a page of its own that covers the whole window:
the section column on the left with the search, the pages in groups and About
with the version and Back at its foot, and the page at a readable width under
its head (new in API 1.26.0): the page's title, its `description`, where a
change applies (below) and, at the right, the page's action. Core draws the
head for every page, a kit's too, so a page need not name itself; an older
page's first `h3` is hidden. A nested page — an extension's own — has the
pages above it as a breadcrumb over its title (`Settings / Extensions`). On a
phone the title sits in the bar beside the way back, and the rest of the head
tops the page. Escape, Back and `mod+,` return to the workbench, which stays
mounted underneath (`inert`).

A page puts its action in the head with `SettingsPageAction` from `tau`
(new in API 1.26.0): `<SettingsPageAction><Button …>Install…</Button></SettingsPageAction>`
anywhere in the page draws its children at the right of the head, while the
page keeps the state behind them; outside Settings they draw in place. Keep it
to the one action the page is for; an action on a group of rows belongs in
that `SettingsSection`'s `headerAction`.

**Where a page sits (new in API 1.18.0).** `group` on `registerSettingsPage`
places a page in the section column: `general` (the main pages, always open
under "Settings": General, Appearance, Models, Providers, Runtimes,
Notifications, Keybindings, Connections; keep it short), `threads` (Pi and
what shapes threads), `projects` (what works on a project: source control,
review, terminal, preview), `remote` (Machines, servers, other devices),
`extensions` (the list of extensions, Packages, and the default for a page
that names no group) or `diagnostics` (Inspector, Signals). Every group but
`general` folds under its heading (since API 1.27.0): it opens on a click, or
by itself while it holds the page on screen. Within a group pages follow
`order`; core's own pages take 0 to 90 (General 0, Models 10, Providers 20,
Runtimes 30, Keybindings 80, Connections 90, Pi 20, Extensions 0, Inspector
50). A page that lists `rows: [{ id, label,
keywords? }]` has each row found by the search, which scrolls to the element
with that id — give the `SettingRow` the same `id`.

**A place in Settings.** `actions.openSettings(target)` takes a page id, an
extension's page as `extensions/<extension id>`, or either with `#<row id>`
to scroll to a row: `openSettings("general#setting-show-costs")`,
`openSettings("models#setting-thinking-level")`,
`openSettings("extensions/acme.hello")`. An extension's id alone still opens
its page, and `defaults`, the older name of General, still lands there. On a
phone the same string is the `?settings=` part of the address, and an
extension's page sits under the list of extensions in the history, so the
system's back returns to the list.

**Settings → Extensions** lists every kit Tau ships, every installed package
and every package folder that did not load, in one list with a filter by name
and by source (Bundled, Installed, Turned off, Needs attention). Each row has
the extension's mark (its runtime's for a runtime kit, else the icon of a page
or panel it adds), its `description` and a switch; what needs the user comes
first: a package waiting for approval, one whose host half failed to start,
one whose `engines` rule this Tau out. The row opens the extension's page:
approval with each permission in plain words, a failure with the next step,
the options it declared and links to the pages it adds, what it may do and how
it is isolated, and its version, source, signature and id.

On and off is the host's choice, not a device's: the switch writes
`disabledExtensions` in the host's config, and every client connected to that
host follows it at once. The host pushes `config-changed` after each write,
each client stops or starts its desktop half (`deactivate` and `activate` run
as they do for a switch on that device), and the host starts and stops its own
halves too, including on its next start. The list shows that choice on every
device; a Read-only device shows it with the switches disabled.

A page is built from the same pieces core builds its own with, all on `tau`:

| Export | What it is |
|---|---|
| `SettingsSection({ title, id?, headerAction?, plain?, children })` | A muted heading over one card of rows. `plain` drops the card, for content that draws its own (a table). |
| `SettingsPageAction({ children })` | The page's own action, drawn at the right of its head (new in API 1.26.0); an app page's head too (API 1.27.0). |
| `SettingRow({ id?, title, description?, help?, status?, control?, setting?, disabledReason?, children? })` | One setting: what it is on the left, its control on the right. `id` is the anchor a search result scrolls to. `help` (new in API 1.18.0) is the text a description should not carry, behind an info glyph beside the title. `disabledReason` (new in API 1.13.0) turns the control of a row without a `setting` inert, with the reason as its tooltip — `READ_ONLY_REASON` on a Read-only device. |
| `useSetting(key, options)` | One key of Tau's config read across the levels, as a `SettingHandle`. |
| `userThemes()` | The user themes (`UserTheme`) the last preferences sync registered — the files in the themes folders. Read-only; the preferences store emits when they change. |

#### The controls (new in API 1.18.0)

The controls every Settings page is built from, core's and the kits' alike,
also on `tau`. Each takes a `label`, its accessible name. One height per tier:
30 px on a desktop, 44 px where the pointer is a finger (a phone, a tablet,
Settings stacked), with a hit area of at least 44 px for the small ones. They
draw in light and dark from the tokens, and a disabled one says why through
its row's `disabledReason`. Buttons, fields, selects and `.segmented` rows a
page still draws itself take the same height and look inside Settings.

| Export | What it is |
|---|---|
| `Switch({ label, checked, disabled?, role?, onChange })` | On or off, for a change that applies at once. `role: "checkbox"` for one option of several. On a narrow page it stays beside its row's text. |
| `SegmentedControl({ label, value, options, disabled?, onChange })` | Two to four short choices, one chosen: a radio group, one tab stop, arrow keys move and choose. An option with an `icon` is drawn as the glyph alone with `label` as its tooltip and name — runtimes and providers are shown this way. With `labelled` the label stays beside the glyph, for one that does not say the choice alone (a colour swatch). More or longer choices belong in a `Select`. |
| `Select({ label, value, options, width?, placeholder?, disabled?, onChange })` | One choice of many, as the system's own menu. `width` is `sm` (112 px), `md` (200), `lg` (280) or `full`; a phone gives it the row's width. |
| `NumberField({ label, value, min?, max?, step?, integer?, unit?, placeholder?, width?, validate?, onCommit, onClear? })` | A number with its unit drawn inside the field, written on blur or Enter and put back on Escape; ↑ and ↓ step it. Out of range, not whole when `integer`, or refused by `validate`: the draft stays with the reason under it and nothing is written. Emptied, `onClear` runs (the level's value goes and the placeholder, the default, shows). |
| `TextField({ label, value, placeholder?, width?, mono?, secret?, rows?, suggestions?, id?, autoFocus?, inputRef?, validate?, disabled?, onCommit })` | A line of text with the same draft rules; `mono` for paths, commands and ids. `rows` above 1 makes it a box of that many lines: Return breaks the line, ⌘Return (Ctrl+Return) or leaving the box writes it. `suggestions` offers values as it is typed in; `secret` draws a password or a key as dots. With `onChange` (and `error`) instead of `onCommit` it is a field of a form — an install source, a name to add: it shows `value`, reports each keystroke, shows the page's `error` under it, and Return submits the form. |
| `Slider({ label, value, min, max, step?, unit?, format?, disabled?, onCommit, onPreview? })` | A value on a scale: drag, or arrow keys, Page Up/Down, Home and End. The value beside the track (`unit` after the number, or `format`) follows the thumb and is the screen reader's text; `onPreview` gets each value on the way for a live preview, `onCommit` the one where the move ends. |
| `ListField({ label, items, placeholder?, empty?, mono?, validate?, onChange })` | Short values to add and remove (hosts, folders, patterns): a row each with a Remove button named after it, an add field that refuses an empty value, a twin and what `validate` refuses, and `empty` while there is none. Each change calls `onChange` with the whole list. |
| `ValueList({ items, label? })` | Facts, label beside value (`{ label, value, mono?, copy? }`); `copy` puts a copy button beside the value. |
| `Badge({ tone?, dot?, children })` | A state in a word or two: `neutral`, `accent`, `success`, `warn` or `danger`, never the colour alone. |
| `HelpTip({ text, label? })` | An info glyph whose tooltip holds `text`; `SettingRow`'s `help` draws one. |
| `Button({ variant?, icon?, busy?, ...button })` | `default`, `primary` (one per page, the accent), `danger` or `ghost`; `busy` keeps it inert while its work runs. |
| `DangerZone({ title?, children })`, `DangerAction({ id?, title, description?, actionLabel, confirmTitle, confirmMessage, confirmText?, disabled?, disabledReason?, busy?, onConfirm })` | The actions that cannot be taken back, apart and last on the page. Each names the object and the consequence and asks through `ConfirmDialog`; `confirmText` makes the user type it (a name) first, for a loss that is hard to repair. `ConfirmDialog` takes the same `confirmText`. |
| `SettingsState({ kind, title?, description?, action?, rows?, onRetry? })` | What a page or a section shows instead of its rows: `loading` (skeleton rows), `empty` (what is missing and the next step in `action`) or `error` (what happened, and Try again with `onRetry`). |

The types `ChoiceOption`, `SelectOption`, `ValueListItem`, `FieldWidth` and
`SettingsNavGroup` come with them. Like `SettingRow`, the controls load with a
chunk of their own.

A setting has three levels: the built-in **default**, the **host** (this
machine's `~/.tau/config.json`) and the **project** (`<project>/.tau/config.json`);
the first level that sets a key wins, top-down from the project. `key` is a
config path: a top-level key (`showCosts`, `theme`) or an entry of a record —
`values.<extension>.<name>`, `options.<extension>.<name>`,
`threads.continueAfterRestart`. A package's own settings are entries of
`values` (strings) or `options` (booleans), the records `context.preferences`
reads and writes too.

```tsx
const density = useSetting<Density>("values.acme.layout.density", {
  defaultValue: "normal",
  scope: "both",                       // "host" (default), "project" or "both"
  read: (raw) => (isDensity(raw) ? raw : undefined),
  format: (value) => LABELS[value],    // how a value reads in the origin popover
});
<SettingRow title="Density" setting={density} control={<Segmented value={density.value} onChange={density.set} />} />
```

The handle carries `value` (for the level being edited), `origin` (`default`,
`host` or `project`), the `chain` of levels, `projectOverride` (what the project
holds while the host is edited), `writable`, and `set`, `reset`, `editProject`
and `editHost`. `set` writes to the level being edited; `reset` removes the key
from it so the level below shows through. `SettingRow` with a `setting` draws a
layers glyph beside the title — faint for the default, muted for the host,
accent for a project override — whose popover shows the chain with the value
that applies checked, offers "Override for <project>" or "Edit override" while
the host is edited and "Reset to inherited value" on an override; a reset arrow
appears while the edited level holds the key, and the control turns inert (with
the reason as its title) where the edited level cannot hold a key of that
`scope`.

Which level is edited is the page's: a page whose `scope` is `"project"` or
`"both"` gets the scope menu in its head, under the description ("Applies to
This machine" or a project from the project list), and a page without one always edits this
machine. Pi's own keys (the startup model, compaction, retry, delivery modes,
tools, shell, trust) are Pi's: they have Pi's global and project files, the Pi
page writes them there, and they take no part in these levels. The host methods
underneath are `get-config-layers` (both files without Pi's keys) and
`clear-config` (remove keys from one level) beside `update-config`.

`context.setProblems(problems)` is how a package says that something it reads
is wrong — a project file that does not parse, an entry it had to skip. Each
`ExtensionProblem` is `{ source, message, level? }` (`level` is `"error"`, the
default, or `"warning"`); Settings → Inspector lists them under PROBLEMS with
the package's name. A call replaces the package's whole list, `[]` clears it,
and the list goes with the package when it deactivates. Project Scripts is the
caller that motivated it: an invalid `.tau/project.json` shows there.

Beyond the contribution types, `tau` exports `useWorkbench`,
`useWorkbenchShell`, `useObservatory` and `useThreadStore` (the workbench
hooks), `HostUnavailableError` (thrown when there is no host to route to, e.g.
the browser preview), `errorMessage` (the one-line `unknown` → `string` every
half needs for `actions.notify`), `formatCost` (a dollar amount the way the
composer writes it, and nothing at all for a model with no pricing, so a row
never reads `$0.00` for a missing price), the `PreferencesStore` type (the store
on `context.preferences`, so a package can pass it around in its own
signatures), the `ThreadLineage` type (what `context.setThreadLineage`
takes), `reserveRegion` / `reservedRegion` with the `ReservedRegion` type — the
placement seam of [ADR 0012](adr/0012-preview-browser.md): a package whose host
half draws a native view over its panel publishes that rectangle with
`reserveRegion`, and the workbench's own floats — menus, popovers — slide out
of it rather than disappear behind it (the toast stack stays in the conversation, beside the stage);
`reserveRegion(undefined)` gives the window back, and nothing is reserved
until a package asks for it — and `Menu` with its `MenuItem` and `MenuSection`
types, the popover list a composer chip drops, with the scrim, the keyboard
and the shift that keeps it clear of a native view (below).

#### Project icons (new in API 1.28.0)

`context.setProjectIcons(icons)` publishes the pictures an extension draws
projects with, keyed by a project's `workspaceId` or, for a host without ids,
its `path`; each value is a `data:image/` URL (anything else is dropped), and
`undefined` withdraws them, as deactivation does. Every project mark core
draws takes them before the host's own picture (`UiProject.icon`: a
`favicon.*`, `t3.json`) and before the initial: the new thread's project pill,
the project picker, the thread rows and draft rows, the phone's and tablet's
thread lists and project filter. When two extensions name the same project,
the one activated first wins. Core never reads an extension's settings for
this; Workspace Kit publishes the icon chosen in Project settings from its own
values. `ProjectIcon` (`project`: `{ path, name, workspaceId?, icon? }`,
optional `icon` as the caller's own fallback, `hue` for what the tint is
hashed from, `className`) is that mark as a component, and `useProjectIcon(project)`
answers the picture alone, so a kit's own lists (Workspace Kit's filter and
thread card, Review Kit's page) draw the same mark. `ThreadRow`'s and
`DraftRow`'s `projectIcon` is such a fallback: a published picture wins over it.

#### Provider pictures (new in API 1.29.0)

`context.setProviderIcons(icons)` does the same for model providers Tau ships
no mark for, keyed by provider id (spelled any way a provider is: `KI_Connect`
and `ki-connect` are one key); `data:image/` URLs only, `undefined` withdraws
them. `ProviderIconStack` draws such a picture in place of the provider's
initial, never in place of a mark Tau ships, and `providerHasMark(id)` says
which is which. Pi Providers publishes them: a provider without a mark gets
its site's icon once it is set up (the host fetches it, see
`kits/pi-providers/site-icon.ts`), or a picture the user chooses on its row.

#### The UI primitives (new in API 1.11.0)

Core draws its menus, tooltips, toasts and dialogs with the pieces below, and
a package that uses them behaves like core without drawing a look-alike. They
are Tau's own, not a component library; the reasons and the numbers are in
[PERFORMANCE.md](PERFORMANCE.md#ui-primitives-in-core).

| Export | What it does |
|---|---|
| `Menu` | `items` or `sections` (`MenuSection`: an optional `heading` and `MenuItem`s). Arrows, Home and End move between the enabled items, typing jumps to an item by its label, Enter or a click picks one, Escape and Tab close it, and focus goes back to whatever had it when it opened — the trigger, usually. Opened from the keyboard it focuses its first item (or the `selected` one), opened by a click it takes focus itself. A `MenuItem` with `submenu: MenuSection[]` opens beside it on ArrowRight, Enter or hover, and ArrowLeft comes back. It flips above its anchor or slides sideways to stay inside the window. With `at: { x, y }` it opens at that point over the whole window instead of inside the trigger's `.menu-anchor`; `label` names it for a screen reader when no heading does. |
| `useContextMenu()` | `(event, sections) => Promise<string \| undefined>` for an `onContextMenu` handler: the OS draws the menu where the client's platform offers one (Electron's `Menu.popup`, through the client-side `context-menu` method), the page draws a `Menu` at the pointer everywhere else — the browser client, a test — and when the OS refuses. It answers the chosen item's id, or `undefined`. Headings become macOS menu headers, `selected` a check mark, a `badge` part of the label; a lucide `icon` becomes a template image in the OS menu and a `hint` that names a shortcut its accelerator label (API 1.36.0; Windows and Linux show no icons yet); descriptions stay in the page's version. Opened from the keyboard (Shift-F10, the menu key) it opens under the element instead of at 0,0. Workspace Kit's rail rows are the shipped caller. |
| `tooltipProps(text, options?)`, `Tooltip` | A tooltip on any element: spread `tooltipProps("Settle thread", { shortcut: "⌘S", side: "bottom" })` on it, or wrap it in `<Tooltip content="…">`. Both only set `data-tooltip` (and `data-tooltip-side`, `-shortcut`, `-when`, `-variant`), which core's one `TooltipLayer` reads from the document, so a list of a thousand rows costs attributes, not components. It opens after the pointer rests for 600 ms, at once while another tooltip was open in the last 400 ms, at once on keyboard focus, and closes on Escape, a press, a scroll that moves its element or leaving. `when: "truncated"` shows it only while the element's own text is cut off (a thread title); `variant: "code"` sets it in the monospace face (a path); `variant: "lines"` keeps the text's line breaks, for a few lines of details (a rail row's hover card). A trigger whose `aria-label` differs from the text gets `aria-describedby` while it shows. Use it instead of `title=`, whose OS tooltip waits a second and cannot show a shortcut. The compact profile leaves the shortcut out, as it does any element of class `keyboard-hint`: put that class on a chord or key help a package draws itself (`esc`, `↑↓ navigate`). |
| `actions.toast(options)` | A toast on the window's stack, bottom right beside the composer, and a handle with `update(patch)` and `dismiss()`. `ToastOptions`: `type` (`info`, `success`, `warning`, `error`, `loading`, `question` (API 1.37.0) for something that waits for the user's answer; the icon, and an `error` is an ARIA alert), `title` and `description` (one line, joined by a dot), `actions` (`{ label, run, keepOpen? }` buttons; a click runs and closes unless `keepOpen`), `copyText` (a copy button), `timeoutMs` (5,000 by default; 0 keeps it until dismissed; a `loading` toast waits until it is updated to another type), `id` (showing it again replaces the toast and starts its time again) and `onClose`. Three are visible, newest in front, the rest waiting with their clocks stopped; the time runs only while nobody hovers or focuses the stack and the window is visible, and F6 moves focus into it. `actions.notify(message)` is still the one-line way: every notice is a toast. Thread Rail's undo is a toast whose `timeoutMs` is 0 and whose own undo window dismisses it. |
| `MiddleTruncate`, `splitMiddle` | `<MiddleTruncate value={branch} />` cuts in the middle, as Finder does, for values that mean something at both ends — branches, paths, shas: a head that ellipsizes and a tail that stays (a short last path segment, else `tail` characters, 10 by default). No measuring and inline styles only, so it costs what an end cut costs in a long list; both halves are real text, so copy and screen readers get the whole value. Other props go to the outer `span`. `splitMiddle(value, tail?)` answers the cut, or `undefined` when the value is too short to be worth one. The rail's branch line uses it. |
| `PrivateAccountText` | `<PrivateAccountText text={accountLabel} />` preserves surrounding text and replaces each email address with a blurred random placeholder. Clicking or keyboard activation reveals the real address; activating again hides it. Hidden addresses never enter DOM text or attributes. A changed address starts hidden. Available in API 1.40.0. |
| `Dialog` | A modal centred over core's scrim with `label` and `className`: Tab and Shift-Tab stay inside it, Escape and a click on the scrim call `onClose`, the first `autoFocus` field (else the first control) gets focus, and focus goes back when it closes. With `className` `confirm-dialog` it is the workbench's card: a `h2`, the text, and a `footer` (direct or in a `form`) drawn as a bar with plain buttons and `primary`/`danger` ones as pills. |
| `ConfirmDialog` | A yes-or-no question on `Dialog`: `title`, `message`, `confirmLabel` (`destructive` draws it red; `icon` goes before its label, API 1.38.0), `cancelLabel`, and with `dontAskAgain` a box whose state `onConfirm(dontAskAgain)` hears; `onCancel` on Cancel, Escape or the scrim. The action has focus, so Enter answers it. Thread Rail's delete, archive and unpin questions and core's quit question use it (API 1.12.0). |
| `Popover` | A card beside an element (`anchor`, a ref) or a point, `side` and `align` preferred and flipped or shifted to stay in the window; a press outside it or Escape closes it, and focus goes back. |
| `Sheet` | A modal sheet from the bottom edge for a compact client (phone, tablet), where a desktop would use a `Dialog` or a `Popover`: `title`, `className`, `onClose` and the content as children. It has a grip, the title and a 44 px close button on top; the content scrolls under them. The X, Escape, the scrim and a pull down close it; the pull starts anywhere but on a control, and inside the content only once it is scrolled to the top. Review Kit's filters for the Pull Requests page on a phone use it. |
| `FileSource` | A text file as a file tab shows it (API 1.20.0): `content` (a `UiFileContent` of kind `text`, as a document source's `loadFile` answers), line numbers, highlighting while the file is under 200 KB and its language known, the note for a truncated file, and `line` marked and scrolled to (`reveal` counts requests for the same line). The Files panel reads a file with it in a phone's sheet. |
| `useFocusReturn(active, ref?, fallback?)`, `useFocusTrap(ref, active?)` | The two halves of the above for a surface of your own: give focus back to what had it when `active` turned on (`fallback` when that element is gone), and keep Tab inside. The palette, the model picker and the project picker use them. |
| `useEscapeLayer(onClose, active?)` | Escape for a floating surface of your own: while `active` it closes on Escape when it is the topmost overlay, before anything under it (Stop, a panel) hears the key, as `Dialog`, `Popover` and `Menu` do. New in API 1.17.0. |
| `Spinner`, `Skeleton`, `Empty` | `Spinner` with `size` `xs` (the 10 px ring of a status line), `sm`, `md`, `lg` and `tone` `working`, `accent` or `current`; `Skeleton` with `shape` `block`, `card` or `pill`, sized by its `className` or `style`; `Empty` with `size` `compact`, `default` or `hero`, an `icon`, a `title`, a `description` and actions as children. |

`Menu`, `Dialog`, `Popover`, `Sheet`, `ConfirmDialog`, `SettingRow`, `SettingsSection`, the settings controls, `ChangesTree`, `FileSource`, `ExtensionPromptFrame` and `OptionRow` load with chunks of their own: the names and props are the same, and Tau preloads the chunks once the window is idle after start-up. One drawn before that shows nothing until its chunk arrives, a few milliseconds; the hooks (`useSetting`, `usePromptSubmit`, `useContextMenu`, `useFocusTrap`) are always there.

A package that takes over a Pi dialog (`registerPromptRenderer`) gets the
pieces core draws its own four with, so its dialog is not a look-alike:
`ExtensionPromptFrame` and `OptionRow` (the frame and one choice row), the
`PromptRendererProps` and `PromptRendererContribution` types, and the parsers
for what the ask tool folds into a dialog's title and options —
`splitPromptTitle`, `splitInputTitle`, `splitOption`, `choiceOptions`,
`freeTextOption` and `optionForLabel`, with their `OptionParts` and
`OptionPreview` types.

Since API 1.27.0 the frame draws the workbench design's card (1n). Its head
says what it is — `kind` `"question"` (the default) or `"approval"` — then
`from`, who asks, and `pick` (`"one"` or `"any"`) at the right; `title` is the
question under it, and an approval's `message` is its subject in mono (a path,
a command). `hint` opens the foot ("Or type an answer below"), `footer` sits
before the primary action, and `submit` (`{ label, disabled?, enter?,
onSubmit }`) is that action, "✓ Send 2 ⏎" with `enter` when an empty
composer's Enter does the same (register it with `usePromptSubmit` too);
`enter: "mod"` draws ⌘⏎ for an action only ⌘Enter may run, registered with
`usePromptSubmit(label, disabled, submit, true)`: plain Enter and the
composer's send button then leave it alone.
`PromptRendererProps.asker` is who asks as the composer knows it — the
thread's model — for `from`; `PromptRendererProps.agent` (API
1.38.0) names a sub-agent ("GET /orders agent") when a child thread's question
shows on its parent's composer, and wins over `asker` and a topic. An approval
(design 1a/1c) heads with its `title` ("Wants to edit") and puts a one-line
`message` beside it in mono. `OptionRow` draws a 14 px box to tick for `mode`
`"checkbox"`, a round one for `"radio"`, and `detail` as the second line; it
no longer draws `index`. Core's own dialogs use the same frame: a `confirm`,
and a runtime's `select` of Allow / Allow for this session / Deny, is an
approval with Deny, "Always for this thread" where offered, and "Allow ⌘⏎" (⌘Enter in the empty composer allows, plain Enter never does, K83); a
`select` is a question whose pick fills its radio and "Answer ⏎" sends.

`actions.shareFile(path)` (new in API 1.10.0) answers with a URL the page
may load a workspace file from — `{ url, name, size, mimeType }`, the URL
`tau-ext://files/<token>/<name>` — for an `<iframe>`, `<img>`, `<audio>` or
`<video>`. The window's own process serves it from this machine's disk, with
byte ranges so a video seeks, and only for a PDF, an image, audio or video
inside the workspace the host has open (symlinks resolved first); anything
else is refused. It is a client-side method (`share-file`, beside the image
preview), so it is absent — `undefined`, or the action missing — on a client
whose host's files are not on its own machine: the browser client and a
window pointed at a remote host. Files Kit shows PDFs and media with it; the
page's CSP names `tau-ext:` for `img-src`, `media-src` and `frame-src`.

`actions.openFile(path, options?)` puts a document in the stage — `{ line }`
opens it as source scrolled to that line (1-based) and marks it, and asking for
the same line again scrolls there again; `{ trace: true }` (API 1.39.0) is a file the agent
touched: one italic tab at the strip's end that never comes to the front and
never opens a stage that holds nothing (Workspace Kit's trace tabs, design 1a);
`actions.openStageTab(kind, params?, options?)` puts a tab of your own kind
there (above); `actions.openThread(sessionId, options?)`
puts a thread there instead — its transcript, read-only, with the title, status
and cost the thread index carries and a "Take over" button, while the composer
goes on addressing the thread it was already addressing. Both take
`{ pin: true }` for a tab the next preview must not replace. Agents Kit opens a
spawned thread that way rather than switching to it.
New in API 1.15.0, `openThread(sessionId, { machine })` opens a thread of
another machine this window knows (its host id, or its unique name; the machine
the page shows opens as above). The tab reads the transcript over the window's
own connection to that machine (`context.environments.transcriptPage`), which
receives the thread's stream only while the tab is open, and reads it again at
each change; it shows the machine, the run state, the cost, a question the
thread waits on there, and why it may be stale (offline, refused, deleted
there). Instead of "Take over" it offers "Open on <machine>", which moves the
window there with the thread open (ADR 0025). A client without a window process
shows the tab with a note and nothing else; an older core ignores `machine`, so
a kit that must not open a local thread of the same id checks
`context.environments?.watchThread` first. Machines Kit's rail, Remote Work
Kit's question notice and Handoff Kit's "Continues on" banner open such tabs;
so do the Agents panel's rows of sub-agents on another machine. A thread reads whether or
not the host still holds a runtime for it: runtimes are capped, idle ones are
released oldest first, and one nobody used for ten minutes is released too, so a
released thread's transcript is projected from its session file, with the same
paging, cursors and client-message correlation.

`actions.newSession()` asks for the project first, as ⌘N, the rail's "+", the
palette and a phone's button do (K98, for API 1.28.0), so a thread never starts
in the wrong project: the project picker opens with the project in context first
and selected, so Enter confirms it. That project is the draft's or thread's on
screen, or, with nothing on screen (a page, Settings or a phone's thread list
covers it), where the host last worked. Escape closes the picker without a
draft. With one project there is nothing to ask and the draft opens there;
with none (only `/`, or nothing) the "Add project" sources open instead. The
draft starts on the runtime, model, thinking level and mode of the draft or
thread on screen; access and the workspace mode stay at their defaults (new
in API 1.25.0). `actions.newSession({ pick: true })` asks even with one
project, as "New thread in…" and ⇧⌘O do (new in API 1.25.0);
`actions.newSession({ workspace, pick: true })` asks with that project first
(a filtered rail, a thread's "New thread on <branch>"). `actions.newSession({
workspace })` puts a new thread's draft straight into the project that
workspace id names, without asking, and does nothing for a project the window
does not know yet (new in API 1.10.0): a caller that knows the project, such
as a project heading's own button or a settled thread's next draft. Workspace Kit's
`tau app <path>` is the caller: it opens the folder with `openWorkspace` first,
so a project Tau never saw arrives on its own empty thread.

`actions.activeThread().covered` (new in API 1.20.0) is true while something
covers the thread on screen: a page, Settings, an overlay, or a phone's thread
list, which is its home and leaves the last thread open behind it. A kit that
moves the reader because of the thread on screen checks it first.
`actions.threadListOrder()` (new in API 1.20.0) answers the thread ids of the
list core draws itself, a compact client's, top to bottom and past its paging,
with settled threads ranked where they would stand unsettled (so a thread that
is settling has its place still); it is undefined where a kit's rail is the list. Thread Rail reads both when the
user parks the thread on screen (below).

`threadStore.getDrafts()` with `subscribeToDrafts` (new in API 1.21.0, on the
store `useThreadStore()` returns) lists new threads' drafts, newest first: the
draft on screen (`active`) from the moment it opens, and every draft the user
left with text or images in it. They live in this client's storage and are not
threads: `threadListOrder()`, a thread's settle and the rail's selection never
see them. `actions.openDraft(draftId)` makes one the draft on screen again (the
one it replaces is kept or dropped by the same rule) and `actions.discardDraft(draftId)`
throws one away; discarding the draft on screen shows the thread the host has
open. A navigator draws them with `DraftRow` above its active threads, leaves
out one whose `sessionId` it already lists, and marks no thread row active while
a draft is `active`. Workspace Kit's rail is the worked example.

One consequence for `pinTranscriptEntries`: your provider is now also called
with a thread the host has only a file for. `sessionId`, `cwd`, `sessionFile`,
`parentThreadId`, `sessionName()`, `entries()` and `transcript()` answer as
usual; the members that need a live runtime (`complete`, `appendEntry`) throw,
and a provider that throws simply contributes no pins for that thread.

It also lends two document surfaces core owns: `ReviewMode`, the full-workbench
review of a set of changes (file tree, diffs, commit box), and
`ChangesTree`, the changed files of a workspace with stage, unstage and revert.
Both load as their own chunk the first time they are rendered and bring their
own loading state, so an extension renders them like any other component. The
shapes their props speak — `UiWorkspaceChanges`, `UiChangedFile`, `UiFileDiff`,
`UiDiffHunk`, `UiDiffLine`, `DiffLoadOptions`, `WorkspaceChangesQuery`,
`WorkspaceDiffScope`, `ChangeStatus`, `UiEditor`, `UiWorkspaceChangesPage`,
`DiffLineSlot`, `DiffLineContext` — are exported as types beside them.

Two smaller pieces come with them (new in API 1.10.0). `DiffView` is one
file's diff — `{ diff, mode, path?, lines?, onLoadMore?, onExpandContext?, wrap? }`,
`diff` a `UiFileDiff` — with its own scroll element and the same `lines` seam
as `ReviewMode`; `wrap: false` (new in API 1.11.0) keeps each line on one row
and scrolls the diff sideways; it loads from the chunk review mode uses and shows "Loading
diff…" until `diff` is there. `Markdown` is the transcript's renderer (GFM,
highlighted code, links that open outside), for text a host wrote in
Markdown. Review Kit's pull-request view draws a request's files and its
description and comments with them.

`ReviewMode` draws the diffs and knows nothing about what a package does with
them. What a caller may add, all optional:

| Prop | What core does with it |
|---|---|
| `lines` | A `DiffLineSlot`: `onAction(line, { shiftKey })` puts a button in each line's gutter (named by `actionLabel(line)`, "Comment on line N" by default), `count(line)` writes a number on it and keeps it visible, `selected(line)` marks the line, `render(line)` draws a node under the line across the full width. `line` is `{ path, line: UiDiffLine }`, so a removed line is told apart from an added one by its `oldLine`. Without it there is no gutter button. |
| `layout`, `onLayoutChange` | Split or unified. Given a handler, the caller owns the choice and the toolbar toggle asks it; otherwise the toggle keeps its own. A window too narrow for split draws unified either way. |
| `ignoreWhitespace`, `onIgnoreWhitespaceChange` | The flag goes to `loadDiff` as `DiffLoadOptions.ignoreWhitespace`; the toolbar offers the toggle only with a handler. Workspace Kit answers it with `git diff --ignore-all-space` and says "Only whitespace changed." for a file with nothing else. |
| `filesStartCollapsed` | Every file opens folded to its header. Each header folds its file, the toolbar folds or unfolds all, and a file opened from the tree unfolds. |
| `wordWrap`, `onWordWrapChange` (new in API 1.11.0) | Long lines wrap unless `wordWrap` is `false`; unwrapped, every row is as wide as the longest line and the stream scrolls sideways. The toolbar offers the toggle only with a handler. |
| `toolbar`, `aside` | A node in the toolbar, before core's own controls, and a panel beside the diffs. |
| `fileActions` (new in API 1.18.0) | `{ stage, unstage, revert, stageAll? }`: each file row of the list gets stage or unstage and revert (asked first), and a line above the files says how many are staged, with "Stage all". Only for the worktree scope and a device that may write. With files staged, the commit bar says it commits those. |
| `listHeader` (new) | `({ message, committed }) => node`, drawn at the top of the file list and handed the commit bar's message; `committed()` clears it. Review Kit draws the branch's pull request and the linked ones there. |
| `onRefresh` (new) | A rescan button beside the file count; a failed refresh marks the list "stale". |

Review Kit fills all of them: line comments under the lines, their list in
the aside and a "Send to composer" that hands them over as `text-excerpt` chips
through the chip service above (source `Review comment on src/a.ts:12-14`, the
comment and the lines it covers as a `diff` block), and four settings — split view, hidden whitespace, files that start
collapsed, line wrapping — which the toolbar toggles write back. Its colour
setting puts `data-diff-colors="blue-orange"` on `<html>`, and its stylesheet
sets the `--diff-add-*` and `--diff-del-*` tokens below from `--info` and
`--working`, so a theme's own blue and orange carry over.

It also exports the renderer's shared state and presentation:

| Export | What it is |
|---|---|
| `usePreferences` | the same store as `context.preferences`, for a component rendered in a slot. |
| `useAppUpdate`, type `AppUpdate` | (new in API 1.28.0) the Tau release the host downloaded, `{ version, install() }`, or undefined. |
| `useClientStorage`, `getClientStorage`, type `ClientStorage` | the renderer's key/value storage, in and out of the component tree. The phone app keeps each host's keys apart; a key under `device:` (API 1.30.0) is the device's own and shared across its hosts, as Usage Kit's choice of juicebars. |
| `useHostCapabilities`, `useHostName`, `hostHasLocalFiles`, `hostIsReadOnly` | what the connected host announced (`useHostName`, API 1.38.0: the name it gave, for "this page runs on …"); the two functions read the ambient client when given none. `readOnly` (new in API 1.13.0) is true on a device paired Read only (ADR 0024): the host refuses every call that changes something, so disable a write with that reason, or leave it out, rather than offer it. `READ_ONLY_REASON` is core's wording for a disabled control. Core does it for the composer (a note instead of the field), setting rows (inert, with the reason), the palette and chords (for every command and row without `access: "read"`), the title menu (new thread, pin and settle included), the compact list (its Stop, swipe tray and new-thread button), Edit/Fork, the changes tree and the Models page's model, thinking and runtime; preferences stay on the device, and a copied chat goes to the device's own clipboard. |
| `useCommandAllowed(extensionId, command)`, `hostCommandAllowed(extensionId, command, client?)` | (new in API 1.13.0) whether this device may run a kit's host command: always with Full access; on a Read-only device only a command registered `access: "read"`, and none until the host has said which those are (the hook re-renders then). One line disables a control: `disabled={!allowed}` with `READ_ONLY_REASON` as its tooltip. The function is for palette sources and other code outside a component. |
| `useKeepClear` | keeps a floating element clear of the reserved regions of the window. |
| `readCachedTurnActivity`, `changesSinceTurn`, `changesTouchedByTools` | what a turn touched, from the cache core writes. |
| `formatCost` | core's money formatting. `ThreadRow` draws no cost since API 1.26.0; the rail's hover card does. `threadCostLabel(usage)` and `threadCostOrigin(usage)` (API 1.23.0) are the row's own figure ("$0.42", a plan's API value, or tokens) and the sentence that says where it comes from, for a card that repeats it. |
| `StageTabContribution`, `StageTabHandle`, `StageTab` and its three kinds, `StageState` | the stage-tab seam above, and the shape `actions.stageTabs()` answers with. |
| `Markdown`, `highlightSource`, `loadHighlightLanguage`, `canonicalHighlightLanguage` | core's Markdown renderer, the one the transcript draws with, and the highlight.js core behind its code blocks (new in API 1.10.0). highlight.js and each language load on first use; `highlightSource(code, language)` answers HTML once `loadHighlightLanguage(language)` resolved, and nothing for a language core does not ship. `html` (new in API 1.33.0, type `MarkdownHtml`) receives the hast tree with the text's raw HTML as `raw` nodes and returns the tree to draw; Review Kit passes its allowlist of GitHub's HTML. Without it HTML stays text. |
| `VirtualList`, `Menu`, `MenuItem`, `FileKindIcon`, `ChangesTree`, `ThreadRow`, `ThreadActivity`, `ThreadRowMachine`, `usePagedWorkspaceFiles`, `ProviderIconStack` | presentation core owns; `ProviderIconStack` (API 1.15.0) draws a runtime's or model provider's mark (`runtimeProvider`, `modelProvider`) with its name as tooltip and accessible name (`name` replaces it), for the same reason as `ThreadRow`. Given both, it follows core's one rule and never draws more than two marks: a runtime with a provider it owns (its declared `homeProviders`, API 1.24.0) shows its own mark alone ("Codex (OpenAI)"); any other pair shows the access mark (provider or plan) and the runtime's side by side, the runtime's a shade quieter ("Pi via OpenAI", "Antigravity via Anthropic"); a subscription plan wears its product's mark ("Pi via ChatGPT plan" for `openai-codex`). The model's maker is never a mark. API 1.22.0 adds `plan` (a provider whose id does not tell, such as Pi's `anthropic` behind a plan login, is reached through a plan), `modelName` (leads the name: "DeepSeek V4 Flash · Pi via OpenCode Go"), `runtimeName` (an instance's name for the runtime) and `runtimeMark: false` (the runtime stays in the name but not on screen, where the UI around already names it). Given only `modelProvider` it draws the provider alone, for a list that is one runtime's; the UI primitives have their own table above. `ThreadRow` draws provider icons from core's asset pipeline, which an esbuild-bundled package has no loader for, so it is API rather than something a navigator kit re-implements. Its optional `accessory` node is drawn beside the branch label (and before the age on a compact row): a navigator passes other kits' marks through it. Since API 1.11.0 `actions` are buttons drawn before Settle while the row is hovered or focused (not on a settled row); Workspace Kit's rail passes neither since API 1.27.0, so its rows keep their state on hover, and `showLabel: false` leaves out a label that says nothing — Workspace Kit's rail passes it for `main` and `master`, since the default branch says nothing on a card. `details` (API 1.11.0) is a few lines shown beside the row on hover in place of the title's own tooltip, and the branch is cut in the middle (`MiddleTruncate`). `hoverCard` (API 1.23.0) says a navigator draws its own card for the row, so the row shows neither `details` nor the title's tooltip; `details` stays the plain-text fallback. `providerStackLabel(modelProvider, runtimeProvider, { plan })` (API 1.23.0) is the name `ProviderIconStack` gives its marks ("Pi via OpenAI"), for text beside them, and `useModelName(runtime, modelId, provider?)` answers that model's name from the runtime's catalog, asking for the catalog once, or nothing until it is in. A `UiSession` carries `model` since API 1.23.0: the id of the thread's model, from a Pi session file's last model on its branch or from a live runtime; since API 1.24.0 also from a backend's `listThreads` record (`model: { provider, id }`), so a thread that is not open names the model and provider it last ran on (Antigravity and Cursor do) instead of the backend's `modelProvider`. A `UiSession` carries `createdAt` since API 1.11.0 where the runtime's store knows it (Pi's threads), which the rail's "Order threads by: Created" reads. Since API 1.17.0 `machine` (`ThreadRowMachine`: `{ name, icon }`) marks another machine's thread with that machine's icon just before the provider marks, the name as its tooltip; without `onToggleSettled` the row has no Settle button. Since API 1.26.0 the row draws no cost: the rail's hover card carries it (`threadCostLabel`, `threadCostOrigin`), and `showCost` is ignored. The meta line never runs out of the card: the branch shrinks first, then the agent count and the `accessory` marks drop, while the machine and the provider marks stay. |
| `threadRowStatus`, `ThreadRowStatus`, `THREAD_QUESTION_LABEL`, `threadLimitHint` | new in API 1.27.0: the one derivation of a thread row's state that the desktop rail and the tablet and phone lists share. `threadRowStatus(id, activity, thread?)` takes the thread store's activity (`useThreadStore().getActivity()`) and the thread's shell and answers `{ activity, label, hint?, startedAt? }` for `ThreadRow`: a question is "Question", a run "Working" with the host's start of the run, then Limited, Failed, Interrupted, Ready and Idle. A navigator that draws its own rows calls it rather than naming the states itself. |
| `DraftRow`, `draftTitle`, `DraftThread` | new in API 1.21.0: a new thread's draft in the card `ThreadRow` draws: the project line with a quiet grey "draft" where a thread shows its state and the title `draftTitle` gives (the first line typed, chips as their labels, else "N attachments", else "New thread") in muted type, two lines without a branch (the design's, since API 1.27.0; before, a pen, "Draft" and a tint). `onOpen(draftId)` opens it, `onDiscard` adds the hover Discard button, `actions` replaces that button (a touch list's More). A `DraftThread` is `{ draftId, projectName, projectPath, workspaceId?, preview, attachments, createdAt, active, sessionId? }`; `sessionId` is set once the host made the thread, whose row then replaces the draft's. |
| `ProjectIcon`, `useProjectIcon`, `ProjectIconSubject`, `projectHue` | new in API 1.28.0 (`projectHue` 1.27.0): a project's mark as every core list draws it — a published picture (`context.setProjectIcons`), else the host's, else the initial on the project's hue. See "Project icons" above. |
| `loadReviewMode` | the full-window review surface, as its own chunk. |
| the workspace vocabulary | `UiWorkspaceChanges`, `UiFileDiff`, `FileNode`, `WorkspaceInfo`, `UiTurnCheckpoint`, `HostActionResult` … the shapes the stage and the host commands both speak. |

`context.provideService(id, value)` and `context.useService(id, use)` are how
the extensions of one product reach one another without core learning what
travels between them: one publishes under an id its own protocol file names,
the others use it. `use` runs as soon as the value exists — before or after
the user's own activation — and whatever it returns is disposed when the
provider withdraws or either side deactivates, so activation order does not
matter. The shipped kits publish, among others, Workspace Kit's store as
`tau.workspace/store`, and Preview Kit's `tau.preview/browser`, whose
`open(url, actions)` brings the Preview panel forward and navigates — Project
Scripts opens a script's `previewUrl` through it, and falls back to
`actions.openExternal` when Preview Kit is off. Search Kit publishes
`tau.search/files`: `pickFile(onPick?)` opens its "Go to file" dialog, and
with `onPick` hands the chosen path there instead of opening it on the stage;
the Files panel's search button uses it, and a phone's Files sheet reads the
pick itself. Its `jump(target, actions)`
(new in API 1.12.0) brings forward what an agent drives: `{ kind: "browser" }`
the Preview panel with the page, `{ kind: "app", threadId }` the window that
thread's Computer Use driver steers, raised by the driver itself; a handover
that asks the user to take over uses it. On a client away from the host's
machine (a phone, a browser, a window on another computer) `jump` opens the
Preview there instead, where the user drives the page or window by tapping and
typing, and `remote()` (new in API 1.13.0) says so. `watch(target, maxWidth, onFrame)`
(new in API 1.13.0) delivers a small live picture of the page or of a thread's
driven window while the calling page is visible, until the returned stop.
`hold({ Bar?, Footer? })` marks the page as the user's while they take over:
the panel draws an amber frame and "you have control", a phone's Preview sheet
draws `Bar` above the page and `Footer` under it, and the page says a focused
password field is not captured; the returned function releases it. Preview Kit also publishes
`tau.preview/cookie-import` (new in API 1.12.0): `importSite({ site, profile? })`
opens its cookie import dialog with that site filtered to and ticked and that
Preview profile as the target, and answers the import's result, or `undefined`
when the user closed the dialog. The user still picks the browser and clicks
Import; that click is the consent, and no agent tool can import cookies
([browser-cookie-import.md](browser-cookie-import.md)). Terminal Kit publishes
`tau.terminal/run` (new in API 1.11.0): `run({ command, label? }, actions?)`
opens a shell in a tab of its own, shows the Terminal panel, types the command
with `; exit` after it and answers `{ id, exitCode? }` once the shell ended —
the command's status, or no `exitCode` when the shell was closed first. The
click that asked for it is the consent; the output stays in the panel to read.
It also publishes `tau.terminal/font`: `getSnapshot()` answers what the
terminal draws with (`resolved`: face, CSS stack, size and where each came
from), what the user set (`family`, `size`, empty when unset), what the user's
Ghostty config names and the size range; `set({ family?, size? })` writes the
kit's settings (an empty string clears one) and `refresh()` reads the Ghostty
config again. Appearance Kit draws it as the Terminal font row under
Typography, and leaves the row out while Terminal Kit is off.
Computer Use publishes
`tau.computer-use/screen`: the window each thread's agent drives, from the
driver's own screenshots and calls. `state(threadId)` and `load(threadId)`
answer a `ScreenState` — the window (`pid`, `windowId`, app, title), the latest
frame's size and number, the recent inputs with their place in that frame's
pixels, and whether the driver can raise the window — and `subscribe` hears
every change; `frame(threadId, seq?)` fetches the picture itself (base64; the
host keeps the last three per thread), `bringToFront`, `icon`, `access` (the
Screen Recording status, read without asking) and `openAccessSettings` do what
they say, and `live(threadId, onFrame, ended?)` records that one window a few
frames a second where the system already allows it. For a device away from the
host (new in API 1.13.0), `viewFrame(threadId, maxWidth, since?)` answers a
frame at that width — the live capture where allowed, else the driver's
screenshot scaled down — or only its id while it is unchanged, and
`input(threadId, input)` clicks, scrolls, types or presses Enter, Tab,
Backspace, Escape or an arrow in that window through the thread's own driver,
at the pid and window the feed names and nowhere else; a Read-only device may
call the first, not the second. Preview Kit's Screen view
draws it; the types are in `kits/computer-use/protocol.ts`. Its host commands
`screen-state` and `screen-frame` also answer Evidence Kit (`callers`), which
fetches each new frame before the feed lets go of it after three. Evidence Kit publishes
`tau.evidence/capture` (types in `kits/evidence/protocol.ts`): `list(threadId)`
and `image(threadId, id, thumb?)` read a thread's turn pictures,
`subscribe` hears which thread's changed, and `pause(threadId, reason)` /
`resume(threadId)` hold every capture of that thread — and every capture of
the shared Preview — until resumed, for a hand-over where the user signs in;
its host commands `pause` and `resume` take the same from a host half named in
`EVIDENCE_PAUSE_CALLERS`. Preview Kit's `evidence-frame` command answers
Evidence Kit alone with a picture of the page, and nothing while a password
or one-time-code field has the keyboard. Takeover Kit (`kits/takeover/`, new in API 1.12.0) is that hand-over: its `request_takeover` tool (Pi and MCP) waits until the user presses Done or Cancel, its host half pauses Evidence first and holds every `computer_use_*` and `preview_*` call of any thread while a request waits, and its desktop half brings the target forward with Preview Kit's `jump`, Computer Use's `load` and `bringToFront`, and `tau.preview/cookie-import`. Every client reads the waiting requests from its host command `state` and hears the `state` event; `done` and `cancel` answer from any of them. Thread Rail publishes
`tau.thread-rail/siblings`: `siblingsOf(threadId)` answers the threads started
together from one prompt on several models (the thread itself included, or
`[]`), and the Agents panel lists them beside a thread's agents. `actions.attachFiles(files, { sessionId? })` (new in API 1.11.0) hands `File`s to the composer the way a drop on the thread does, with the same limits; named for a thread, they wait until that thread's composer is mounted — open it with `switchSession` first — and are dropped if it has not come in ten seconds. Workspace Kit's rail uses it for files dropped on a row. `actions.copyText(text)` puts text on the user's clipboard and `actions.openExternal(url)` opens a URL in whatever the client calls a browser; both go through the client's `Platform`, so on a host across the network they still mean *this* machine.

Workspace Kit's store (`tau.workspace/store`, typed in
`kits/workspace/protocol.ts`) is such a service, and besides reading the
followed project it lends two places another kit may draw into:
`registerChangesSection(Component)` puts a section at the top of the Changes
panel, clean worktree or not, with the panel's `actions`, the commit message as
the user left it and `committed()` to hand the box back to the proposal; and
`registerThreadRowAccessory(Component)` draws a mark on every rail row, given
the row's `session` (Terminal Kit marks a thread whose shells run a program this way).
`setThreadRowStatuses?(owner, { [threadId]: { label, hint?, icon } })` gives rows a
state of the kit's own, drawn like a question in place of Working (Takeover Kit's
"Your turn"); `{}` withdraws them.
`registerThreadCardSection?({ place, order?, Component })` (new in API 1.23.0) adds to
the card a rail row opens: a pointer resting 180 ms on a row
(a sweep over the rail opens nothing) or keyboard focus on it shows the whole title and a
line per fact with its icon — project 10, machine 20, branch 30, model 40, status 50, the
last turn's changes 55, agents 60, cost 70 — and the card stays while the pointer is on the
row or the card, closes 220 ms after it left both, on a press on the row, a scroll of the
rail and Escape. A `row` is drawn among those lines at its `order` (Machines Kit names this
machine at 20, Terminal Kit its running programs at 45); a `section` is a block below a
divider (Review Kit lists the thread's pull requests, newest first, each opening its tab).
`Component` gets the row's `session`, `external` (another machine's thread, whose card
names that machine itself), `actions` and `Row`, the card's own line (`icon`, `children`,
`tone` `working`/`warning`/`danger`, `onClick`, which closes the card first, and `label`); a
component that draws nothing leaves no line and no divider. An older Workspace Kit lacks
it, so call it as `registerThreadCardSection?.(…)`. The card is one layer on the list, not
a component per row. A touch screen gets no card; a phone's long press keeps its actions.
`registerRailSection?(Component)` (new in API 1.13.0) draws a section at the foot of
the rail, above its footer, given the rail's `actions`; Machines Kit mounts its arrival
there. An older Workspace Kit lacks it, so call it as `registerRailSection?.(…)`.
`registerRailThreads?(source)` (new in API 1.17.0) lists threads of other machines
among the rail's own: `source` has `subscribe(listener)` and `threads()`, which keeps
its identity until the listener runs, and each `RailExternalThread` carries a unique
`key`, the thread's `session` as its own host lists it (the rail sorts, groups,
searches and pages it by that, like its own threads, and merges it into the main list
by time without touching the rail's own order), `running`, `opening`, `machine`
(`{ name, icon }`: the icon is drawn just before the provider marks, the name is its tooltip),
`unavailable` (why it cannot open now; the row is dimmed and says so), `open(actions)`
and `lookIn?(actions)` (the row's hover button). Such a row cannot be settled, pinned,
picked, dragged or given files. Machines Kit lists the other machines' threads this way.
`registerThreadDropTargets?(targets)` lets a kit take a thread dragged in the rail
(design 2f): while a row is dragged, a panel at the rail's foot headed `targets.heading`
lists `targets.targets(session, actions)` (`id`, `label`, `detail`, `icon`, `disabled`
dims a row that cannot take it), and letting go on one calls `drop(session, id, actions)`.
One kit at a time, the last wins; Handoff Kit offers the machines this way ("Continue on").
An older Workspace Kit lacks it, so call it as `registerThreadDropTargets?.(…)`.
The shelves after the main list (snoozed, settled) share its scroll and
follow right after the last active row, as the design draws them (since API 1.27.0; they
sat at the rail's bottom before). Each is a quiet heading with its count ("Settled · 41")
over one-line rows (tile, title, age); a click on the heading folds or opens it.
`collapsed` is only the default — Settled starts open, Snoozed folded — and the client
remembers each shelf it opened or folded (`tau.workspace.rail-shelves-open.v1` in its
storage). An open settled shelf shows ten rows and then 25 a page, and the thread on
screen keeps its row on a folded or paged shelf. A row draws no hover buttons (API
1.27.0): its state or age stays where it is, and Settle, Snooze and the rest are the
row's menu (right click, or the menu key on the keyboard's row) and the keyboard's
(`thread.settle`, ⌘⇧S; without an organizer the menu offers Settle alone). A draft row's
menu opens or discards it. The rail's head is the search, the project filter as an icon
(a folder, or the shown project's tile, with a list of the projects under the search:
"All projects" first, each project's settings on its row, "Add project…" at its foot)
and "+".
`setRailProjectFilter(projectName | undefined)` shows only one repository's
threads in the rail and `openProjectSettings(thread)` opens the settings of the
project a thread runs in — its name, path and icon (both new in API 1.11.0,
called from Thread Rail's row menu). Thread Title Generator publishes
`tau.thread-titles/titles` the same way: `regenerate(actions)` names the thread
on screen again, and the row menu offers "Regenerate title" only while it is
there. `refresh()` re-reads the project's changes and Git facts
after another kit changed them. Review Kit fills both with the pull or merge
request of the branch. `registerFileEditor(open)` is the offer to edit a file:
a double-click in the Files panel calls `open(relPath, actions)` instead of
pinning the file tab, the last offer wins, and Files Kit is the kit that makes
it. `openInEditor(relPath?, editorId?, { line?, column? })` opens a file in
one of the machine's editors at a line, and `chooseEditor(id)` makes one the
default.

Workspace Kit's host reads and writes the project's files for the kits built
on it, and checks every path against the workspace (symlinks included):
`read-file` (with the file's `mtimeMs`), `file-stat` and `write-file`
(`{ relPath, text, expectedMtimeMs?, workspace? }`) name `tau.files` as a
caller. `workspace` (new in API 1.26.0, also on `changes`) names a project the
host knows, by id or path; without it they use the project the host has open.
Files Kit always names the project of the editor tab and refuses a call that
does not, so a save never lands in another project. A write
that names the mtime the editor last saw is refused as
`{ status: "conflict" }` when the file changed since, `null` expects no file,
and no `expectedMtimeMs` writes regardless — that is "keep my version".
`list-editors` answers every editor the machine has — VS Code, Insiders,
VSCodium, Cursor, Windsurf, Trae, Kiro, Antigravity, Zed, Sublime Text and the
JetBrains IDEs, found on the login shell's PATH (`findCommand`), among the
JetBrains Toolbox scripts and, on macOS, as app bundles — and `file-manager`
last, called Finder, Explorer or Files, which reveals the file instead of
opening it (`kits/workspace/editors.ts`).

Two more belong to the rail and to new threads. `registerThreadRailOrganizer(organizer)`
gives another kit the say over the rail (one at a time, the last wins): its
`sections(threads)` splits what the rail would show — searched, newest first —
into sections `{ id, label?, threads, shelf?, collapsed?, settled? }` in draw
order, where the one section without a label is the main, paged list and a
`shelf` folds away under its label with compact rows; `menu(session, lookup?)` and
`runMenu(session, itemId, actions)` are a row's right-click menu (`lookup` is the
registry: chords for hints and the `thread-title` commands);
`toggleSettled(session)` settles or returns a thread the rail moves itself; the
optional `rowActions(session)` (API 1.11.0) is ignored since API 1.27.0, when rows
stopped drawing hover buttons (Thread Rail's snooze clock is its menu's Snooze now); and
`dropLabel(threadId, { sectionId, beforeThreadId? })` / `drop(…)` say what a
pointer drag of a row onto a section or between two rows does — the rail draws
the gesture, the word ("Pin", "Settle") beside the pointer and the insertion
line, and calls `drop` when a label was given. An optional `Layer` component is
drawn once inside the rail for the organizer's own dialogs. The rail keeps a
selection (new in API 1.11.0): mod-click toggles a row, shift-click or
Shift and an arrow selects the run from the last row picked, and a plain
click or Escape ends it; right-clicking a selected row (or the menu key with
a selection) opens the optional `bulkMenu(sessions)`, and a pick goes to
`runBulkMenu(sessions, itemId, actions)`. Without them a selection has no
menu. Without an
organizer the rail keeps its own order: pins first, then newest, settled
threads on their shelf. Thread Rail is the organizer Tau ships.
Settling or snoozing the thread on screen moves the reader on once the host
has the change: to the next pinned or active thread below it in the rail
(on a compact client, in `threadListOrder()`), wrapping round to the top and
skipping threads parked in the same batch, else to a new draft in its project.
That holds for the user's own settle and snooze (row button and menu, title
menu, shortcut, palette, drag onto the shelf, a selection, a phone's swipe),
not for the host's automatic settles, and not while `covered` or once the
reader has moved elsewhere.
`prepareThreadWorktree({ prompt, preparing, force?, branchSuffix? })` makes the
worktree a new thread of the followed project runs in, the way the new-thread
gate does and named by the same naming kit; `force` makes one although the
draft runs in the current checkout, and `branchSuffix` keeps several worktrees
for one prompt apart. It answers `{}` (with a notice) for a project that is no
repository or a worktree that could not be made. A new thread's own choice in
its Branch section, `draftBranch` and `draftBase` in the store's state (set with
`setDraftBranch({ name?, base? })`), wins over the naming kit and the default
base; both are forgotten with the draft.

A new thread's machine and branch are one pill before the model (design 1k/1o,
K152): Workspace Kit's `lead` composer control, "machine · branch", opening one
popover above the composer (a sheet with Done on a phone or tablet). It holds
"Run on" (the machines), then Branch: a field under `tau/` ("name it, or leave
empty"; a name with its own `/` is taken whole), "If empty: Name from the
prompt / Random" (the kit preference `branch-naming`, `prompt` or `random`;
without a naming kit it is random), "Based on" (the default base with its fetch
age, origin's other latest branches and a branch another thread's worktree
holds; "Other branch…" searches the rest) and the "New worktree" switch, whose
whole row is its label. `worktree-base` answers `fetchedAt` (FETCH_HEAD's time)
and `others` for it. Machines Kit fills "Run on" through the store:
`registerDraftMachine({ useMachine, Section })`, where `useMachine(props)` is a
hook naming the machine (or `undefined` for a started thread) and `Section`
draws the rows (`touch` for 44 px rows). Without it the pill names the host
(`useHostName`) and lists it alone, so a phone shows "Run on" with one machine
too.

A host half reaches another kit's host half with `context.invokeHostExtension(id,
command, input)`, and only for a command the target registered with
`{ callers: [<caller id>] }` (ADR 0020). Usage Kit (`kits/usage/`) is such a caller: a
runtime backend that keeps its own per-thread totals answers a `usage` command
granted to `tau.usage` with `{ threads: [{ threadId, cwd, model?, updatedAt, usage? }] }`,
`usage` being a `UiThreadUsage`, read from the kit's own store and never from the
provider. Since API 1.12.0 a thread also names its `turns`: one `UsageTurn` per turn
(`at`, `provider?`, `model?`, `billing?`, the token counts, the runtime's own
`costUsd` and the `turns` it sums), so the Usage page dates every turn on its own
and keeps a plan's turns apart from billed ones; a thread from before its kit kept
turns has only `usage` and is dated by its last activity. The Agent SDK runtime,
Antigravity, Codex, OpenCode, Grok and Cursor answer it; a backend that adds it also adds its row to `BACKEND_USAGE_SOURCES`
in `kits/usage/protocol.ts`, and one that does not answer is listed as not available.

Work outside Tau counts too. A thread in the `usage` answer may name `sessionId`, the
runtime's own session id as its CLI logs it, and a kit whose CLI logs its sessions on
its own answers `usage-logs`, granted to `tau.usage`, with `{ folders: [{ format, path,
instance, billing? }] }`: `format` is `codex` (a folder of rollouts, `<CODEX_HOME>/sessions`
and `archived_sessions`), `agent-sdk` (the Agent SDK runtime's CLI, `projects` in its config
folder) or `opencode` (the XDG data folder holding `opencode.db`), each named from the
instance's own home, and `billing` is the instance's login where the kit knows it. The kit
reads nothing for it. Usage reads the folders in its worker: only lines that carry usage
(Codex's `token_usage_record` per response, or older `token_count` events counted by the
step of their running total, without a fork's replayed start; one assistant response of
the CLI once per message and request id; OpenCode's assistant messages), summed per
session, model and quarter hour as they are read and cached per file by size and mtime in
`outside-usage.json` (one JSON line per file, streamed, with sums and 53-bit hashes of the
responses' ids only), over the last twelve months. A log that only grew is read from where
the last read stopped; one written anew, from its start. OpenCode's database is read in
insertion order past the rows that can no longer change, and SQLite pulls the few fields
a count needs out of each row, so a large row never reaches the worker's heap. A response
another log holds too (an archived rollout, a resumed session) counts where it was read
first. Nothing holds a whole file or every response, so years of logs fit the worker's
256 MB heap (`kits/usage/scan-memory.test.ts` reads 400,000 responses in 64 MB). A summary waits a moment for a first read and otherwise answers with what
is read so far and `reading: true`, and the page asks again. A session a Tau thread ran
as, or one it forked or spawned, is that thread's: skipped where the kit kept the
thread's usage, counted for the thread where it kept none (an imported session). The
rest comes as rows and entries with `outside: true`, `threadId` then being the CLI's
session id; the page marks them, names their sessions and projects, and filters by where
the work ran. Codex, the Agent SDK runtime and OpenCode answer it (`OUTSIDE_LOG_SOURCES`);
an OpenCode instance on a server the user runs elsewhere names no folder.

A kit whose runtime's login reports quota windows answers `usage-limits`, granted to
`tau.usage`, with `{ accounts: [{ id, runtime, label, plan?, checkedAt, windows:
[{ id, kind, label, usedPercent, resetsAt?, windowMinutes? }], unavailable? }] }`
(`resetsAt` in epoch ms, `unavailable.reason` one of `unsupported`, `failed`,
`signed-out`). The input may say `{ refresh: true }`. The command may read the account,
never change it. Codex reads `account/rateLimits/read` through a short-lived
app-server and merges `account/rateLimits/updated` from its turns; the Agent SDK
runtime reads the SDK's usage call through its probe and merges each turn's
`rate_limit_event`; Grok sends its login's token from `<GROK_HOME>/auth.json` to
xAI's billing endpoint and reads the credit window (not for an `XAI_API_KEY` or a
login the user pointed at another issuer or endpoint); Pi Limits (`kits/pi-limits/`)
keeps what Pi's subscription providers send in their response headers. The
backends read at most every five minutes unless asked to refresh. A kit that adds limits adds its row to
`LIMIT_SOURCES` in `kits/usage/protocol.ts`.

An account may also carry `identity: { provider, key }`, so that two runtimes signed in
to one account show once on the Usage page: one entry ("ChatGPT · Codex, Pi"), the
windows of the latest read, and the runtimes' costs of the last 30 days summed and listed
per runtime. `key` is the SHA-256 hex of `tau.account\n<provider>\n<account id>`; Usage
drops any other value, so an account id never reaches the page. Each kit reads the id
locally and sends nothing for it: Codex from the ChatGPT token in `<CODEX_HOME>/auth.json`,
Pi Limits from Pi's `auth.json` (`openai-codex`) and from the `anthropic-organization-id`
header of Anthropic's answers, the Agent SDK runtime from `oauthAccount` in the CLI's
global config file (in its config directory, else in the home folder). `openai` hashes the ChatGPT account id plus `:<user id>` where the token
names one; `anthropic` hashes `org:<organization id>` for a personal plan and adds
`:user:<account id>` for a team or enterprise plan, which Pi cannot tell, so those stay
apart. Pi Limits keeps only the hash in its state file.

Usage's `limits` answer also carries `history`: the readings of the last 24 hours
(at most 12,000), kept in the kit's own `limit-history.json`. A reading is an
account at its `checkedAt`, which is when the provider was asked, never when a
cached answer was handed on; a cached answer adds nothing. A source whose read
fails keeps its last windows, marked `unavailable: { reason: "failed" }`; a
signed-out or unsupported account drops its readings.
The page reads again every five minutes while it is open and seen, asking the
kits for fresh limits, since a forecast needs readings a few minutes apart: a
window runs out, or passes the steady line, within two hours at the pace of
the last run of rising readings of the same source (three or more, five
minutes apart at least, no gap over ten). A reading older than ten minutes is
shown as the last known one and forecasts nothing.

In a desktop window the page also runs `summary` and `limits` on every other
machine the window is connected to (`context.environments.readExtension`; both
are `access: "read"`). It marks those entries and accounts with the machine's
host id (`machine`, set by the page, never sent by a host) and names them
"Codex on rex"; an account with the same `identity` still shows once. A
browser or a phone has no machine list and shows its own host only.

Onboarding (`kits/onboarding/`) asks the backend kits the same way, for the
conversations their CLIs ran outside Tau. A backend that can import them
registers two commands granted to `tau.onboarding`:

| Command | Answers |
|---|---|
| `import-scan` | `{ source, sessions: [{ path, sessionId, cwd, title, updatedAt, imported }], truncated }`: the newest session files of the CLI's home, read from their heads; `imported` marks a session the backend already holds, started in Tau or imported. |
| `import-sessions({ paths })` | `{ imported: threadIds, skipped, failed: [{ path, reason }], update? }`: each file becomes a thread of that backend, resumable by the CLI's own session id. A path outside the CLI's home is refused, a session already held is skipped, so importing twice adds nothing; `update` is `services.sessions.refreshIndex()` after an import that added something, for the client to apply. |

The Agent SDK runtime and Codex answer both; a backend that adds them adds its
row to `SESSION_SOURCES` in `kits/onboarding/protocol.ts`. Each reads its CLI's
own home unless `TAU_IMPORT_ROOTS` names fixture homes — directories laid out
as `<root>/<backend kind>/…`, like the CLI's own — and then reads nothing else;
tests and dev instances use it so they never scan the user's history.

Onboarding hands the new thread ids on to Thread Rail's `settle-imported({ threadIds })`
(granted to `tau.onboarding`), so an imported thread starts on the settled shelf, found by
search and not counted as unread. A source that knows a session is open can name it in
`active: threadIds` next to `imported`; those stay active. Without Thread Rail the threads
stay active. A thread that already has meta is left alone.

Search Kit asks the backend kits for what their threads said, so the palette
finds a thread nobody has open by its text and not only by its title. A
backend that keeps its transcripts in its own store registers
`THREAD_TEXTS_COMMAND` (`thread-texts`) granted to `tau.search`, and
`threadTextsDelta(records, input)` from `tau/host-extension` (new in API
1.12.0) answers it from the store's records (`{ tauThreadId, updatedAt,
messages: [{ role, text }] }`):

```ts
context.registerCommand(THREAD_TEXTS_COMMAND, async (input) => threadTextsDelta(await store.list(), input), { long: true, callers: ["tau.search"] });
```

The input names what the caller holds, `{ known: { [threadId]: updatedAt },
limit }`; the answer is `{ threads: [{ threadId, updatedAt, messages }],
removed, more }` — new and newer threads newest first, `limit` of them (25 by
default), the known ids the store no longer has, and whether more are left.
Only user and assistant text travels, the first 64,000 characters of a
thread (`THREAD_TEXT_CHARS`). Codex, the Agent SDK runtime, Antigravity,
OpenCode, Grok and Cursor answer it; a backend that adds it adds its id to
`THREAD_TEXT_SOURCES` in `kits/search/protocol.ts`. Search Kit asks at most
every five seconds, four pages per backend at a time, and past four million
characters forgets the oldest threads' text but keeps their `updatedAt`, so it
does not ask for them again until they change.

`registerPromptHook` has two halves now. `afterPrompt(event, actions)` is the
old one and is optional; `beforeNewThread(event, actions)` runs *before* a
pending draft's first prompt is sent, while the thread still does not exist. It
receives the draft's project (`projectPath`, `workspaceId`), the prompt, and
`preparing(message)` — a line the transcript shows while the hook works — and
may answer with `{ workspace: { workspaceId, displayPath, name? } }` to move the
thread to another project. The first hook that names one wins; a hook that
throws is reported and the draft stays where it was, so a prompt is never lost
to a workspace that could not be prepared. Workspace Kit uses it to create the
worktree a new thread runs in ([ADR 0017](adr/0017-worktrees-for-threads-and-agents.md)).

The draft moves to the named workspace before its thread exists, and its panels
ask about it right away. A host half that made the folder itself (a worktree)
names it with `services.admitWorkspace(path)` (new in API 1.11.0, permission
`workspace:write`) rather than `workspaceRef`: the same identity, and from then
on `knownWorkspacePath` accepts it for the rest of the host's run. A folder a
host half only found — a browsed directory, a clone the user has not opened yet
— gets `workspaceRef` and stays unknown until the user opens it.

A third half runs before both: `claimNewThread(event, actions)` is offered a
pending draft's first prompt, and answering `true` takes it — core creates no
thread, the composer empties and the draft stays open for the next prompt; the
hook starts whatever it wants itself (usually through its host half and
`services.sessions.start`). Hooks are asked in registration order and the first
`true` wins; one that throws rejects submission and keeps the draft for retry. The event is `beforeNewThread`'s plus `alternate` (the prompt was
sent with the modifier held: ⌘↵ on macOS, Ctrl+↵ elsewhere — a plain send
otherwise), `model` (what the thread would start with, absent when its runtime
chooses), `runtime` (the backend kind) and `attachments` (how many images and
files ride along). `promptAttachments` carries those images and host file paths,
`skillDraft` carries the native skill chip, and `thinkingLevel` and `mode` carry
the draft configuration. Thread Rail claims ⌘↵ to start a thread in the background,
and a prompt with several models chosen to start one thread per model, across
registered runtimes. Each sibling owns a worktree from the same resolved
commit. A partial failure keeps the prompt, attachments and failed targets for
retry; a retry uses the same sibling group and base without relaunching the
successful targets. The launch requires a Git project and reports unavailable
models or rejected images as failures instead of silently sending one thread.

`registerThreadMenu({ id, menu, run })` (API 1.37.0) makes one menu the
thread's everywhere: the thread title opens `menu(session, registry)` in the
page's `Menu` and passes a pick to `run(session, itemId, actions)`, and Thread
Rail, the shipped caller, hands the same organizer menu to the rail's
right-click. `menu` answers `undefined` to leave the title its own; `rename`
on the title edits it in place. The last one registered wins.

The Rename command (`runtime.rename-thread`, F2) opens the same in-place field on
the title; it is unavailable where no title is on screen. A thread of another
machine is renamed on its home machine. Enter and blur save, Esc and an empty or
unchanged title cancel.

`registerForkPrompt({ id, ask })` (API 1.41.0) takes every fork the user starts elsewhere
(`f` on a message, the thread tree's fork, Duplicate) as `ask({ entryId?, turn? })`:
through `entryId`, with its `turn` when the transcript knows it (`f` forks through
the end of the focused message's turn), and without `entryId` a copy of the whole
thread. The prompt asks and then calls `actions.forkFrom({ sourceEntryId }, { workspace })`,
which forks at once and resolves false when nothing was forked; with `workspace`
the fork runs in that project. Workspace Kit is the shipped prompt (design 2d):
its question names the fork's branch (`<branch>-2`, the next free number,
editable) and makes the worktree with Workspace Kit's `fork-worktree` — from the
turn's verified checkpoint (its files, uncommitted, on the HEAD the turn ended
at), the checkout as it is for Duplicate, or the branch's HEAD alone, which the
question says. Without a prompt core forks at once; `actions.duplicateThread({ ask: false })`
copies at once too (Handoff's continuation on another runtime, which goes on with the same work). The last one registered wins.

`registerModelSelection({ id, selected, subscribe, toggle, reset })` lets a new
thread's model picker hold more than one model. Shift-click (or Shift+↵) on a
row calls `toggle(model, current, runtime, currentRuntime)` instead of choosing — `current` is the model
the draft has now — and the picker stays open, marking every key `selected()`
answers (`runtime::provider/id`, once per time chosen, so a model may be in the set
twice; existing `provider/id` keys remain supported); a plain pick calls `reset()` first and then chooses as always. The
picker offers this only while the composer is a draft whose thread does not
exist yet, and only while an extension registered one; the last registered
wins. What to do with the set is the extension's own business — Thread Rail
reads it in its `claimNewThread`.
A third member, `streamingDelivery()`, says what the send chord does while a
turn runs: `"followUp"` queues the message behind the turn, `"steer"` hands it
to the turn now, and the alternate chord (⌘↵, or ⌘⇧↵ when ⌘↵ is the send
chord) does the other. The first hook that answers wins; without one the send
chord queues, which is what core does on its own. It is asked on every render
of the composer, so answer from state you already hold. Prompt Tools answers it
from its "While a turn runs" option. Which chord sends at all is not an
extension's to decide: it is core's `sendShortcut` preference (Settings →
Defaults → Send with — ↵, ⌘↵ once the draft has several lines, or ⌘↵), because
a window in safe mode has to be able to send.

A composer control (`registerComposerControl`) receives `actions` beside
`snapshot`, the same `WorkbenchActions` a panel gets. Among them, a package
that works on the whole draft — Prompt Tools' stash — reads and replaces its
text with `composerDraft()` and `setComposerDraft(text)` (which also persists
it) and its images with `composerImages()` and `setComposerImages(images)`, the
`UiPromptImageAttachment` shape a prompt sends. Chips belong to whoever drew
them; Composer Context's are reached through its chip service.

The composer's footer is one slim row (API 1.27.0, the workbench design):
the model chip with its marks, the thinking chip ("High · 1M ⚡": level,
context window, Fast; K142), the controls a
package places in the row (`placement: "toolbar"`, the default), one "…"
menu, and the round send at the end (API 1.28.0: attach and the context dial
are entries of the "…" menu; the dial comes back into the row once three
quarters of the context are used). A control
that is a setting rather than something to see all the time — Access Kit's
level, Plan Kit's Build/Plan, Prompt Tools' stash — takes
`placement: "menu"`: its `Component` is drawn inside that menu only while it
is open, and builds its entries from `ComposerMenuSection` (`heading`, an
optional `aside` at its end, the entries as children) and `ComposerMenuItem` (`icon`, `label`, `detail` as a
second line, `selected` for one choice of a section, `disabled` with
`disabledReason`, `trailing`, `keepOpen`, `onSelect`); a pick closes the menu
unless `keepOpen`. `shortcuts` lists the `data-composer-shortcut` ids a
command clicks to open such a control; the menu's trigger answers to them, so
`composer.mode` still opens the access level. As the row narrows, the
package chips first lose their labels and then move into the menu; the
model and the reasoning level stay longest. A host older than 1.27.0 draws a `menu` control in the row.
`placement: "lead"` (API 1.27.0) puts a control before the model chip, then a
thin rule, then the model. A `lead` control never folds into the menu. An
older core draws it in the row. Workspace Kit's Run-on pill (a new thread's
machine and branch, K152) is one; the project stays a pill in `draft-actions`.

`tau/host-extension` re-exports every host seam type, every type of the host
protocol (`src/shared/contracts.ts`: `UiMessage`, `UiComposerCommand`,
`GlobalHostEvent` — what `context.emit` becomes on the wire, which a package's
own tests read off the host harness — …) and of a runtime backend
(`ThreadRuntimeBackend`, `ThreadBackendPromptInput`, `AgentRuntimeAdapter`,
`RuntimeTransport`, `RuntimePermissionLevel`, … — types only, so nothing of
core is bundled), plus `HostCommandError`, the
permission and isolation vocabularies, the `PiShortcut` and `PiUserKeybindings`
types that `HostThread.shortcuts` and `runShortcut` speak, the workspace
vocabulary core renders itself (`src/shared/workspace-kit-types.ts`:
changed files, diffs, worktrees, editors), `HostActionResult`, `WorkspaceRef`,
`isWorkspaceRelativePath`, `smallCompletionModel`/`isSmallModel`, `gitExecutable`/`findExecutable`,
`commandInvocation`/`killProcessTree` (how to start a command and end what
it started on this platform: on Windows `findExecutable` resolves through
PATHEXT, a `.cmd` shim such as `npm.cmd` or `code.cmd` runs through `cmd.exe`
— Node refuses to spawn one directly — and `killProcessTree` is
`taskkill /T /F`; spawn with `commandInvocation(command, args)`'s `command`,
`args` and `windowsVerbatimArguments`, see [docs/windows.md](windows.md)),
`assertAllowedCloneSource`, `tauHomeDir` (new in API 1.34.0: `~/.tau`, or
`~/.tau-dev` in a Tau Dev build, the folder of the user's own Tau settings),
`readBoundedImagePreview`,
`assistantAnchorForBranch` (the persisted entry id of an assistant message)
and the `PiKit*` types above. The Git and checkpoint engine that 1.3.0 briefly
re-exported — the `workspaceGit` namespace, `GitCoordinator`, the checkpoint
lease, the checkpoint feature, `assistantAnchorForMessage` and the
turn-checkpoint codec and types — is **gone from this API**: it never shipped in
a release, and it belongs to Workspace Kit, which now owns those modules
(`kits/workspace/`). Gone with it, on the same never-released grounds, are the
exports no kit or example ever imported: `firstSentence`, `safeSessionTitle`,
`visibleTitleText`, `isSkillName`, `isExpectedCommandError` and `namesWorkspace`
here, `threadCostLabel` and `threadUsageDetail` on `tau`. They stay internal to
core; ask for them again with a case. It also re-exports the
text projections a package that reads transcripts needs: `textFromContent`
(content blocks to plain text), `cleanThreadTitle` (a model's answer as a
thread title), `buildTitleConversation` (a thread's first
exchanges as the prompt a title model reads) and `parseSkillEnvelope`
(Pi's skill envelope grammar). It also exports the contracts types
the seam's own signatures speak (`UiMessage`, `UiToolRun`, `UiThreadUsage`,
`UiComposerCommand`, `ExtensionUiPrompt`, `GlobalHostEvent`,
`HostExtensionSummary`, `ThreadBackendKind`), `readPersistedJson` /
`writePersistedJson` (a versioned JSON file written atomically and quarantined
rather than discarded when it will not parse — how a package keeps its own state
beside Tau's), and `PARENT_LINK_ENTRY` / `parentLinkEntry` (the custom entry
`sessions.start({ parent })` writes on a spawned thread and the thread index
reads back as `UiSession.parentThreadId`), `ORIGIN_ENTRY` / `originEntry` (new in
API 1.15.0: the custom entry `sessions.import` writes after an imported
session's header, read back as `UiSession.origin`), and, for the package manager, the row shape and the scope name as types: `InstalledPackage`,
`PackageRemoval` and `PackageScope`.

A package that owns whole threads — a runtime backend — gets four more values:
`prepareSkillPrompt` and `skillInvocationCommand` (a composer draft turned into
what a runtime is actually sent, in that runtime's own dialect),
`validatePreparedPrompt` (core's check that a prepared prompt still matches the
thread it was prepared for), `clientMessageFingerprint` (how core correlates a
sent message with the one the runtime echoes back), `knownSkillNames`, and
`readPersistedJson` / `writePersistedJson` (atomic, mode-0600 JSON with the
quarantine-and-restart behaviour Tau's own state files have).

When core opens one of that package's threads it hands the backend a
`HostBackendOpenContext`: the project's name and label, the user's access
level (`permissionLevel()`), and three routes back into the workbench.
`onMessage(message)` delivers a whole message (a runtime whose turn resolves
only when it is over uses this). `onEvent(event)` is for a runtime that
streams: it reports `ThreadRuntimeEvent`s in Tau's vocabulary — turn started
and settled (a turn settled as `error` may say why in `error`, since API
1.11.0; without it core takes the turn's first error notice; `limit: {
resetsAt? }`, also new in API 1.11.0, marks that failure as a provider's usage
or rate limit, and core then shows the thread as Limited rather than Failed —
without it core recognises the common limit messages itself), assistant start,
delta, thinking and end, tool start, update and end, the queue, notices, and
`usage` when its `catalogView().usage` changed —
and core turns them into the same workbench events a Pi thread produces, keeps
the live turn state, closes the fold of a turn, and brackets the turn with the
turn observers, so checkpoints and status watchers do not care which program
answers. `ask(prompt)` puts a blocking question on the workbench's dialog
surface (the one Pi's extension dialogs use); aborting the thread answers it as
cancelled. The Claude Code kit is the reference: `kits/claude-code/` (ADR 0005);
`kits/codex/` shows the same seam over a CLI's own JSON-RPC server,
`kits/opencode/` over an HTTP server and its event stream, and
`kits/antigravity/`, `kits/cursor/` and `kits/grok/` over the Agent Client
Protocol, whose client, thread backend (`AcpThreadBackend`: turn queue, steer,
replay filtering, transcript) and session store they share as `kits/_acp/` (a
folder of shared code, not a kit).

The context also carries `executionPolicy()` (new in API 1.14.0): what the
thread's project lets its commands reach, merged from every provider of
`services.executionPolicy` (below). Ask it before every turn — the user can set
or lift a limit while the thread lives. A backend that can hold its commands to
a `loopback` policy applies it to its own sandbox; one that cannot refuses the
prompt with `executionPolicyRefusal(policy, "<runtime>")` from
`tau/host-extension`, which names the providers' reasons. Codex runs a limited
project in its own sandbox without network (`workspaceWrite`,
`networkAccess: false`: its sandbox has no host list, so the allowed hosts stay
out of reach too, and on macOS loopback does as well), the Agent SDK runtime
starts the session with the SDK's own sandbox (`sandbox.network.allowedDomains`,
`allowLocalBinding`, `allowUnsandboxedCommands: false`, WebFetch off) and a new
session when the limit changes, and OpenCode, Antigravity, Cursor and Grok
refuse; so do Codex and the Agent SDK runtime on Windows. A backend that never
reads the policy is not held to it: core enforces nothing itself.

A backend whose threads can be deleted answers two more members of its
provider (new in API 1.11.0): `removeThread(threadId)` takes the thread's shell
record out of the backend's own store and answers it as plain JSON, which the
host keeps in its trash, and `restoreThread(threadId, record)` puts that record
back. Only the shell goes — the program's own history (a CLI's session files)
is never touched. A backend without the pair refuses deletion. Codex, the
Agent SDK runtime, Antigravity, OpenCode, Cursor and Grok have it.

A streamed backend whose tool cards should return after a restart or a reload
offers the capability group `activityHistory` (new in API 1.12.0):
`load()` answers the thread's earlier turns as `UiTurnActivityEntry`s, oldest
first, and core reads it when the thread opens; `save(entry)` is handed core's
own record of one turn — its tools, their status and output, and the message
the turn's tools follow — whenever a tool starts or ends and when the turn
settles, a later call for the same `id` replacing the earlier one. The
`anchorMessageId` is an id from the transcript, so `transcript()` has to answer
the same message ids after a restart that the live events carried. A failing
`load` opens the thread without cards, a failing `save` is logged; neither
fails the turn. `TurnActivityStore` from `tau/host-extension` implements both
halves: one JSON Lines file per thread in a folder of the backend's choosing,
outputs clipped to their last 16 KiB and long arguments shortened, turns a
restart cut short read back as interrupted, the newest 500 turns kept, and
`take(threadId)`/`put(threadId, value)` for `removeThread`/`restoreThread`.
Codex, Antigravity, OpenCode, Cursor and Grok keep theirs beside their session stores
(`codex-activity/`, `antigravity-activity/`, `opencode-activity/`, `cursor-activity/`,
`grok-activity/`).

`catalogView().contextUsage` is how full the thread's context window is. Since
API 1.21.0 it may also say when it was measured, `updatedAt` (ms since the
epoch, the end of the turn it describes), and `promptCacheTtlMs`, how long the
provider keeps that context in its prompt cache. A runtime that names the cache
takes part in Resume Compaction (`kits/resume-compaction/`): once the context
holds 100k tokens and has been idle for 70 minutes, a banner above the composer
offers to compact the thread before the next turn writes all of it into the
cache again. It calls `actions.compactContext()`, so a runtime that names the
cache also offers the `compaction` capability group (`compact()`). Pi names it
for a Claude model (five minutes, an hour with `PI_CACHE_RETENTION=long`) and
dates the context by its last reply; the Agent SDK runtime names the CLI's one
hour, keeps the measurement in its session store so a thread opened after a
restart still has it, and compacts by sending `/compact` as a turn of its own,
whose `compact_boundary` gives the size it left. Resume Compaction's desktop
half publishes `tau.resume-compaction/opt-out` (`turnOff(runtime)`, a backend
kind with its instance): the Agent SDK runtime's desktop half calls it when
the user answers the CLI's own resume question with "Don't ask again", and
Settings → Resume compaction turns it back on. Both that list and "Keep full
history" live in Tau's config (`values.tau.resume-compaction.off` and
`.kept`), so they hold on every device.

A compaction shows in the transcript as a divider (new in API 1.27.0): a
`UiMessage` with role `notice`, a short text ("Context compacted") and
`compaction` (`UiCompaction`: `tokensBefore`, `tokensAfter`, `turns: { first,
last }` for the 1-based user turns the summary replaced, and the `summary` in
Markdown, each optional). The transcript draws "Context compacted · turns 1–3
summarised · 142k → 38k tokens" across the conversation and, with a summary,
a "Show" that opens it. A streamed backend reports it as an `assistant-end`
event where it happened and answers it from `transcript()` after a restart;
the Agent SDK runtime turns `compact_boundary` into one (its sizes, no summary)
and keeps it in its session store. Pi's own compaction entries become dividers
in core, with `tokensAfter` estimated from the context the entry left.

An MCP server may ask for a form (an *elicitation*: `requestedSchema` with
text, number, integer, boolean, single- and multiple-choice fields — the same
shape in MCP, Codex's app-server and ACP). `elicitationFields(schema)` from
`tau/host-extension` (API 1.12.0) reads it — `[]` for a form that only asks
yes or no, `undefined` for a field no dialog asks — and
`askElicitation({ source, message, fields, ask, decorate? })` asks one dialog
per field through the backend's `ask`, asks again with the reason when an
answer does not fit, and answers `{ action: "accept", content }`, or
`decline` when a required field (or every field) was skipped. `decorate`
sees each dialog before it goes out; Codex and Antigravity use it to tag the
dialogs with `extras["tau.questionnaire"]`, so Questionnaires pages through the
form as through the ask-user tool's questions (`elicitationFieldTitle(field)`
is the title each dialog carries).

A question that takes typed text — an `input`, an `editor`, a `select` with a
free-text row — may be answered with files (API 1.12.0): the value answer
carries `attachments`, the files and images the user sent from the composer,
typed text or none. Core writes images to a folder per thread under its
temporary directory and folds every file into `value` as a list of paths after
the text (`Attached files:` and one `- <path>` per file) before the answer
reaches whoever asked, so a backend or Pi extension that reads answers as text
gets them without doing anything. A pick among fixed choices (an approval)
takes no files; they stay in the composer.

The host keeps the one list of open questions, and every client follows it:
a question answered on a phone is gone from the desktop's card, rail and
badge, whichever thread each shows. A host half sees each question before it
goes out through `decorateUiPrompt(decorator)` (in-process, `runtime:extend`).
New in API 1.19.0: the decorator may return a function, which the host calls
once the question is answered on any client, cancelled or expired.
Notifications Kit uses it to drop a thread's question from the badge.

`complete(request, model?)` asks a model for one short answer — a thread
title, a branch name, a commit message. It runs on the user's own model
configuration in `~/.pi/agent` and takes the model the extension names, or
the default from that configuration; it is deliberately apart from the thread
the job is about, because which program answers a conversation says nothing
about which model should name it, and a thread whose runtime cannot complete
would otherwise go unnamed. It needs the `sessions` permission. The models it accepts are the snapshot's
`completionModels`, which a `kind: "model"` option offers the user; they are the
same list whatever runtime owns the visible thread, while `models` stays that
thread's own. A host half reads the same list with `completionModels()` (new in
API 1.11.0, `sessions`, in-process only; absent on an older host). The list
holds only what a login reaches: Pi lists every model it knows for a provider
it has a login for, but a subscription serves fewer (a ChatGPT login refuses
`gpt-5.4-mini`, which Pi still lists under `openai-codex`). Where another
runtime's catalog reports what the same vendor's subscription serves (Codex's
`model/list` over the same ChatGPT account, the Agent SDK runtime's models by
their `apiModelId`), a subscription offer missing from it is left out; with no
such report Pi's list stands. The vendor is the provider or the provider Pi
names its subscription route after (`openai-codex` is `openai`'s).
`smallCompletionModel(services, prefer, options?)` from `tau/host-extension` (API
1.11.0) picks a small model from it — `isSmallModel(id)` knows the tiers by id
(`haiku`, `mini`, `flash`, `luna`, …) — the one closest to `prefer`: same
provider first, then the same vendor under another name (a Codex thread's
`openai` is Pi's `openai-codex`), then the longest shared id, so a thread on
`gpt-5.6-sol` gets `gpt-5.6-luna`; `undefined` when none is small, which
leaves `complete` on the default. With `{ elsePrefer: true }` (API 1.12.0) it
answers `prefer` itself instead, where `complete` runs that model under the
same vendor. Thread Title Generator and Worktree Names take the model their
setting names, else this pick with the thread's or draft's model as `prefer`
and `elsePrefer`, for a thread of any runtime; Handoff keeps `undefined` and
writes an excerpt instead of a summary. `HostThread.model` (new in API 1.11.0) is that
model as the thread's runtime names it — a Codex thread's `openai/gpt-5.6-sol`
— so a thread whose draft named none still gives the hint.

A registered backend's `label` is what the workbench calls it where a new
thread's runtime is chosen (the composer's runtime chip, Settings → Runtimes);
it defaults to the kind. The host publishes every installed backend as
`runtimeBackends` on the snapshot and the catalog, with `defaultBackendKind`
naming the one a client gets when it names none. The list is in the one order
every runtime list uses — the model picker's rail, the composer's runtime
menu, Settings → Runtimes and Providers, onboarding: Pi, then backends by the
provider's `order` (new in API 1.11.0; lower first, unset last, ties in
registration order). The bundled kits take 10 (the Agent SDK runtime), 20
(Codex), 30 (Antigravity), 40 (OpenCode), 50 (Cursor) and 60 (Grok); every instance of a program shares its order.

A backend also says how its models wear marks (new in API 1.24.0), and the
host publishes both on its `runtimeBackends` entry. `homeProviders` names the
model providers the runtime owns: beside one of them `ProviderIconStack` draws
the runtime's mark alone ("Codex (OpenAI)"), beside any other both ("Cursor via
Anthropic"). A provider of the runtime's own name needs no entry. `ownPlan:
true` says a subscription on this runtime is its own plan, not the model
provider's, so Claude on the Cursor plan keeps Anthropic's mark instead of the
Claude plan's. The bundled kits declare Codex `openai`, the Agent SDK runtime
`anthropic`, Grok `xai`, Antigravity `google` (with `ownPlan`), OpenCode
`opencode-go`, and Cursor `ownPlan`; a host older than 1.24.0 ignores both.
Antigravity and Cursor name each model's provider by its maker (`claude-…` is
`anthropic`, `gpt-…` `openai`, `gemini-…` `google`; `kits/_acp/model-provider.ts`),
because neither ACP nor Cursor's model list says it; the rest are their own.

A backend that drives a program the user installed may say which version that
is: `version()` on the provider answers `{ tool, installed?, latest?,
updateCommand? }` (`RuntimeToolVersion`), or `undefined` when it cannot tell.
The host asks each backend once a day, never while a snapshot waits for it,
and publishes the answer as `version` on that backend's `runtimeBackends` entry;
the picker's runtime tab and Settings → Runtimes then say that an update is
out, with `updateCommand`, whenever `installed` is older than `latest`
(`compareVersions`). `updateCommand` is what the user runs — a shell command,
or where in Tau to click. For a CLI that npm publishes, `tau/host-extension`
has the pieces: `npmLatestVersion(packageName, { cacheFile })` reads the
registry's `latest` tag with one GET a day, cached in a file of the caller's
(under `services.stateDir`), and never throws; with `TAU_NO_RUNTIME_UPDATES=1`
(test instances, smokes, benchmarks) it asks nothing and answers `undefined`,
and core drops `latest` from every version it publishes, so no client offers
an update; `packageUpdateCommand(realPath,
packageName)` names the Homebrew, npm, pnpm or bun command that owns an
executable's resolved path, or `undefined` for the program's own updater. The
registry request needs the `network` permission. Claude Code and Codex use
both; Antigravity reports the release it pins.

#### Keeping the program current (K124, next API version)

`maintenance()` on the provider answers how the program is installed and what
keeps it current (`RuntimeToolMaintenance`): `install` (`method` —
`homebrew-formula`, `homebrew-cask`, `npm`, `pnpm`, `bun`, `native` or
`unknown` —, a `label` for people, the path and its resolved target),
`installed`, `latest` as the install's own source has it, `update` (a
`CliCommand`: `executable` and `args`, never a shell line), `env` for the
instance, and, when Homebrew lags npm, `behind` and the `switch` steps with
their `restore`. `cliMaintenance({ tool, path, installed?, spec, findCommand,
cacheFile })` in `tau/host-extension` builds all of it from a
`CliPackageSpec` — the npm package, the Homebrew formulae and casks, and the
program's own updater with the path fragments it owns — so a command only
ever names a package the kit declared, and a keg of another name or a `brew`
of another prefix gets none. `detectCliInstall`, `homebrewLatestVersion`
(Homebrew's JSON API, cached with `npmLatestVersion`'s file) and
`cliCommandText` are the pieces. The host runs `update` itself when the user
keeps agent tools up to date (`src/main/runtime-tool-updates.ts`), and
`switch` only when the user asks; clients see it as `version.updates`
(`automatic`, or `ask` before the user answered once) and offer no update
toast for an `automatic` one. Codex, the Agent SDK runtime, Cursor, OpenCode
and Grok answer it.

`programKey()` changes whenever the program does; `executableFingerprint(path)`
(resolved path, size, modification time) is the usual answer. The host keeps
it beside each held catalog and asks a runtime again at once when its key
changed, and asks its version again too, so a CLI updated outside Tau shows
its models the next time a picker opens. Each kit also reads its CLI's version
and drops its own probe cache when the fingerprint changed.

#### A new thread's model before it exists (new in API 1.11.0)

`newThreadCatalog()` on the provider answers what a thread that does not
exist yet may start on: `models`, the `model` it would run on unasked, and
`thinkingLevels` by model id with the runtime's own default first
(`HostRuntimeNewThreadCatalog`). The host adds the kind and the adapter's
capabilities and serves it as the `runtime-catalog` method
(`UiRuntimeCatalog`), which a client asks while a draft is bound for that
backend; a `note` without models says the runtime names them only in a
session. The draft's choice arrives as `NewThreadConfiguration` —
`model` and `thinkingLevel` — and the host applies both through the new
thread's `catalogWrite` right after `open`, before the first prompt. Codex
answers from `model/list` (cached per instance) and the instance home's
`config.toml`, the Agent SDK runtime from its cached probe, Antigravity from
the models its last session named.

Since API 1.12.0 the host keeps that answer instead of asking per draft
(`src/main/runtime-catalogs.ts`). It holds every runtime's catalog, Pi's
included, in memory and in `<userData>/runtime-catalogs.json`; after
start-up it asks, one runtime at a time, those whose answer is missing or
half a day old, and a client that opens a picker gets what is held at once
while the host asks again, behind the answer, any runtime last asked ten
minutes ago or more. `newThreadCatalog` may therefore start the program; it
is never asked twice at once and gives up after 30 s. A catalog reaches every
client as a `runtime-catalog` event only when it changed, and the
`runtime-catalogs` method answers only the catalogs a client does not hold
(it names what it holds by `checkedAt`, which an unchanged answer keeps).

A model in the answer (`HostCatalogModel`) may say more than its name:
`billing` (`subscription`, `api-key`, `free`, `local`), `price` (USD per
million tokens: `input`, `output`, `cacheRead`, `cacheWrite`),
`contextWindow`, `maxOutput`, `images`, `reasoning` and `releasedAt` (new in
API 1.12.0, `YYYY-MM-DD`; the host fills it from models.dev's release dates,
which it keeps from the catalog it fetches for Pi). Whatever it leaves out
the host fills from Pi's model data when Pi knows the model — the same
provider and id first, then any provider that prices the id — so a
subscription offering still carries the price the model has over its API.
`apiModelId` names the id to look up when `id` is an alias (the Agent SDK
runtime's `opus` resolves to `claude-opus-5`); it never reaches a client. A
runtime that cannot run answers `status: "not-installed"` or
`"sign-in-required"` with a `note`, and the host lists none of its models;
one whose answer throws or times out keeps the models it named last with
`status: "unavailable"` and the error as `note`. Codex answers `billing` from
its account (a ChatGPT login is the subscription), the Agent SDK runtime from
its login; both answer `not-installed` without their CLI, and
`sign-in-required` without an account: Codex from `account/read`, the Agent
SDK runtime from its CLI's `auth status --json` (the probe lists models even
signed out, so it is not asked then).

#### What a thread cost (new in API 1.12.0)

`UiThreadUsage.costUsd` is money billed per token and nothing else. What a
subscription covered is `subscription`: its tokens and turns (also counted in
the fields above) and `apiValueUsd`, what the same tokens would have cost over
the provider's API. A client never adds the two; the composer shows
`$0.12 + plan`, and its popover a "Spent" and a "Subscription … would have
cost ≈ $X via the API" part.

Core prices every thread the same way, from `UsageTally` entries — tokens of
one `provider` and `model`, with the `billing` the runtime knew and its own
`costUsd`. The user's price (`modelPrices` in Tau's config) wins; then the
runtime's own price; then, for a subscription or an API key, the provider's
API price from Pi's model data. A Pi tally names no billing; core asks Pi
whether the provider is reached through a subscription login. A runtime
backend keeps its turns as tallies and asks `context.priceUsage(tallies)` on
the `open` context for its `catalogView().usage`, on every read, since prices
can change under a thread; Codex, the Agent SDK runtime and Antigravity do.
Since API 1.30.0 a `listThreads` record carries `usage`, the thread's tallies
from the backend's own store, and the index prices them as it prices a Pi
session file's; a thread that is not open then shows its cost in the rail's
hover card, in Reviews and on the phone, and a price change reprices it. Every
runtime kit Tau ships answers it. Codex, the Agent SDK runtime, Grok and
Antigravity merge a thread's turns once per new turn, so a listing reads no
file and redoes no sum; Cursor and OpenCode keep a running total only and list
it as one tally without a model, the figure their open thread shows. A thread
imported from a CLI keeps the usage its session file counts (Codex, Agent SDK;
OpenCode's import already did).
A host half that sums usage of its own asks `services.priceUsage(tallies)`
(async, also on a worker) and gets one `PricedUsage` per tally: `billing`,
`costUsd`, `apiValueUsd` and the price's `source` (`custom`, `runtime`,
`api`, `none`). `mergeTallies`, `appendUsageTurn`, `legacyUsageTurn`,
`readUsageTurns` and `unpricedUsage` on `tau/host-extension` are the helpers
the backend kits share. `modelPrices` maps `provider/id`, or a bare model id
for every provider, to `{ input, output, cacheRead?, cacheWrite? }` in USD
per million tokens (a missing cache rate is the input rate); it is a record
of the config levels, so `modelPrices.<key>` names one entry. The model
picker shows and sorts by it too.

#### Versions a backend works with (new in API 1.11.0)

`RuntimeToolVersion.compatibility` is a backend's verdict on the installed
version: `{ status: "supported" | "unsafe" | "broken", message?,
recommendedVersion?, installCommand? }`. The backend keeps a `VersionPolicy` —
ranges with a status, the first one the version satisfies decides, and the
release it was tested with — and `versionCompatibility(policy, installed)` on
`tau/host-extension` applies it. A range is comparators joined by spaces
(`>=0.150.0 <0.154.0`), groups joined by `||`, with `^`, `~`, `=`, `<`, `<=`,
`>` and `>=`; a prerelease or a release tag matches no range, so it goes
unjudged. `runtimeVersionPolicy(kind, bundled)` returns the policy
`TAU_VERSION_POLICY` names for that kind (JSON keyed by backend kind; a test
instance's way to fake a range, or a fix that cannot wait for a release) and
the bundled one otherwise. `packageInstallCommand(realPath, packageName,
version)` names the npm, pnpm or bun command that installs exactly that
release; Homebrew cannot pin one, so it answers `undefined` and the update
command stands. The picker's runtime tab and Settings → Runtimes put an unsafe
or broken version before an available update. Tau never runs either command on its own:
the shipped kits draw `RuntimeVersionBanner` above the composer of the thread
and on the card, and its button types the command into a new Terminal Kit
shell without pressing Enter (without Terminal Kit it is copied). A backend
should refuse to open a thread on a `broken` version; Codex's policy calls
every release older than its protocol broken.

A newer release is offered as a toast
(new in API 1.11.0). `loadRuntimeUpdateToasts()` on `tau` loads
a chunk of its own with `createRuntimeUpdateToasts({ run, canRun?, recheck,
settingsPage })`; a kit calls `sync(backends, actions)` with its backends
whenever the catalog changes (`updateAvailable` on `tau` decides cheaply
whether to load the chunk at all). Each backend kind gets one toast per
`latest` — "Update available: Codex v0.156.1" with Settings and Update — and
none while the policy calls the installed version unsafe or broken, since the
banner speaks then. Settings opens `settingsPage(backend)`, which lands on the
Providers page scrolled to that card. Update runs `updateCommand` through
`run` — the shipped kits use Terminal Kit's `tau.terminal/run`, so the user
watches brew or npm work — then, on exit status 0, asks `recheck` and says
whether the version moved; a failed command, a closed shell or an unchanged
version is a toast of its own. Nothing runs without the click. The close
button remembers that release in the client's storage
(`tau.runtime-updates.dismissed.v1`), so the next release is offered again.
Without a runner (`canRun()` false) only Settings is offered, and `refresh()`
redraws an offer on screen once a terminal arrives. Codex and the Agent SDK
runtime answer `recheck` with a host command of that name: it re-registers
the instance's backend, so core asks the version again and every client's
catalog follows, and returns the fresh `RuntimeToolVersion`.
`runtimeUpdateCommand(kind, command)` on `tau/host-extension` returns the
command `TAU_RUNTIME_UPDATE_COMMAND` names for that kind (JSON keyed by backend
kind), so a test instance can put a harmless script in place of the real
update.

#### Instances of one program (new in API 1.11.0)

A backend kit may offer several setups of the program it drives — a second
Codex with its own `CODEX_HOME` and login, say. Each is a backend of its own:
the default instance keeps the plain kind (`codex`), so threads from before
instances stay where they were, and every other one registers
`<kind>@<id>` (`codex@work`), a kind the seam accepts alongside the plain
names. Threads carry the kind, so a thread keeps its instance, the picker
shows one tab per instance and the marks draw an instance as its program
(`runtimeDriver`, `isRuntimeInstanceOf`, `runtimeInstanceKind` on both
`tau` and `tau/host-extension`). A backend registered or dropped after the
host started republishes `runtimeBackends` and the thread index, and a kind
registered anew is asked for its version again — so a kit re-registers an
instance's provider when the user edits it.

`RuntimeInstanceSettings` on `tau/host-extension` keeps a kit's instances in a
file of its own (`<stateDir>/settings.json`): the default instance at the top
level, where the path override always lived, the others under `instances`.
Each has an `id`, a `name`, a `command` (the executable; the kit's variable,
such as `TAU_CODEX_COMMAND`, still wins for the default instance), a `home`
(`~` expanded; it becomes the kit's `homeVariable`), `env` and `args` (one
string, split as a shell would with `splitArguments`, nothing expanded).
`environment(id, base)`, `command(id)`, `args(id)`, `kind(id)` and `label(id)`
("Codex · Work") answer what a launch needs; `save` and `remove` refuse a
taken or malformed id and a relative home. A kit keeps a thread's instance in
its own store, so removing an instance only takes its threads out of the list
until an instance with that id comes back.

On the desktop side `loadRuntimeInstanceUi()` on `tau` loads one chunk (with
its stylesheet) that holds the settings rows of a Providers card.
`RuntimeProgramRows` is the program itself: found where and which version
with Check again, then a version the policy calls unsafe or broken, one older
than Tau speaks to, or a newer release, each with a button that hands the
command to a terminal (`onRunCommand`) rather than showing it; its rows' ids
start with `idPrefix`. `RuntimeCommandRow` is the executable as a text field,
inert with the reason while Tau's environment names it (`TAU_<KIND>_COMMAND`
from `kind` unless `variable` says otherwise). `RuntimeInstanceSetup` (new in
API 1.19.0: `rowId`) is the instance's setup, Edit, "Add instance…" on the
default instance's card and Remove, which asks through `ConfirmDialog`; the
dialog behind it is `RuntimeInstanceDialog` (name, id taken from the name,
executable, home, environment as `NAME=value` lines, launch arguments). The
chunk also holds `RuntimeVersionBanner`, for above the composer. A card's head
shows the runtime's mark, its name and a badge each for the program and the
account: `RuntimeProgramRows` and `SignInSetup` report theirs, and a kit whose
rows are its own reports through `ProviderCardBadgeReport({ source, badge })`
(on both chunks). Every runtime kit Tau ships uses them: the default card
keeps its page id, each other instance gets a page naming its kind, its rows
carry the instance in their ids and its `rows` list them for the search, and
an `instances` event from the host half keeps every client's cards in step.

`services.sessions.start(options)` (`sessions`) creates a thread off screen:
`cwd`, the first `prompt`, and optionally `title`, `model`, `parent`,
`backend`, `attachments`, `skillDraft`, `thinkingLevel` and `mode`. The call
returns after the runtime admits the first prompt. Rejected starts throw and
remove their unused thread, so a kit can preserve the draft and clean up a
worktree. Images use each backend's usual prompt path. Files stay native on backends
that declare `fileAttachments`; other backends receive the absolute host paths
in the prompt so their file tools can read them. `backend` is the kind the thread runs on — `"pi"`, the default, or
any registered kind — and a kind nobody registered is refused before anything
is created. A model is applied through the runtime's `catalogWrite`
capability, so a runtime without model selection refuses one. `tools` (new in
API 1.11.0) keeps the thread to those tools for its whole life, named as Pi
names them (`read`, `bash`, `tau_spawn_thread`); it is for a backend whose
provider sets `restrictsTools` and receives the list in `open(threadId, cwd,
{ resume: false, tools })`. Any other backend — Pi included, whose tools a
runtime extension sets — is refused before anything is created. `parent` is
written into a Pi thread's session file; a thread of another backend has no
such file, so the host keeps its link in the index for as long as it runs and
the extension that asked for it is the durable record. Agents Kit starts a
thread whose agent definition names a runtime this way.

`services.sessions.send(sessionId, text, { delivery, from })` (new in API
1.11.0, `sessions`, in-process only; absent on an older host) sends a message
to any thread the way a composer does. `delivery: "prompt"` (the default)
starts a turn, or joins a running one as a follow-up; `"steer"` joins the
running turn now and rejects where the runtime cannot steer; `"queue"` puts it
into the thread's visible queue, which the host keeps and sends when the
thread's turn ends. `from` names the thread that sent it, so the queue can say
where a message came from. A thread whose runtime the host released is
reopened off screen first. `services.sessions.abort(sessionId)` stops a
thread's running turn, as the stop button does; what the thread had queued
then waits for the user. Agents Kit's `tau_send_to_thread` and
`tau_cancel_thread` are built on these two, and so is the message that wakes a
parent when a child it was not waiting for finished.

`attachments` in `send`'s options and `services.sessions.setModel(sessionId,
provider, id)` (new in API 1.46.0, `sessions`, in-process only; absent on an
older host) let a kit act for another device's composer. `attachments` are
images the thread's model must read, checked as a composer's are (count, size,
`The active model does not support image input.`); a file attachment is refused
because its path is a path of the sender. `setModel` changes any thread's
model, on screen or not, and rejects where its runtime has no model selection.
`setThreadTitle(…, "renamed")` now reopens a released thread off screen, as
`send` does; `"generated"` still needs the thread to be open. Machines Kit
builds its `thread-rename`, `thread-send` and `thread-model` commands on these
three, so another machine's window renames, attaches to and re-models a thread
that lives here; a proxy thread of a third machine is refused.

`services.sessions.import({ cwd, jsonl, title?, origin })` (new in API 1.15.0,
`sessions`; absent on an older host) takes over a Pi session another machine
wrote. The file gets a new id and `cwd` — a folder that must exist on this
machine — in its header; Pi's `parentSession` path is dropped. Right after the
header comes a `tau.remote-work/origin` entry (`ORIGIN_ENTRY`) with
`origin.hostId`, `origin.threadId` and whatever `origin.details` carries; an
origin or `tau.agents/parent` entry the file already had belonged to its old
machine and is dropped, its children moving up. Every other entry is copied as
it was, so paths inside tool results stay text. A `title` becomes the thread's
name. Refused, with nothing written: a format version other than the one this
Pi writes (3), an entry over 16 MB, a file over 96 MB, and lines that are not
session entries. The file lands where Pi keeps the project's sessions (or in
`PI_CODING_AGENT_SESSION_DIR`), appears whole, and is indexed at once with
`UiSession.origin` (the sweep's `HostSessionSummary.origin` too); the call
answers `{ sessionId, path, cwd }`. The thread is not opened: `sessions.send`
continues it, with the model its history last used. Plain data both ways, so a
worker may call it.

#### Signing in from the window (new in API 1.12.0)

A runtime's login, or a Pi provider's, starts on its Providers card (and in
Onboarding) instead of in a terminal the user has to find. The flow is the
program's own; Tau shows where it stands and answers what it asks, and never
keeps a credential: Codex keeps its login in its home, the Agent SDK
runtime's CLI in its configuration, Antigravity's agent its Google token in
Tau's profile folder for it, Pi in its `auth.json`, and a key that only lives
in the user's environment stays there.

The vocabulary is `src/shared/sign-in.ts`, on `tau` and `tau/host-extension`
alike. A **method** (`SignInMethod`) says how a sign-in runs — `browser`,
`device-code`, `api-key`, `terminal` or `credentials` — and why it cannot
start yet (`unavailable`: "Set GEMINI_API_KEY first"). Optional `actionLabel`
sets the button text when a provider requires specific wording; otherwise Tau
uses the usual action for its method kind. `availableWhenSignedIn` keeps a
method visible for a separate connection or reauthorization while signed in.
Both fields and `tryProcessLock` are available in API 1.32.0. An **account**
(`SignInAccount`) says whether the program is signed in, as whom and through
what, and whether a sign-out has anything to remove (a key from the
environment does not). A **flow** (`SignInFlowState`) has an id and a phase
(`starting`, `waiting`, `verifying`, `succeeded`, `failed`, `cancelled`) and,
while it waits, what the user acts on: a consent page to open (`browser`), a
code to enter on a page (`deviceCode`), a command to run in a terminal the
user sees (`terminal`), a question (`prompt`: `text`, `secret`, `select` or
`code`, the last one for a code or an address pasted back), a line and links.

Host kits that serialize protected session updates can use `tryProcessLock(path, { pid, startedAt, app })` from `tau/host-extension`. It returns an OS-held `ProcessLock` or `undefined` while the path is held. Call `release()` in `finally`; the OS also releases it on process exit.

A kit's host half registers the flows with `registerSignIn(context, {
report, signIn, signOut, changed })` from `tau/host-extension`. It registers
five commands and one event, the same for every kit, so the window can drive
any of them: `sign-in-state` (the methods, the account and the last flow),
`sign-in` (`{ target, method }`, answers the new flow at once), `sign-in-respond`
(`{ target, flowId, value }`), `sign-in-cancel` and `sign-out`, each with a
`target` naming an instance or a provider; the `sign-in` event carries a
moved flow, or the whole report once a flow ended or a sign-out ran. The host
sends that event only to clients that may change things: a device paired Read
only neither runs the commands nor sees a flow's page, code or prompt. The helper
keeps one flow per target, refuses an answer to a flow that ended, aborts
the kit's signal on cancel, on a new flow for the same target and after ten
minutes, and asks `changed(target)` after a sign-in or sign-out — the
runtime kits register their backend anew there, so the host asks the
catalog and the version again. `signIn(target, method, flow)` runs the
program's login: `flow.show(…)` puts up a page, a code or a command,
`flow.ask(prompt, { signal })` waits for the user (and withdraws the
question when the program no longer needs it), `flow.verifying()` says the
program is being asked whether it worked, and the resolved value is the line
to show. `publish(target)` sends a fresh report after a setting the kit keeps
changed what a method needs. `commandLine(executable, args, env, platform)`
builds the line a terminal runs, with the instance's home set for it.

On the desktop side `loadSignInUi()` on `tau` loads `SignInSetup` (a chunk
with its stylesheet): the account as a settings row (`rowId` is its element
id) with sign-out, asked through `ConfirmDialog`, and the note on where the
credential lives as its help; each method while signed out, with its button;
and the sign-in flow — Open sign-in page and
Copy link, the device code with Copy and the page's host, the question's
field (a password field for a secret) or its choices, Cancel sign-in and the
time the flow gives up. A `terminal` step of a flow this window started runs
once through `runInTerminal` — the shipped kits pass Terminal Kit's
`tau.terminal/run`, so the login runs where the user sees it — and its exit
status answers the flow; only without a terminal is the command shown, to
copy, with "I have signed in". `showAccount: false` leaves the account row to
a caller that draws its own; `cardBadge: false` keeps a sign-in nested in a
card's list (Pi's providers) out of the card's head.

The shipped kits: Codex signs in over its app server (`account/login/start`:
ChatGPT through the page its own login server serves, a device code, an API
key handed to the CLI) or with `codex login` in a terminal, and signs out
with `account/logout`; the Agent SDK runtime runs its CLI's `auth login`
(for a plan or a Console account) for the instance's home in a terminal, reads
the result with `auth status --json` and signs out with `auth logout`;
Antigravity offers its agent's four methods (a Google account or Gemini
Enterprise in the browser, a Gemini API key, Agent Platform) through ACP's
`authenticate`, keeps the choice and the Google Cloud project in its state
folder, passes the chosen method's variable from the user's environment to
the agent and nothing else, and takes the address of the page Google sent
the browser back to when that page could not load — it must name the
agent's own loopback listener and the sign-in's state, and the host hands it
on. Pi Providers (`kits/pi-providers/`) is Pi's card: every provider Pi
knows, what reaches it now, and Pi's own login per provider.

`services.modelAuth` (`runtime:extend`, in-process only; absent on an older
host) is the seam behind that card: `providers()` lists Pi's model providers
with the sign-in each offers (`oauth` with its label and whether it spends a
subscription, `apiKey` and whether a key can be typed), whether it is set up
and from where (`source`, `label`), what Pi's file holds for it
(`stored`), and where its API lives (`baseUrl`, new in API 1.29.0; it may
carry a key in its query, so a kit keeps it on the host); `login(providerId, "oauth" | "api_key", interaction)` runs Pi's
own login with the same `prompt` and `notify` callbacks Pi's `/login` uses,
and `logout(providerId)` removes what Pi stored. Core runs both on the
model runtime its small jobs complete on, whose credential store is Pi's
`auth.json`, and afterwards asks Pi's catalog again and drops the model lists
it holds, so the picker and a new thread see the change.

### Tau's tools for every runtime: `services.mcp`

A tool a kit gives Pi through `registerRuntimeExtension` reaches only Pi
threads. `services.mcp` (new in API 1.11.0, `runtime:extend`, in-process only)
offers the same tools to every other runtime through a local MCP endpoint in the
host process (ADR 0022): Streamable HTTP on `127.0.0.1`, stateless, one bearer
credential per thread.

| Member | What it does |
|---|---|
| `registerTools(provider)` | `provider(thread)` answers the tools for one thread (`{ sessionId, cwd }`) as Pi `ToolDefinition`s — the very objects the kit registers with `pi.registerTool`. It is asked on every list and every call, with the thread the credential names and no other. Over MCP `execute` gets no `ExtensionContext`: its last argument is `undefined`. Arguments are validated against `parameters` the way Pi validates them, and `executionMode: "sequential"` runs one call of that thread at a time. Returns the disposer. |
| `registerInstructions(provider)` | New in API 1.12.0, so optional on the type (`services.mcp.registerInstructions?.(…)`). `provider(thread)` answers a section of the endpoint's MCP `instructions` for one thread, or `undefined`; the sections join in registration order and reach the runtime in the `initialize` answer; a runtime that honours them puts them into the model's system prompt, as the Agent SDK runtime does. It is the non-Pi half of a system-prompt section: a Pi thread gets the same text from the kit's runtime extension (`pi.on("before_agent_start", …)`). Review Kit asks every runtime to link the requests it works on this way. Returns the disposer. |
| `gate(gate)` | Runs before each call with `{ threadId, cwd, toolName, input, signal, confirm(title, message) }`; answering `{ block: true, reason }` refuses the call with that text. `confirm` is a yes/no question on the thread's own dialog surface. A gate that throws blocks. Access Kit's gate is the shipped one. |
| `connect(thread, options?)` | For a runtime backend: `{ name, url, token, headers }`, the server entry to put into the session's own MCP configuration (`name` is `tau`, so a runtime shows `mcp__tau__<tool>`). `options.tools` narrows what the credential lists and calls to those names, for a thread started with `tools`. The credential lives as long as the thread's runtime; a new runtime gets a new one. `undefined` in safe mode or when the endpoint cannot listen — the thread then runs without Tau's tools. |

The runtime kits are the reference: Codex passes the entry as
`codex app-server -c mcp_servers.tau.…` overrides with the token in the
process environment (`bearer_token_env_var`), the Agent SDK runtime as an
`http` entry of `mcpServers`, Antigravity as an ACP `http` server on
`session/new` and `session/resume` (agy_acp_server 1.1.1 announces
`mcpCapabilities: { http: true, sse: true }`; an agent that does not announce a
transport is not sent servers of it), OpenCode as a `remote` entry laid over
the user's config through `OPENCODE_CONFIG_CONTENT` of the server Tau starts
for the thread (a server the user runs and names by URL gets none), Cursor as
an ACP `http` server on `session/new` and `session/load` (sent without the
transport check, as the Cursor CLI takes it without announcing it), Grok the
same way on `session/new` and `session/load`. Each lets
Tau's gate ask instead of asking again itself. Preview Kit and Agents Kit offer their tools this way.

A thread started with `tools` keeps them on every runtime that can: Codex
switches off its shell, web search, image viewing, image generation, apps and
plugins as the list leaves them out (`kits/codex/tools.ts`) and runs read-only
without `bash`, `edit` or `write`; the Agent SDK runtime gets Claude's own tools by their Pi
names (`read` → `Read`, `find` → `Glob`, …) and no MCP server but Tau's;
OpenCode switches its own tools off in every prompt's `tools`
(`kits/opencode/tools.ts`) and runs read-only without `bash`, `edit` or `write`.
Antigravity, Cursor and Grok cannot restrict their tools and refuse such a thread.

### Media on a turn: `services.turnAttachments` (new in API 1.12.0)

A kit that takes pictures or recordings of what a turn did offers them to
the others without anyone knowing it by name. Core keeps no bytes and draws
nothing: it knows a `TurnAttachment` — `id`, the `turnId` of
`HostTurnObserver` with the turn's `turnStartedAt` and `turnEndedAt`, `at`,
`mediaType`, `size`, `width`, `height`, `caption` — and which extension
provided it (`source`, filled in by core). It needs `sessions` and is
in-process only, since a provider is a live object.

| Member | What it does |
|---|---|
| `provide({ list(threadId), read(threadId, id) })` | Offers this extension's attachments; `read` answers `{ mediaType, data }` (base64). A second call replaces the first. Returns the withdrawal. |
| `changed(threadId)` | Tells the readers that this extension's attachments of a thread changed. |
| `list(threadId)` | Every provider's attachments of a thread, oldest first; a provider that throws is left out and logged. |
| `read(threadId, source, id)` | One attachment's bytes, from the extension that provided it. |
| `observe((threadId, source) => …)` | Hears every `changed`. |

Evidence Kit (`kits/evidence/`) provides its turn pictures this way; Review
Kit's local pull request (`kits/review/local-request-host.ts`) lists them for
the threads of a checkout, gives each turn to the commit that took in its work,
and reads the bytes back with `read` when the user uploads them with a request.

### What a project's commands may reach: `services.executionPolicy` (new in API 1.14.0)

A kit that knows a project must not reach the network — a project that
deploys to a live server, say — says so per folder, and whoever runs the
agent's commands reads the result. Core merges and hands out; it enforces
nothing and knows no reason for a limit. It needs `workspace:read` and is
in-process only, since a provider is a live object. Absent on an older host,
so read it as `services.executionPolicy?.…`.

A provider answers a folder with a rule, or `undefined` for no opinion:
`{ network: "any" | "loopback", allowHosts?, reason? }`. `loopback` means this
machine only; `allowHosts` names what is reachable anyway, as host names or
`*.example.com` (subdomains only; `normalizeAllowedHost` from
`tau/host-extension` says what counts); `reason` is one sentence for the user
that says why and where the limit is lifted. The merged
`HostExecutionPolicy` is `{ network, allowHosts, reasons, sources }`: the
strictest rule wins — `loopback` as soon as one provider says so, and only
the hosts every limiting provider allows. A provider that throws limits the
folder to loopback with no hosts; a limit that cannot be read is not lifted.

| Member | What it does |
|---|---|
| `provide((cwd) => rule \| undefined)` | This extension's rules; may answer a promise, is asked on every read, and a second call replaces the first. Returns the withdrawal. |
| `changed(cwd?)` | Tells the readers that this extension's answer changed, for one folder or for all. |
| `for(cwd)` | The merged policy for a folder, asked fresh. |
| `observe(({ source, cwd? }) => …)` | Hears every `provide`, withdrawal and `changed`. |

A runtime backend gets the same answer for its thread from the open context
(`executionPolicy()`, above). Pi has no sandbox of its own, so the kit that
provides a limit holds Pi's `bash` to it in a runtime extension: Servers
(`kits/servers/pi-network.ts`) rewrites the call in the `tool_call` hook to run
under `@anthropic-ai/sandbox-runtime` — `sandbox-exec` on macOS, bubblewrap
(with socat and ripgrep) on Linux — loopback open, other hosts only through its
proxy and only when allowed, files untouched; PowerShell, Windows and a
sandbox that cannot start refuse the call instead. On Linux the sandbox has a
network namespace of its own, so a service on the machine's loopback (a local
database on TCP) is out of reach there too; Unix sockets still work. The
Terminal Kit prints the reasons above a new shell and says that the shell is
the user's own and not limited.

How each runtime holds a `loopback` policy, and where it stops:

| Runtime | Under `loopback` |
|---|---|
| Pi | `bash` runs in `@anthropic-ai/sandbox-runtime`. Its `SandboxManager` is one per process with one host list, so the kit gives it the union of the lists of every limited project that ran a command since the kit started: a host one project allows is reachable from another's `bash` meanwhile. The inner shell is `bash` whatever Pi's `shellPath` says, and a `shellCommandPrefix` runs outside the sandbox. |
| Agent SDK runtime | The SDK's own sandbox with `allowedDomains`, local binding and no unsandboxed commands; `WebFetch` is turned off, since it runs outside. The user's and the project's own settings for that CLI (`WebFetch(domain:…)` rules, `excludedCommands`) can loosen it; Tau does not read them. A changed policy restarts the session between turns. |
| Codex | `workspaceWrite` (or `readOnly`) without network at every level, since Codex's sandbox takes no host list: no package sources and no loopback either. A command the user approves out of the sandbox in "ask" runs without it. |
| OpenCode, Antigravity, Cursor, Grok | The prompt is refused with the reasons (`executionPolicyRefusal`), until the project's limit is lifted. |
| Windows | Every runtime refuses: none has a sandbox there that holds. |

Tau's own tools in the host process (MCP tools such as `server_*` and
`preview_*`, the Preview browser) and the user's terminal are not limited.

### What Servers asks of other kits

Servers never writes Git in a project or reads the access level itself; it asks
the kit that owns each, through commands that name `tau.servers` as their only
caller (ADR 0020). A kit that replaces one of these answers the same command:

| Kit | Command | What it does |
|---|---|---|
| Workspace (`kits/workspace/protocol.ts`) | `repo-from-tree { path, trees: [{ gitDir, ref, prefix? }], files?, exclude?, message }` | `git init` in a folder without `.git` and one commit of the named trees (the mirror state), the working tree untouched and the index set to that commit, so `git status` shows exactly what differs locally. Answers `{ commit, branch, files, workspace }`. |
| | `commit-files-to-branch { workspace?, branch, message, files: [{ path, content, executable? } \| { path, delete: true }], parent?, unique? }` | A commit on a new branch whose tree is the parent's (HEAD by default) with only these paths replaced or removed, through a scratch index; the user's checkout, index and HEAD stay as they are. `unique` adds `-2`, `-3` to a taken name. |
| | `merge-branch { workspace?, branch }` | A plain `git merge --no-ff` in the caller's checkout; a conflict is aborted and reported, never left half done. |
| Access (`kits/access/protocol.ts`) | `thread-level-of { threadId }` | The level a thread runs at, so a server command asks under the stricter of the thread's level and the target's. |

Servers' own commands are for its own halves; the agent reaches it through
its tools (`server_status`, `server_list`, `server_read`, `server_diff`,
`server_exec`, `server_put_tmp`, `server_propose_upload`), for Pi as a runtime
extension and for every other runtime over `services.mcp`. No tool uploads or
rolls back: `server_propose_upload` draws a card whose button the user clicks.

### What Reviews asks of other kits

Review Kit's Reviews page (`review.reviews`) writes no Git itself. It asks the
kits that own the branches, through commands that name `tau.review` as a
caller (ADR 0020); no core seam is involved:

| Kit | Command | What it does |
|---|---|---|
| Workspace (`kits/workspace/thread-branches.ts`) | `thread-branches { workspaces }` | For each workspace that is a linked worktree on a branch: the branch against the one its main checkout has out — `tip`, `ahead`, `behind`, files and lines from the fork point, `uncommitted`, `merged`, the `conflicts` `git merge-tree --write-tree` reports, `defaultBranch` when a local branch has the repository's default name, and `workspace`/`rootWorkspace` ids to join threads and projects. A branch the target holds under other commits is `merged` too, with `mergedBy`: `tree` when the merge would leave the target's tree as it is (a squash merge), `patches` when `git cherry` finds every commit's patch in the target (a cherry-pick, a rebase merge, rewritten history; cached per tip and target). A main checkout or a folder outside Git is left out. |
| | `remove-thread-branch { workspace, requestMerged? }` | Removes the worktree (`git worktree remove`, never forced) and deletes its branch, then forgets Workspace Kit's record of it; the threads stay. Refused unless the branch is `merged` (or `requestMerged`, Review's word that its pull request merged on the host) and nothing is uncommitted. |
| | `merge-thread-branch { workspace, tip? }` | Merges the worktree's branch into its main checkout the way Remote Work applies a result (`mergeBranchIntoCheckout`: `merge-tree` first, then `merge --no-ff`); answers `{ state, branch, into, root, files, detail, commit? }`, `state` being `merged`, `already-merged`, `conflict` or `blocked`, and only `merged` touched the checkout. Refused when `tip` no longer is the branch's, or the worktree holds work not committed. |
| Remote Work (`kits/remote-work/protocol.ts`, `REVIEW_CALLERS`) | `threads`, `preview`, `thread-send`, `thread-settle` | A link whose work came back as a branch here is a review: `preview` checks the merge, `thread-settle { how: "apply" }` merges it and lets the worktree there go, `thread-send` carries a note. |

The page's own host commands (`local-reviews`, `local-review-merge`,
`local-review-ask`, `local-review-withdraw`, `local-review-summary`,
`local-review-remove`) are for its desktop half; `local-reviews` also counts a
branch merged when a thread in its worktree links a pull request of that branch
last seen merged (`mergedBy: "request"`, from the stored link, no host call); `local-reviews-changed` tells every window to read again.
`local-review-summary` also names the thread's turns (`prompts`, the first line of each prompt) for the review's sidebar.

A review opens as one view (design 1e) for a local review and a remote pull request (`local-review-detail.tsx`, `remote-review-detail.tsx`, on the shared `review-detail-frame.tsx`). Its sidebar is the kit's `Sidebar` for the page: core's Back to thread buttons are hidden by the kit's stylesheet while `.rvd-side` is drawn, and the page tells the sidebar what it holds through `ReviewDetailStore`. Files are drawn under each other (`review-diff-stack.tsx`), each fetched and drawn when it comes near the viewport; a file over 400 lines scrolls inside its card.

### A package's own settings: `services.settings(cwd?)` (new in API 1.12.0)

A host half reads its own entries of `options` and `values` the way the
settings levels resolve them: the project's `.tau/config.json` over this
machine's for `cwd`, this machine's alone without one. The answer is
`{ options, values }` keyed without the package id in front
(`options["tau.evidence.preview"]` is `options.preview`), so a package never
sees another's settings. Ungated, and a worker has it too. It is how work the
host does on its own — a capture while no window watches — honours a
setting a project overrides on a Settings page (`useSetting(…, { scope:
"both" })`).

### Lifecycle hooks a host half may step into

`services.registerThreadLifecycle(hooks)` and
`services.registerTurnObserver(observer)` (both `sessions`) are how a package
learns what is happening to a workspace, a thread and a turn. Every hook is
optional; the host awaits them in registration order.

| `HostThreadLifecycle` | Runs when |
|---|---|
| `beforeWorkspace(cwd)` | before a workspace's first thread opens — startup, project switch. Repair what you keep beside its sessions here. |
| `afterWorkspaceClose(cwd, reason)` | after the host left a workspace and before `beforeWorkspace` of the next one; `reason` is `"switch"` or `"shutdown"`, and at shutdown every open workspace gets one. Release what belonged to it: shells, watchers, caches. |
| `beforeOpen(session)` | before a runtime is built for a session file. |
| `afterFork(source, target)` | after a fork wrote its session file, before that file's runtime opens. |
| `beforeActivate(thread)` | before a thread goes on screen; may answer with a `{ commit, rollback }` transaction (in-process only). |
| `threadDeleted(sessionId, cwd)` | the thread is gone for good: the host's trash purged it, or its session file disappeared. A thread in the trash is not gone yet. Runtime eviction is **not** this — that is `HostTurnObserver.closed`. |
| `sweep(sweep)` | a periodic pass over every persisted session the host indexes. |

`threadDeleted` runs once per deletion, whether the host purged the thread
from its trash or a sweep found the file gone. A throwing hook is reported and
the others still run: the thread is gone either way.

Deleting is two steps (new in API 1.11.0). `services.sessions.remove(sessionId)`
(`sessions`), the verb behind a rail's "delete thread", moves the thread into
the host's trash under `<userData>/thread-trash/`: its runtime is released, a
Pi session file moves there, a thread of another backend hands over its shell
record (`removeThread` on its provider), and the index is republished without
it. The thread on screen, a running one and one Pi's terminal holds are
refused. `sessions.restore(sessionId)` puts it back where it was — refused if
another file took its place — and `sessions.trash()` lists what can still be
restored (`HostTrashedThread`: id, project, title, backend, `deletedAt`,
`purgeAt`). The host purges an entry 30 days after the deletion
(`TAU_THREAD_TRASH_RETENTION_MS` shortens that for a test instance) or when
`sessions.purge(sessionId)` asks, removes only what is inside the trash, and
only then runs `threadDeleted`. Keep what belongs to a thread until that hook:
Thread Rail keeps its meta, so a restored thread comes back where it was;
Composer Context drops the thread's attachments; Workspace Kit's
"last thread deleted" rule counts a thread in the trash as still there.

A Pi session another process on this machine writes — another Tau host with
its own data folder, or a Pi CLI that loaded Tau's lock extension — is guarded
by the same `<session>.jsonl.lock` a runtime holds. `sessions.remove`,
`sessions.restore`, `sessions.purge` and `sessions.import` refuse while it is
held, naming the holder ("This thread is open in another Tau host (pid N, data
folder …); close it there before deleting it."); a due purge waits an hour
instead. `sessions.open` reads such a file without Pi's repairs on open (Pi
rewrites an older format and completes a last line while it reads), and
`appendEntry`, `appendInfo` and `branch` on a `HostSessionFile` throw while
another process holds its session; `sessions.prepare` refuses a file opened
that way.

`HostTurnObserver` brackets the turns of every thread the host drives:
`accepted`, `prepare`, `cancelled`, `ended`, `pending`, `reset`, `closed` and
`toolEnded`. `closed` is a released runtime, not a deleted thread.

### Who is attached: `services.clients`

`services.clients` is ungated — it answers `count()` and takes an observer
with `attached(clientId, { id, transport, profile })` and `detached(clientId)`.
`transport` is `"electron"` (the window) or `"socket"` (a browser tab or a
remote client); `profile` is what that client claimed in its hello
(`desktop`, `web`, `compact`). A package uses it to hold background work until
somebody is watching, or to raise a notification when nobody is.

On the desktop side the same two facts arrive as workbench events:
`context.events.on("client-count", …)` carries `{ count }` whenever a client
comes or goes, and `context.events.on("workspace-changed", …)` carries
`{ from?, to }` when the host opens another project — so a panel reacts
without asking the host what changed. `context.events.on("host-connection", …)`
(new in API 1.12.0) carries `{ state }` — `connected`, `reconnecting`,
`resyncing` or `refused` — whenever the window's link to the host changes;
`connected` after any other state means it is back. `context.events.on("models-changed", …)`
(new in API 1.29.0) carries `{ providers }`, the sorted providers of the
models in a catalog the host just sent: a provider added or signed in shows up
there first. It comes with every catalog, so compare with what you saw last.

The same member lists the devices paired with this host (new in API 1.13.0):
`clients.devices()` answers `HostPairedDevice[]` — `{ id, name, access }`, connected
or not — and an observer's `devicesChanged()` runs when a device is paired,
renamed, changes its preset, is revoked or expires. A window's own in-process
host pairs none and answers `[]`; a host older than 1.13.0 has no `devices`, so
call it as `clients.devices?.()`. Anything a package keeps per device — Push Kit
keeps each phone's push token — goes when its device leaves this list; drop it
from `devicesChanged`, not on a list read before the host opened its access
store.

### Who called a command: `HostCommandCall` (new in API 1.13.0)

A command handler gets a second argument, `(input, call)`:

| Member | What it is |
|---|---|
| `call.device` | The paired device that called (`HostPairedDevice.id`); absent for the host token, a window, the host and another kit. |
| `call.owner` | The caller may manage this host ([ADR 0024](adr/0024-pairing-allowed-on-the-host.md)): the host itself, its own window, or the host token from this machine through the loopback listener. The host token over a LAN or proxy listener and every paired device are not. |
| `call.extension` | The kit whose host half called through `invokeHostExtension`; absent for a client and the host. |

Use `device` for state that belongs to the device asking (a push token), and
`owner` for settings only this machine's user should change (a key). A worker
package gets the same object. An older host passes nothing, so a package that
relies on it treats a missing `call` as "not the owner, no device" and refuses.

### Commands a Read-only device may call: `access: "read"` (new in API 1.13.0)

A paired device is Full or Read only ([ADR 0024](adr/0024-pairing-allowed-on-the-host.md)).
A Read-only device may call a host command only when it was registered as one
that just looks:

```ts
context.registerCommand("state", () => book.state(), { access: "read" });
context.registerCommand("apply-changes", applyChanges, { long: true }); // needs Full
```

Declare it only for a command that changes no file, thread, setting or process
and asks no other kit to — the host cannot check that, and a Read-only device
trusts the declaration. Every other command answers such a device `forbidden`
before the handler runs, and the refusal does not count as a failure of the
command. The option travels from an isolated package's worker too. An older
host ignores it, so a package need not raise `engines.api` for it. A Read-only
device learns what it is from its hello reply (`access: "read-only"`), and
which commands only look from the host's extension summaries (`readCommands`,
new in API 1.13.0). The client refuses every other command, and every core
method the host would refuse, before sending it, with `READ_ONLY_REASON`
instead of a host error. A control asks `useCommandAllowed(extensionId,
command)` and is disabled with that reason, or left out when its whole surface
only writes; the host still enforces it. Put the reason on the control with
`tooltipProps`, not `title`: a touch screen has no hover, so a tap on a
disabled control (`disabled`, `aria-disabled="true"` or `data-inert`) shows its
tooltip at once, and `SettingRow` does the same for an inert row.

Every other command a paired Full device runs counts as a change it made: the
host log records it, and Settings → Connections shows it as the device's last
change. The `audit` option (new in API 1.13.0) says how that reads:

```ts
context.registerCommand("commit", commit, { audit: { label: "committed changes" } });
// Sent by the desktop half after a prompt, not by the user: logged, never the last change.
context.registerCommand("generate", title, { audit: { label: "titled a thread", automatic: true } });
```

`label` is past tense and follows "last change:"; without one the row shows
the kit's name and the command ("Workspace Kit: pull"). A `threadId` or
`sessionId` string in the input names the thread, shown by its current title;
nothing else of the input is kept. Mark a command `automatic` when a client
calls it on its own as part of something the user did (Thread Title
Generator's `generate` after a first prompt, Worktree Names' `suggest`,
Handoff's `bind-transfer`, Terminal's `resize`), and give a deliberate variant
its own command (`regenerate`), so the owner sees the prompt and not its
consequences. The option travels from a worker too; an older host ignores it.

Because every such command counts, a desktop half sends nothing on load. A value that lives in Tau's
config is the host half's to read: `services.settings()` when it activates,
again on `observeConfigChanges` (kind `config`), which also reports Tau's own
`update-config` and `clear-config` writes while watching is off, and per
project from `beforeWorkspace`. A client only tells the host a change its user
made there, when the host must act on it before the config write lands.
A fresh device's preferences are defaults until the host's config arrives, so
mirroring them on load would overwrite the host's values for a moment.
Access Kit reads `values.tau.access.level` and a client sends `set-level` only
for the user's pick; Preview reads its defaults for the host's workspace;
SnapShots arms the window from its own settings (`arm` without input) and
re-arms it when they change; Workspace's `auto-pull` does nothing unless the
host's config turns it on. Where a client must start something, it reads
first, with a `read` command, and sends nothing when nothing is needed (the
workspace's `open-request-waiting`, SnapShots' `armed`, which answers for the
window a call reaches now, so a restarted window is armed again); one that
acts on the host machine itself, like SnapShots' global shortcut, also asks
`hostHasLocalFiles()` first.

`access: "owner"` is the other end: a command that changes who can reach the
host — Tailscale's `serve-on` and `serve-off` — answers `forbidden` to every
paired device and to the host token over a LAN or proxy listener, exactly like
the `connections-*` methods (`src/main/host-method-access.ts`). Only the host
token from this machine, the window and the host itself get through, and a
refused call is recorded for the device like any other. A host older than
1.13.0 ignores the value, so a package that relies on it needs `engines.api`
`^1.13.0`.

### What reaches which client: `emit(…, { topic })` and `watch` (new in API 1.13.0)

A client is sent the stream of the threads it shows, not of every thread
(`HostSubscription`, [host-protocol.md](host-protocol.md#which-pushes-a-client-receives)).
For a desktop half this means the workbench events `tool-start`, `tool-end`,
`user-message`, `assistant-end` and `notice` arrive for the thread on screen
(and one being opened or created), not for threads running in the
background. `agent-status`, `thread-index`, `client-count` and the questions
a runtime asks still arrive for every thread: react to another thread's
work when its turn ends (`agent-status` with `running: false`), as Workspace
Kit and Files Kit do to reread the disk. Since API 1.27.0 an `agent-status`
with `running: true` carries `startedAt`, the host's start of the run, and a
bootstrap's `thread-index` carries `runs` (see
[host-protocol.md](host-protocol.md)).

Extension events go to every client unless the host half names a topic:
`context.emit(name, payload, { topic })` (a string of 1 to 256 characters)
reaches only the clients whose desktop half watches that topic with
`context.host.watch(topic)`, until the function it returns is called or the
package deactivates. Use a topic for output that only a mounted view draws;
Terminal Kit emits a shell's output under `output/<id>`, and a pane watches
it while it is on screen, so a phone showing a chat is not sent a build log.
Watch before asking for a snapshot of what the topic streams, so nothing
written in between is lost. A host or client older than 1.13.0 ignores the
topic and sends such events to everyone, which is why `watch` is optional on
`HostExtensionClient`: call it as `host.watch?.(topic)`.

### Network access: `services.network` (new in API 1.13.0)

`services.network` is how a package takes part in Settings → Connections →
Network access. It is gated by `network` and absent (in a worker: `state()`
answers `undefined`) on a host that opens no listeners of its own, such as an
in-process one.

| Member | What it does |
|---|---|
| `state()` | The `UiNetworkAccess` Connections shows: the switches, the ports, what listens, the problems, the certificate. `proxyHeld` says a package holds the proxy listener. |
| `holdProxy()` | Keeps the loopback proxy listener (`settings.proxyPort`, plain HTTP, every peer counted as remote, no `local-files`) open whatever the switches say, until the returned function runs. Resolves once the listeners followed; a port that would not open is in `state().problems`. For a reverse proxy the package set up on this machine. |
| `keepProxy(keep)` | Keeps the proxy listener open for this package across restarts too, until `keepProxy(false)`: the host remembers it in `<userData>/network-kept.json` and opens the listener at start, before any package runs — a host started as a service has no client to start its packages for a while, and a proxy that outlives Tau (`tailscale serve --bg`) must find it at once. It speaks for the package it was called through. |
| `publishEndpoints(endpoints)` | Adds addresses only the package knows — a proxy's public name — to Connections' list, to every pairing link, and to the page origins the socket accepts. Only an `http(s)` URL without credentials or fragment is taken, as `reachability: "network"`; `trustedCertificate: true` (https only) says a proxy answers there with a certificate browsers trust, so it ranks first and a client does not pin the host's fingerprint for it. The returned function withdraws the list; publish again to change it. |

Everything a package asked for is dropped with it — a worker's holds and
endpoints go when the worker stops — except a kept proxy listener, which stays
until the package lets go of it. Tailscale (`kits/tailscale/`) is the
shipped caller: it keeps the proxy listener and publishes
`https://<machine>.<tailnet>.ts.net/` while `tailscale serve` forwards there.
Behind the proxy listener the host also reads `Tailscale-User-Login` and shows
it beside the client in Connections — never as a login.

On the desktop side, `registerSettingsSection({ id, page, order?, rows?, Component })`
(new in API 1.13.0) adds a section to one of core's Settings pages, below
core's own sections: `"connections"`; `"runtimes"`, below the table of
runtimes (new in API 1.27.0; a section whose `rows` name `runtime-permissions`
is what Pi's Permissions button there opens, as Access Kit's cards do);
`"extensions"`, above the list of extensions; or `"extension"`, on every
extension's own page after its
settings, where the component also gets `extensionId` and `cwd` and draws
nothing for an extension it has nothing to say about (both new in API 1.18.0;
Packages Kit's Update and Remove for an installed package are one). The
component gets `onNotify` and `onChanged`, which reads the page's own data
again after the section changed something it shows (a new endpoint in the
address list). It is profile-scoped like a panel. `rows` (new in API 1.19.0)
are the section's rows the Settings search finds, as on a page: `{ id, label,
keywords? }`, each the `id` of a `SettingRow` in the section.

A section can also join one of the cards core draws (design 2i, 2h): with
`page: "general"` and `card` set to `"appearance"`, `"notify"`,
`"new-threads"` or `"threads"`, or with `page: "connections"` and
`card: "this-machine"`, its component draws `SettingRow`s only, and the card
puts them among its own rows in `order` under its heading. A card no row
lands in is left out. A `general` section without `card` follows the cards.
Workspace, Machines, Thread Rail, Resume Compaction, Notifications and
Appearance fill General's cards; Workspace and Terminal fill This machine.

### Other machines, for this machine's agents: `services.machines` (new in API 1.15.0)

A host keeps a key of its own for each machine its owner let this machine's
agents work on ([ADR 0027](adr/0027-a-host-reaches-other-machines-for-its-agents.md)).
`services.machines` is how a host half acts there. It needs the `machines`
permission and is absent on a host in the window's process and in a worker.

| Member | What it does |
|---|---|
| `self` | `HostMachineSelf`: this host's `id`, `name` and Tau `version`, as its hello gives them to other machines. A kit names the origin of work it sends with it, and says which versions differ when the other side is too old. |
| `list()` | `HostMachine[]`: `id` (that machine's host id), `name`, `status` (`connecting`, `connected`, `offline`, `refused`), `detail`, `roundTripMs`, `lastSeenAt`, `address`, `hostVersion`, and `readOnly` when its owner let the agents in Read only. Never a token. |
| `subscribe(listener)` | Calls `listener` with the whole list when a machine is added, removed or changes status. Returns the way to stop. |
| `call(machine, extensionId, command, input?, { timeoutMs? })` | Runs a kit command on that machine, as `host-extension` from the agents' own device. The other host checks it like any call of a paired device: its preset, `access: "read"`, and an entry in its Connections audit. |
| `request(machine, method, params?, { timeoutMs? })` | Calls one of the core methods in `MACHINE_REQUEST_METHODS` (`src/shared/host-method-access.ts`): `transcript-page`, `thread-tree`, `tool-output`, `abort`, `steer`, `follow-up`, `host-resources`, `readiness`. Any other name is refused with `forbidden` before it leaves. Named by this host's own id, a method that only reads is answered here, so a kit weighs this machine the way it weighs the others; the rest are refused (this host's threads go through `services.sessions`). |
| `watch(machine, topic, listener, { extension? })` | Events that kit emits there with `emit(name, payload, { topic })` (see [topics](#what-reaches-which-client-emit--topic--and-watch-new-in-api-1130)), as `{ name, payload }`, until the returned function runs. The kit is your own counterpart on that machine unless `extension` names another. The topic survives reconnects; nothing arrives while the machine is offline. |
| `upload(machine, source, { onProgress?, signal?, size?, timeoutMs? })` | Sends a file there and answers `{ id, size, sha256 }`; `id` names the blob on that machine, where a kit takes it with `services.blobs.take`. `source` is a `Uint8Array` or any stream of them (`fs.createReadStream(path)` without an encoding). It goes in 8 MB pieces, one at a time, and `onProgress({ sent, total? })` runs after each piece the other machine stored; `total` is `size`, or the buffer's length. At most 2 GB. It rejects on the first refusal (Read only there, its quota, its disk), on a size or sha256 the other host disagrees with, or when `signal` aborts (`cancelled`); the other host drops what it received. |

`machine` is a host id, or a name when exactly one machine has it. A call to
an unknown, offline or refusing machine rejects with a sentence that says
which. `refused` is final until the owner here turns the agents on again:
the other owner revoked their device, or its access expired.

On the receiving machine, `services.blobs` (same `machines` permission, absent
in the window's process and in a worker) has one member:
`take(id, use, { caller? })`. It hands `use` a `HostBlob` (`id`, `path`,
`size`, `sha256`, `device`: the paired device that sent it) and deletes the
file once `use` settles, so copy or move it to keep it. A blob can be taken
once; a second take, an unknown id and one older than an hour all reject with
the same sentence. A command that was told the id passes its own `call` as
`caller`: then a blob another device sent stays where it is and reads as
missing. The host keeps blobs in `<userData>/blobs/` (0700, emptied at start),
at most 2 GB each and 4 GB per device until they are taken, and never lets
them fill the disk to less than 512 MB free.

```ts
// On A: send a bundle, then let the same kit on rex take it.
const blob = await services.machines!.upload("rex", createReadStream(bundle), { size, onProgress });
await services.machines!.call("rex", "tau.remote-work", "receive", { blob: blob.id, sha256: blob.sha256 });

// On rex, in that command:
context.registerCommand("receive", (input, call) =>
  services.blobs!.take(input.blob, (file) => fetchBundle(file.path), { caller: call }), { long: true });
```

Remote Work Kit (`kits/remote-work/`) builds threads on another machine on
this seam and offers them to other kits as the service
`tau.remote-work/threads`: host commands `thread-start`, `thread-send`,
`thread-abort`, `thread-wait`, `thread-result`, `thread-settle`, `threads` and
`thread`, callable by Agents and Handoff (`callers`) and typed in
`kits/remote-work/protocol.ts` (`RemoteThreadCommands`, `RemoteThreadLink`)
with a small client in `threads-client.ts`. The thread there is an ordinary
thread; here there is only a link, and the other machine never reaches back.
`thread-start` takes `agentDepth` for a sub-agent, which the machine there
keeps for its own Agents Kit (`hosted-thread-depth`, caller `tau.agents`), and
`thread-settle` takes `removeThread`, which moves the thread there into that
machine's trash once its work is applied or let go.

Agents Kit is the first caller: `tau_spawn_thread` and an agent definition take
`machine` (a name, a host id, `local` or `auto`), and without one the setting
`values.tau.agents.machine` (Settings → Agents) decides, this computer by
default. A child on another machine is followed through that service into the
same book as one here, so waiting, status, messages, cancelling, the parent's
wake-up and `tau_apply_thread_changes` behave alike; its work comes back as
`tau/<machine>/<slug>` and a conflict applies nothing. Each machine runs as
many children at once as `host-resources` reports cores; the rest queue as
`pending`. For `auto` it asks Machines Kit's `choose-machine`
(`{ purpose: "sub-agent", cwd, backend?, model? }` → `{ machine?: hostId | null,
reason }`, caller `tau.agents`); while no kit answers, the child runs here and
the spawn says why. Its desktop half provides `tau.agents/remote-threads`
(`threadsOn(hostId)`, `subscribe`), which the Machines rail uses to leave those
threads out.

Machines Kit
(`kits/environments/host.ts`) is the shipped caller: it lists the machines for
Settings → Machines, answers `whoami` for another machine's agents, and asks
a machine how busy it is and what it could run (its commands `resources` and
`readiness`, `{ machine }`), only when the page shows it or on "Check again".
Its `choose-machine` (`{ purpose: "sub-agent" | "thread", cwd?, backend?, model?,
machines? }` → `{ machine: hostId | null, reason, machines }`, `read`, caller
`tau.agents`) picks where new work goes: this computer or a machine its agents
reach with Full access (only those in `machines` when given), by weight × cores
× idle CPU share × free memory share. A machine is left out while its reading,
timed from when it arrived here, is older than 15 s, its CPU is at 95 % or its
free memory at 5 %, it runs as many turns as it has cores, the runtime
(`backend`, Pi by default) is not `ready` there, or that runtime lists its models
and `model` is not among them. The weights (0–100, 0 = never automatically; this
computer 5, every other machine 50 unless set) are `values.tau.environments.weights`,
a JSON object keyed by host id, set in Settings → Machines → Automatic. `reason`
is one line with the scores and why each other machine was left out;
`machines` has the same per machine. The "Run on" chip offers **Automatic**
while the window shows this computer: the choice is made when the first prompt
is sent (a prompt hook's `claimNewThread`), among the connected machines that
have a project of the same name; another machine gets the prompt with
`open(id, { newThread: { draft, workspaceId, send: true, model } })` and sends
it there. A thread that started stays where it runs.

`host-resources` answers `HostResources` (`src/shared/host-resources.ts`, on
`tau/host-extension` and `tau`): `cpuCount`, `cpuUtilization` (0–1 across all
cores; the last reading is the start of the next one when it is at most 30 s
old, otherwise the host watches the counters for 5 s), `totalMemory`,
`availableMemory` (free plus reclaimable cache: `MemAvailable` on Linux,
`vm_stat` on macOS), `runningTurns`, `onBattery` where the machine can tell,
and `sampledAt` on that host's clock — compare the age with the time the
answer arrived. Answers within 5 s of each other are the same answer.
`readiness` answers `HostReadiness`: each runtime a new thread could start on
with `state` (`ready`, `sign-in-required`, `not-installed`, `unavailable`, or
`checking` while it has not answered since the host started), read from the
runtime catalog the kits fill and from the `sign-in-state` of the kit that
registered the backend (which also gives `account`), with Pi `sign-in-required` while no model provider has a key or a login, and a ready runtime's `models` count with their `modelIds` (`provider/id`, at most 1000);
`git` (`version`, and `mergeTree` from Git 2.38); `disk` (free space where new worktrees go: `TAU_WORKTREES_DIR`, else
`~/.tau`); `display` (`screen` on macOS and Windows, `x11`, `wayland`,
`invisible` for an Xvfb server, `none`). Nothing is polled; a caller that
chooses a machine asks again when its answer is older than it accepts.

### Reaching the user outside the window: `context.attention`

`context.attention` on the desktop half is the client's `Platform.attention`
(`src/workbench/platform.ts`), or `undefined` on a client that has none. It is
looked up when read, so hold the context, not the value.

| Member | What it does |
|---|---|
| `notify({ title, body?, tag? })` | A notification the OS draws. Resolves `"clicked"` once the user clicked it and the window is in front, `"dismissed"` when it went away, `"unavailable"` when the machine or the user's permission would not show it. A newer notification with the same `tag` replaces the older. It is always silent; play your own sound. |
| `setBadge(count)` | The count on the app's icon — the dock on macOS, the launcher on Linux, the tab's icon and an installed web app's badge in a browser. `0` clears it. |
| `requestPermission?()` | Where the client needs a permission first (a browser tab): ask from a click, not from a timer. |

The Electron renderer holds no permission of its own, so its `attention` asks
the window's process through the client-side methods `notify` and `set-badge`
(ADR 0021); a headless host refuses both. Which client should speak is not
core's to say: a host half that raises news knows who is attached from
`services.clients`, and Notifications (`kits/notifications/`) lets each client
report whether its window has focus and which thread it shows, so exactly one
of them hears of a thread nobody is looking at. That kit is the shipped caller.

### A phone outside the app: Push Kit

Push Kit (`kits/push/`) sends push notifications through Tau's relay, sealed
with a key only the phone and this host have, or, for a platform the user
saved keys for (an APNs key, a Firebase service account; Settings → Push,
kept in `<userData>/kit-state/tau.push/keys.json`, mode 0600, not encrypted —
the host has no keychain), directly to Apple or Google ([push.md](push.md)).
The native app registers the relay's handle for this host and its key with the
`register` command after connecting; it adds its token only when the host,
sending with keys of its own, answers `needsToken`. A package that wants a phone to hear of something
calls `invokeHostExtension("tau.push", "notify", { threadId, kind, text? })`
from its host half — `kind` is `completed`, `failed`, `turn`, `question` or
`approval` — once Push Kit grants it as a caller; Takeover does for "your turn".
Push stays quiet while Notifications Kit's `attended` command says someone is at
a focused client that was used in the last three minutes.

### Other machines: `context.environments`

`context.environments` (new in API 1.13.0) is the client's `Platform.environments`
(`src/workbench/environments.ts`): the machines this window knows and shows threads
of ([ADR 0025](adr/0025-a-window-follows-the-threads-machine.md)). It is `undefined`
in a client without a window process — a browser, a phone — and `getSnapshot()`
stays `undefined` where the window keeps no list (a window started with
`TAU_HOST_URL` or `TAU_HOST_INPROCESS=1`), so an older core and a web client simply
show no other machines. Like `attention`, hold the context, not the value.

| Member | What it does |
|---|---|
| `getSnapshot()` / `subscribe(listener)` | `UiEnvironments`: `shown` (the machine this page was loaded for), `environments` (this machine first, `local: true`, then the saved ones, each with `status` — `connecting`, `connected`, `offline`, `refused` — `detail`, `roundTripMs`, `lastSeenAt`, `readOnly`, its newest threads with `running`, `threadCount` and `projects`), the `pairing` in progress with its six digits, and whether `secureStorage` can keep a key. |
| `open(id, target?)` | Points the window at another machine: the page loads again there, and `target` — `{ thread: { path } }` or `{ newThread: { draft?, workspaceId?, send?, model? } }` — waits for it; with `send` (new in API 1.15.0) the page there sends `draft` as the new thread's first prompt, after picking `model` (`{ provider, id }`), and leaves it in the composer when that fails. It rejects for a machine that is not connected. For the machine already shown, open the target yourself. |
| `takeArrival()` | What this page was sent to show, once. |
| `pair({ text, deviceName? })` or `pair({ nearby })` | Adds a machine from a pairing link, its QR code's text, or an address; or (new in API 1.13.0) one the last `discover()` found, by its host id: it asks without a link, pinned to the fingerprint the record carried. Resolves `added`, `denied`, `expired`, `cancelled` or `failed` once the other owner decided. `cancelPairing()` stops waiting. |
| `discover()` | New in API 1.13.0. `UiDiscoveredHosts`: the machines that announce themselves on this network, looked for a few seconds by the window's own host, whichever machine the page shows. A saved machine found with its pinned fingerprint takes the addresses it has now. Look only when the user asks: looking makes macOS ask about local network access. `NearbyMachineList` draws the result with an action slot per host. |
| `shownElsewhere`, `showLocal()` | New in API 1.13.0. The id of the machine the page shows when it is not the window's own (from the page's address, so known before the list loads), and the way back. Core offers "Back to this computer" in the palette whenever `shownElsewhere` is set, whatever kits that machine serves. |
| `pair({ …, agents })`, `setAgents?(id, on)` | New in API 1.15.0 ([ADR 0027](adr/0027-a-host-reaches-other-machines-for-its-agents.md)). A pairing asks for this machine's agents as a second device under the same approval unless `agents` is `false`, and the result's `agents` says whether their key reached this machine's host (`{ added: false, message }` when the other Tau issues none). `setAgents` turns the agents on for a saved machine (a pairing for them alone, with the digits as `pairing`) or off; it answers `{ state: "on" \| "off" \| "denied" \| "expired" \| "cancelled" }` or `{ state: "failed", message }`. |
| `threads[]` | Each machine's threads, newest first: `id`, `path`, `title`, `projectName`, `workspaceId`, `modifiedAt`, `running`, and (new in API 1.17.0) `projectLabel`, `usage`, `backendKind`, `modelProvider` and `createdAt` as that machine's index lists them, so a rail row of that machine reads like one of this machine's. A session nobody wrote in yet is left out, as in this machine's rail. |
| `open(id, { threadId })` | New in API 1.15.0. Names a thread there by its id instead of its path; the window finds it in that machine's index, and rejects when it does not list it. |
| `watchThread?(machine, sessionId, listener)`, `transcriptPage?(machine, sessionId, cursor?)` | New in API 1.15.0: a thread of another machine read without moving the window, what `openThread(id, { machine })` draws. While a listener is left, the window's connection to that machine subscribes to the thread (a lease the page renews every 20 s; the window lets it go a minute after the last renewal), and the listener hears a `UiEnvironmentThreadView` at once and at every change: `status` of the connection (`unknown` for a machine the window does not know), the thread's index entry (`title`, `path`, `running`, `usage`, …) once `indexed`, the dialog it waits on there (`asking`, when the window saw it asked), and a `revision` that grows with every change of its stream, a few times a second at most. `transcriptPage` reads its newest page there, with the window's key; read again when `revision` grows. |
| `readExtension?(machine, extensionId, command, input?)` | New in API 1.15.0: runs a kit's host command on another machine without showing it, over the window's own connection there, and answers what the command answers. Only a command that machine lists as registered `access: "read"` runs; any other is refused before it is sent, so a look-in can watch but never change anything. The window asks that machine's list once per connection and again, at most every 10 s, when a command is missing from it. |
| `environments[].update`, `update?(id, action)` | New in API 1.28.0 (K103). Each machine's own Tau as its host reports it (`HostUpdateStatus`: `version`, `phase`, `latest`, `automatic`, `installer`, `reason`, …; absent from a host too old to report one), followed live. `update(id, "check" \| "install" \| { automatic })` asks that machine over the window's connection there; it decides with the window's key (Full access, and its owner's `devicesMayInstall`) and answers the new status. |
| `setPreferences({ reopenShown })` | New in API 1.13.0. Whether the window shows the machine it showed last again at start (`UiEnvironments.reopenShown`); it does when that machine answers within 2.5 s. |
| `rename(id, name)`, `remove(id)`, `retry(id)` | Rename or forget a saved machine (its key goes with it), or try to reach it now. |

The window's process answers all of it through client-side methods
(`environments-list`, `-pair`, `-cancel-pairing`, `-rename`, `-remove`, `-retry`,
`-open`, `-take-arrival`, `-discover`, `-set-preferences`, `-set-agents`, `-watch-thread`,
`-transcript-page`) and the `environments` and `environment-thread` window events; a host refuses the
methods with `unsupported`. Every kit a page loads comes from the machine it shows,
so a kit needs nothing of its own to work on another machine; what needs *this*
window's machine — a window half, `local-files` — is not offered there.

A browser has no `context.environments`. The phone app has its own
(K106, `mobile/src/machines.ts`): every host the phone paired with, each over
its own token, none of them `local`. The one on screen streams through the
workbench's connection and lists no threads of its own there (the workbench
has them); `status` follows that connection. The others are read in short
visits, an auxiliary hello that follows no thread and no topic, at start,
every two minutes while the app is in front, when it comes back to the front
and on `retry`; a visit replays what the host pushed since the last one and
takes a `bootstrap` only when it cannot, and the link stays open 20 s for a
`readExtension` before it closes. Their `status` is what the last visit
found, kept per host with its threads, so the reload a machine switch makes
shows them at once; a host that refuses the token is `refused` and its token
dropped, as opening it would. `open(id, target)` loads the app on that host
(a thread by its id, or an arrival `takeArrival` hands the next page);
`pair`, `discover` and `setPreferences` do nothing there (the phone pairs
from its host list), and it has no `watchThread`, `transcriptPage` or
`update`. `threads[].settled` says the phone settled the thread while it
showed that host. On a phone Machines Kit lists the paired machines in the
Run-on sheet (a machine out of reach says why and cannot be picked; opening
the sheet asks it again), the other machines' threads in the thread
list (`registerThreadListSource`) and their state in `thread-list-head`.

### A machine's own Tau: `useMachineUpdates`, `useHostUpdate`

New in API 1.28.0 (K103), from `tau`, for an "Update available" mark (the
sidebar footer) or a page of one's own:

- `useMachineUpdates()` → `{ pending, host? }`. `pending` lists every machine
  this client reaches that runs an older Tau than it could: in a window, each
  machine of `context.environments` whose host knows a newer release or whose
  version is older than this window's; in a browser or on a phone, the one host
  it talks to. Each entry: `id?`, `name`, `local`, `version?`, `latest?`,
  `phase?`. Empty when everything is current. `host` is the connected host's
  own status.
- `useHostUpdate()` → `{ status?, unavailable?, store? }`: the connected
  host's status, why there is none (an older host), and `store.check()`,
  `store.install()`, `store.setSettings({ automatic })`.
- `describeHostUpdate(status)`, `hostUpdatePending(status)`,
  `machineBehind(machine, reference?)`, and the types `HostUpdateStatus`,
  `HostUpdatePhase`.

Settings → About and Settings → Machines use the same state
([host-updates.md](host-updates.md)).

### `engines` and `engines.api`

`engines.tau`, `engines.pi` and `engines.api` are version ranges checked
against the running Tau, its bundled Pi, and `EXTENSION_API_VERSION`
(`src/shared/extension-compat.ts`, currently `1.16.0`) — the version of the
contribution interfaces themselves: `HostExtensionServices`,
`WorkerHostServices`, `DesktopExtension` and the `tau` hooks. Its **major**
moves when one of those breaks; its **minor** moves when one of them only
grows (a new optional member, a new contribution type). A package that
constrains `engines.api` and fails the check stays off on **both** sides, with
the reason shown in Settings → Inspector; a package that names no `engines.api`
always passes.

The compatibility rule mirrors ordinary caret ranges: for `^1.2.0`, the
running Tau must have the **same major** version and a **minor.patch at least
as high** as required (`1.2.0`, `1.2.1`, `1.5.0` all satisfy it; `1.1.9` and
`2.0.0` do not). The range grammar itself is a small, dependency-free subset
of npm's — `*`, an exact version, `^`, `~`, comparators (`>=`, `>`, `<=`, `<`,
`=`), a bare major or major.minor as an implicit exact-line match, and `||`
for alternatives (`satisfiesRange` in `extension-compat.ts`). A range Tau
cannot parse is a manifest error, not a silent "incompatible" — a typo in
`engines` surfaces immediately. While Tau's own version stays pre-1.0 (see
`package.json`), pin `engines.api` rather than `engines.tau`.

### Permissions vocabulary

A package's `permissions` array draws from a fixed list
(`src/shared/extension-permissions.ts`); an unknown name is a manifest error.

| Permission | Lets the package… |
|---|---|
| `workspace:read` | read the current project's path, name and file contents through the host services, and provide and read what a project's commands may reach (`executionPolicy`, API 1.14.0). |
| `workspace:write` | change files and write Git in the current project. |
| `workspace:switch` | open or pick another project. |
| `sessions` | read session files, threads and transcript entries, hook into thread lifecycle and turns, and provide and read turn attachments. `agentDir`, Pi's configuration directory, is plain bootstrap data every package may read. |
| `runtime:extend` | register Pi runtime extensions, load one Tau ships, offer tools to other runtimes over MCP (`mcp`), register runtime backends, permission levels and UI decorators — the members that hand out a live runtime — read a workspace's skill catalog (`skills`), and sign Pi's model providers in and out (`modelAuth`). |
| `process` | start processes, and call `noteSubprocess` and `findCommand` — the host-side bookkeeping for them. In a worker `child_process` is refused without the grant, by `require` and by `import()` alike. For an `in-process` package nothing is enforced. |
| `network` | reach the network, and take part in the host's own network access (`services.network`). In a worker the grant gates `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest` and the socket builtins, by `require` and by `import()` alike. For an `in-process` package nothing is enforced. Either way it is a guardrail against a mistake, not a boundary against code written to get around it — see §6. |
| `machines` | act on other machines this host holds a key for, as this machine's agents (`services.machines`, API 1.15.0, [ADR 0027](adr/0027-a-host-reaches-other-machines-for-its-agents.md)): run kit commands there, read and stop their threads, follow their kits' topics, send them files; and take files their agents sent here (`services.blobs`). |
| `native` | (API 1.17.0) load compiled code: a `.node` addon (by `require`, `import` or `process.dlopen`), a SQLite extension (`DatabaseSync#loadExtension`), the raw handles of `process.binding` and `process._linkedBinding`, and V8 flags (`v8.setFlagsFromString`). In a worker all of these are refused without it; see §6. Compiled code runs outside the worker's guards and caps and a crash in it stops the host, so grant it like `in-process`. An `in-process` package loads addons through `services.loadDependency` and needs no grant for it. |
| `packages` | install, update, remove and list other extension packages (`listPackages`, `installPackage`, `removePackage`, `updatePackages`), trust a project in Pi's name so its packages load (`projectTrust`, K112), and read the last build of each package half (`packageBuilds`, K112). Tau's own Packages kit holds it; a package that asks for it can add code that later runs, so read the request carefully. |

**Permissions gate the host half.** A desktop half runs in the window with
what the user can do there: every `WorkbenchActions` member is ungated,
`runShellAction` included, which runs a command in the project of the thread
on screen the way Pi's `!` does (a device paired Read only is refused it), and
so is sending the agent a prompt. Approving a package with a desktop half
trusts it that far, whatever its `permissions` list says; the list is what its
host half may reach.

`services.agentDir` is ungated: it is the path of Pi's own configuration
directory (`~/.pi/agent`, or what `PI_CODING_AGENT_DIR` names), and reading inside it
is ordinary file work that no permission gates either. A worker gets it in its
bootstrap, so it costs no round trip. `services.sessionsDir` is its sibling:
the Pi session directory Tau actually uses (`PI_CODING_AGENT_SESSION_DIR` when
set, else `<agentDir>/sessions`). A package that persists thread-like state of
its own keeps it beside that directory, so an isolated test instance never
writes into the user's real store.

`services.stateDir` is the third of them and the one to reach for first: the
package's own folder under Tau's user data, `<userData>/kit-state/<id>/`. It is
ungated like the other two, it is never shared with another package, and
nothing creates it until the package writes there. `TAU_USER_DATA` moves it
with everything else, so a dev instance's state is its own — Agents Kit keeps
its link index there. What belongs in the *user's* `~/.tau` instead is
configuration the user edits: Agents Kit reads its running budget
(`maxRunningAgents`) and how far sub-agents' commands yield (`priority`:
`"low"` by default, `"background"` or `"normal"`; `"lowPriority": false` means
`"normal"`) from `~/.tau/agents.json` and never writes it.

`services.themesDir` is the folder of the user's own themes — `~/.tau/themes`,
or what `TAU_THEMES_DIR` names (a dev instance points it under `.tau-dev/`). It
is ungated like the other three, a worker gets it in its bootstrap, and a
`.css` file written there is listed and applied like one the user put there:
the host watches the folder and every client re-reads its themes. Appearance
Kit's theme editor saves there.

A package with no `permissions` field asks for nothing, and a list that is
there is checked even when it is empty. A kit Tau ships declares its list like
any other package and is guarded like one — being bundled decides who has to
approve the list, not whether it is enforced. (A host extension constructed in
the host with no `permissions` property at all keeps the full, unguarded
facade; that is what the kits not yet moved to `kits/` still do.) Reaching a service member
the manifest did not ask for throws `Extension <id> lacks permission <name>`
and is logged as `host-extension.denied` (`guardedServices`, wraps
`HostExtensionServices`; the same check runs for a worker's calls, dispatched
into the identical guarded facade from the main side).

`network` gates one facade member, `services.network` (the host's own
listeners); dialling out asks the host for nothing, so for that the worker
enforces the grant itself instead — see §6. `process` is enforced in
both places: the facade members are guarded on the main side, and the worker
refuses `child_process` for itself. `native` gates no facade member; only the
worker enforces it. For an `in-process` package neither is
enforced, because a package running in the host process can reach everything
the host process can; that is what granting `in-process` means, and the
approval box says so in that many words.

### The window half

The host runs in its own process ([ADR 0021](adr/0021-host-runs-in-its-own-process.md)),
so it has no window: anything that needs one — a native view over a panel, a
dialog the OS draws — cannot be done there. A package that needs it names a
`window` entry. That module is compiled like a host half (CommonJS, `electron`
external) and loaded by the window's process, and it default-exports a factory:

```ts
import type { WindowExtension, WindowExtensionContext } from "tau/host-extension";

export default function activate(context: WindowExtensionContext): WindowExtension {
  return {
    handle(command, input) {
      if (command === "open") return openSomething(input);
      throw new Error(`no command "${command}"`);
    },
    dispose() { /* let the window's resources go */ },
  };
}
```

The host half reaches it with `services.callClient(command, input)`, which
resolves with whatever `handle` returned. The extension id is bound by the
window's registry, so a package can only call its own half. `context.invokeHost`
goes the other way, into the package's own host commands — that is how a view
reports that the page changed.

`context.loadDependency(packageName)` (new in API 1.12.0) is `services.loadDependency`
for this process: a module from Tau's own npm dependencies, by package name
only, resolved where npm put it. It is for a native addon that must act on the
machine the user sits at rather than the one the host runs on — SnapShots
reads the accessibility tree of a window this way. A half written for an older
Tau checks that the member exists.

A call goes to one window, never to every client
([ADR 0023](adr/0023-client-tokens-and-pairing.md)). While a command runs for a
client, `callClient` asks that client's own window; otherwise, and when that
client has no window with this half (a browser, a phone), it asks the Tau
window on the host's machine. With neither, the call rejects at once instead
of waiting for a timeout. A paired device is only ever asked for calls its own
requests caused.

Two options narrow that (new in API 1.13.0). `callClient(command, input, { window: "host" })`
asks only a Tau window on the host's own machine — the caller's, when it is
one, else the newest — never a window on another computer: use it for work on
what lives on the host, like a window an agent drives. `services.clientWindow()`
names the window such a call would reach now; pass that id as
`{ window: id }` and every later call goes to exactly that window, whichever
client or turn asks, or rejects at once with "The window this was pinned to
is gone." once it closed. A kit whose half holds a view pins it where the view
was made, so a panel on one device and an agent's tool in a turn reach the
same view. Preview Kit and Computer Use share `kits/_host-window/pinned-calls.ts`
for that: it pins on the first call and moves to the next window when the
pinned one is gone. `clientWindow` is absent before 1.13.0 and in a worker; an
older host ignores the options. `services.pickDirectory` is stricter: only the asking
client's window shows the dialog, so a browser or a phone gets a rejection,
not a dialog on the host's screen.

Two limits: an isolated (worker) package cannot use `callClient` at all, and a
host with no Tau window that runs the half (the browser client alone, a host
nobody is attached to) makes the call reject. One exception (new in API
1.15.0): a Linux service host with an invisible display (`tau service install
--display`) starts the Tau window on that display first, waits up to 60 s for
it to connect, then asks it; a call pinned to a window that is gone, or one
only the caller's own window may answer, never starts it. That window stops
after 10 minutes without a call, so a half should rebuild its view on the next
call rather than assume it is still there (Preview Kit's half does). Treat it as an optional
capability and say what is missing, the way Preview Kit answers "Preview needs
the Tau desktop app on this host".

### Isolation

`isolation` is `"worker"` (the default for a package) or `"in-process"`. See
§6 for exactly what each can and cannot do, and when to choose which.

## 2. A minimal example: `examples/hello-package/`

`examples/hello-package/` is a complete, working package: a manifest, a host
half that registers one command (`greet`) and one Pi tool (`hello_tau`), and a
desktop half that renders one status item — the smallest slot the workbench
offers (`registerStatusItem`, drawn in Pi's own footer, `StatusLine` in
`src/renderer/components/Regions.tsx`) — and calls the host command through
`context.host.invoke`.

```
examples/hello-package/
  tau-extension.json   # id, engines, permissions, isolation, entries
  package.json         # its own dependency, "typebox", for the tool's schema
  host.ts              # registerCommand("greet", …) + registerRuntimeExtension(…)
  desktop.tsx           # registerStatusItem(…) calling context.host.invoke("greet")
```

Because `hello_tau` needs `context.services.registerRuntimeExtension` — one of
the members a worker cannot reach — the manifest declares
`"isolation": "in-process"` and `"permissions": ["runtime:extend"]`. A package
that only needs `registerCommand` plus the plain-data worker services (like
`examples/desktop-extensions/hello-host.ts`) has no reason to leave the
default worker.

Try it in a real checkout:

```
/install /absolute/path/to/examples/hello-package -l
```

(`-l` installs it for the current project only, which Pi must trust; drop it
to install globally.) Approve it in Settings → Extensions, where it waits under
*Needs attention*; it starts as soon as you allow it. Copied out of this
repository, `tau kit types` in the folder gives it its editor types. The status item shows
"Say hello" in the footer; clicking it calls the host's `greet` command and shows the reply in its place. Prompting the agent with
something like "call hello_tau" makes it call the tool and answer with the
greeting.

### Types for a package of your own

Tau ships the types of `tau`, `tau/host` and `tau/host-extension` with the
app: `@tau/extension-api`, a folder of declarations at the extension API's
version. It is `extension-api/` among an installed Tau's resources, and
`dist-types/extension-api/` in a checkout after `npm run build`
(`node scripts/build-types.mjs` rebuilds it alone; `tau kit new` and
`tau kit types` run from a checkout rebuild it first, and say so when they
have to copy an older build). It carries the
declarations of React, csstype, lucide-react and Node that the API refers to,
each with its licence, so nothing needs installing. It is not on npm.

`tau kit new` copies it into a new package as `.tau-types/` and writes this
`tsconfig.json`; `tau kit types [folder]` copies it into a folder of your own
(an example you copied out of this repository, say), writes the same
`tsconfig.json` where there is none, and refreshes the copy after Tau was
updated:

```jsonc
{
  // Editor types only: Tau compiles the package itself.
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext", "moduleResolution": "Bundler", "jsx": "react-jsx",
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "typeRoots": ["./.tau-types/vendor/@types"], "types": ["node"],
    "paths": {
      "tau": ["./.tau-types/tau.d.ts"],
      "tau/host": ["./.tau-types/host.d.ts"],
      "tau/host-extension": ["./.tau-types/host-extension.d.ts"],
      "react": ["./.tau-types/vendor/react"],
      "react/*": ["./.tau-types/vendor/react/*"],
      "csstype": ["./.tau-types/vendor/csstype"],
      "lucide-react": ["./.tau-types/vendor/lucide-react/dist/lucide-react.d.ts"],
      "undici-types": ["./.tau-types/vendor/undici-types"]
    }
  },
  "include": ["*.ts", "*.tsx"]
}
```

`npx -p typescript tsc -p .` in the folder checks the package the way your
editor does. Types Tau does not carry (Pi's, for an in-process package that
registers a Pi tool; `typebox` in the example) come from the package's own
`package.json` and `npm install`, for the types and for Tau's bundler alike.
With `skipLibCheck`, a declaration of the API that refers to a package you did
not install reads as `any` instead of failing.

## 3. The workflow

**Commands**, typed in the composer (`tau.packages`, a kit Tau ships,
`kits/packages/`):

```
/install npm:@acme/hello          # the machine's own npm, into ~/.tau/npm
/install git:https://example.com/acme/hello.git   # a shallow clone into ~/.tau/git
/install ./extensions/hello -l    # a folder, loaded where it lies; -l is project-only
/update                           # every installed source, or name one
/update npm:@acme/hello
/remove npm:@acme/hello
```

The same four verbs live in Settings → Packages — the kit's own page, through
`registerSettingsPage` — with a source field, a global/project switch, live
progress lines while `install`/`update` run (they are host jobs —
`{ long: true }` — so they never block the rest of the workbench), and
Update/Remove buttons per row. The page lists the kits Tau ships — headed by
the distribution they arrived in — above the installed packages, and never
offers to remove one: shipping a kit is the approval, so it carries no grant
and no source to drop.

The kit manages packages while being one. A kit is loaded before any installed
package and is never re-imported by a rescan — the activator only touches what
it scanned from the package folders, and it refuses a package that claims a
kit's id — so `/install` can restart everything it just changed without
restarting itself.

**Approval.** Installing never activates a package — see §5. A package Tau has
not seen before, or whose permission list or isolation changed, shows in
Settings → Extensions as *waiting for approval* with the list it asks for;
**Allow** writes the grant and starts both halves, **Deny** leaves it off. Until approved, the
host half is never even imported, in either scope.

**`/reload`** applies changes to Tau itself: it runs Tau's build from its
source (a checkout Tau runs from or has open, or the source copy an installed
Tau keeps for edits to itself; about ten seconds), re-syncs packages, and
reloads the renderer or restarts the app as needed. A package never needs it:
installing, approving, trusting and saving take effect by themselves, and
**Rebuild extension packages** in the command palette (or *Rebuild* under
Settings → Packages → *Develop a package*) rebuilds and rescans the packages
alone, without building Tau.

**Global vs. project scope.** `~/.tau/extensions/<name>/` and
`~/.tau/packages.json` apply to every project; `<project>/.tau/extensions/<name>/`
and `<project>/.tau/packages.json` apply to one project — Pi's own `-l`
convention — and are only read where Pi already trusts that project (Pi's
trust decides whether the folder is read at all; the permission grant is a
separate, later gate).

**Where things live on disk:**

| What | Path |
|---|---|
| Global package folders | `~/.tau/extensions/<name>/` |
| Project package folders | `<project>/.tau/extensions/<name>/` |
| Global installed sources | `~/.tau/packages.json` |
| Project installed sources | `<project>/.tau/packages.json` |
| npm-installed packages | `~/.tau/npm/node_modules/<name>` (npm's own store, `npm install --prefix`) |
| Git-installed packages | `~/.tau/git/<host-and-path-flattened>/` |
| Permission grants | `~/.tau/extension-grants.json` |
| Trusted publisher keys | `~/.tau/trusted-publishers.json` |
| Compiled host bundle cache | a temp directory (`tmpdir()/tau-host-extensions` by default, keyed by content hash) |

`TAU_PACKAGES_HOME` moves every global row but the grants: set, the global
package folders, `packages.json`, the npm and Git stores and the trusted keys
live under `$TAU_PACKAGES_HOME/.tau/` instead of `~/.tau/`
(`TAU_EXTENSION_GRANTS_FILE` moves the grants). `npm run dev:instance` sets it
to `.tau-dev/packages-home`, so a global install in a test instance never
writes the real `~/.tau`.

A folder source is never copied — `/install ./my-extension` loads it where it
lies, which is also how you develop one: edit it in place and save.

### The development loop

The host watches the files it reads and reloads what changed. Save a file and
the change is in the app — no `/reload`, no restart:

| Edited | What happens |
|---|---|
| Anything in a package folder (`~/.tau/extensions/<name>/`, `<project>/.tau/extensions/<name>/`, a folder source in `packages.json`) | That one package is rebuilt and restarted. Its host half restarts only if its compiled code actually changed; its desktop module is swapped in place, so the rest of the workbench keeps running. A toast says *Reloaded &lt;name&gt;* |
| A loose file, `~/.tau/extensions/hello.tsx` | The same, under the id its path gives it (`local.hello`) |
| A kit under `kits/` in a checkout | Its desktop half is swapped. Its **host** half still needs `/reload` — a shipped kit is loaded once, before any package |
| A theme in `~/.tau/themes`, `<project>/.tau/themes`, `~/.pi/agent/themes`, `<project>/.pi/themes` | The client re-reads the themes and re-applies the active one; nothing else moves. A theme *package* (a folder that is only a stylesheet) goes the package route and swaps its `<link>` |
| `~/.pi/agent/keybindings.json` | The host reports the change; the Keybindings kit re-reads the file and rebinds |
| `~/.tau/config.json`, `<project>/.tau/config.json` | The client re-reads the config and applies it. Pi's own `settings.json` stays Pi's business |

Only the file that changed is acted on: a save in one package never restarts
another one's worker, and a theme edit touches no extension at all.

**A save that does not compile changes nothing.** The version that was running
stays running, and it counts as nothing — a reload failure is not a command
failure, so it can never add up to a deactivation. Fix the file, save again,
and the new version takes over. What esbuild reported reaches you whole, with
the file relative to the package, the line, the column and the source line:

```
desktop.tsx:12:7: Expected ";" but found "y"
  const x y = 1;
          ^
```

The toast (an error, 15 seconds) names the first error and copies all of them;
**Details** opens Settings → Diagnostics → Inspector, which shows them all under
*Did not build*, and the host log has the same lines. A host half that did not
compile is reported the same way. Settings → Packages → *Develop a package*
keeps the last build of each half of every installed package, with the time,
whether it built and every error, updated as you save; **Rebuild** rescans the
installed packages.

**A save that changes what the package asks for** — its `permissions` or its
`isolation` — stops it until you approve it again. The toast says *&lt;name&gt; is
waiting for approval*, with **Review** onto its page in Settings → Extensions.

The panels of a reloaded package remount, so whatever state they held is gone.
That is the price of swapping a module in place, and it is why only the package
you edited is swapped.

**Turning it off.** Settings → General → "Reload files when they change", or
`extensions.watch: false` in `~/.tau/config.json` (or
`<project>/.tau/config.json`), or `TAU_NO_WATCH=1` in the environment, stops
the host from watching anything; `/reload` then applies changes as before. The
switch applies at once; a hand edit of the file can turn watching off, but only
the switch (or a restart) turns it back on, since nothing watches the file then.
Safe mode (`TAU_NO_EXTENSIONS=1`) watches nothing either — it exists so that no
extension loads at all.

## 4. Signing

Signing is optional and proves the folder is the folder a publisher signed —
nothing about whether the publisher is trustworthy beyond your own decision to
trust their key.

```
node scripts/keygen-extension.mjs acme ~/keys        # writes acme.private.pem / acme.public.pem
node scripts/sign-extension.mjs ./hello ~/keys/acme.private.pem acme   # writes tau-extension.sig
```

`tau-extension.sig` sits beside the manifest:

```json
{
  "publisher": "acme",
  "algorithm": "ed25519",
  "signature": "<base64>",
  "files": { "tau-extension.json": "<sha256>", "host.ts": "<sha256>" }
}
```

`files` covers every file in the folder except `.git` and the signature file
itself; the signature is over the canonical JSON of `{ files, id, version }`
(sorted keys, no whitespace). A user trusts a publisher by adding their key to
`~/.tau/trusted-publishers.json`:

```json
{ "version": 1, "publishers": [{ "id": "acme", "name": "ACME", "key": "-----BEGIN PUBLIC KEY-----…" }] }
```

**What the user sees**, in Settings and in `/install`'s own reply
(`describeSignature` in `src/main/extension-signature.ts`):

| State | Shown as |
|---|---|
| No `tau-extension.sig` | **unsigned** |
| Signed, publisher not in `trusted-publishers.json` | **signature not trusted** |
| Signed, publisher trusted, hashes match | **signed by ACME** (the publisher's `name`, or its id) |
| A signed file's hash no longer matches | the package **refuses to load at all**, with the offending path in the error |

The hash check runs before the publisher's key is even looked up, so a
tampered file is caught whether or not anyone trusts the signer. An unsigned
or untrusted-signature package still installs and still runs (once granted) —
signing narrows what "this is the folder I built" means; it is not a gate on
its own. There is no revocation list: removing a key from
`trusted-publishers.json`, or removing the grant, is the whole mechanism.

## 5. Failure model

- **Command timeout:** a host command (one not marked `{ long: true }`) that
  does not resolve within **30 seconds** deactivates the package immediately —
  a single timeout is enough, not three.
- **Three strikes:** three consecutive **failures** (thrown errors, not
  timeouts) also deactivate the package. A success resets the counter to zero.
  Throw a `HostCommandError` (from `tau/host` in a worker, `tau/host-extension`
  in the host process) for bad input or a
  missing prerequisite — a path that is not a folder, npm not installed — and
  it reaches the caller like any error but neither counts nor resets; the
  flag survives a worker's port. Three typos must not switch a package off.
- **Worker heap cap:** a worker-isolated host half runs with a 256 MB old-space
  cap (plus a 32 MB young-generation cap); exceeding it, throwing, or exiting
  terminates the worker and deactivates the package with the reason recorded.
  A synchronous infinite loop inside a worker's command is also survivable —
  the worker that hangs is not the main process.
- **Worker buffer memory cap:** the heap cap does not count `ArrayBuffer`,
  typed array and `Buffer` memory, so the host watches that separately
  (V8's `external_memory` of the worker, read with
  `worker.getHeapStatistics()`). Above **512 MB** it terminates the worker and
  deactivates the package with "… exceeded its memory cap: N MB of buffers,
  cap 512 MB". `createWorkerHostExtension` takes another cap as
  `resourceLimits.maxExternalMb`. What it covers and what not:
  - It is sampled, not enforced at allocation. `getHeapStatistics` interrupts
    the worker's isolate, so it answers inside a synchronous allocation loop
    too. A shared 50 ms timer samples every worker whose event loop ran since
    the last tick, and each worker once a second regardless. A package that
    allocates faster than that overshoots by what it allocates in one tick:
    filling 4 MB `Uint8Array`s against a 64 MB cap, the tests measured
    150–200 MB on an M-series Mac and 64–144 MB in a two-CPU Linux container.
  - Not counted: `SharedArrayBuffer` memory (neither Node counts it),
    WebAssembly memory (Node 22 counts it; the Node 24 in Tau's Electron
    leaves it out of `external_memory`), and memory a native library or addon
    allocates. The host's memory limit below covers those.
  - An idle worker costs one local read of its event-loop utilization per
    tick and one sample a second; ten idle workers measured about 0.1 % of a
    core.
- **Host memory limit:** for memory no statistic of a worker counts, the host
  watches its own resident size (RSS). The limit is half the machine's memory,
  or half the container's limit where that is lower (`process.constrainedMemory()`).
  Each 50 ms tick the change in RSS is attributed to the threads that ran code
  in that tick — every worker package and the host's own thread — by their
  share of it. When RSS is at or past the limit, the host stops the worker
  package that grew it most, if that is at least 128 MB, with "… was stopped
  at the host's memory limit: it grew the host process by about N MB (R MB of
  L MB)", the same way as the caps above; it waits a second before it stops
  another. Why this and nothing finer:
  - WebAssembly memory is outside every per-isolate statistic of Electron's
    Node, and a `WebAssembly.Memory` maximum Tau set in the worker would miss
    a module's own memory and `memory.grow` from inside WebAssembly.
    `--wasm-max-mem-pages` is process-wide and per memory, not per package.
  - `SharedArrayBuffer` is counted only by the worker's own
    `process.memoryUsage().arrayBuffers`, which the host cannot read while the
    worker runs a synchronous loop.
  - Native memory has no per-thread number at all. A worker cannot call
    `services.loadDependency`, but with the `native` grant it can load a
    context-aware addon itself (`process.dlopen`, or a `.node` file its
    package ships). An addon, or `node:sqlite`, allocates with `malloc`,
    which only RSS sees.
  What it does not do:
  - Attribution is by activity, not by owner. A package that runs while the
    host's own thread or a thread Tau does not watch (libuv's pool, Pi's image
    worker) grows can be charged part of that growth. A package counts as
    grown only by what it grew while it ran, and what it gave back counts
    against it, so a package that sat idle while the host grew is not charged
    for it.
  - It is sampled, like the buffer cap. Native code that fills memory at
    memory speed can allocate several hundred MB inside one tick. Stopping
    the worker frees what its isolate held (buffers, WebAssembly and
    `SharedArrayBuffer` memory); what a native addon allocated and never
    freed stays in the process.
  - macOS counts pages the allocator already gave back in RSS until the
    system takes them, so after a large free a package's growth shows late
    there. RSS then overstates the process, so the limit is reached earlier,
    not later.
  - Under memory pressure the system compresses or swaps pages out as they
    are written, and they leave RSS. Memory that compresses well (a buffer
    filled with one value) can then grow by hundreds of MB without showing,
    and the package is not stopped; such pages cost the machine little.
    Pages the system takes from the process while a package runs count
    against that package, like its own frees.
  - In-process packages are not covered: they share the host's thread, so
    their growth is the host's own, and nothing can be stopped without
    stopping the host. A native addon loaded through `loadDependency` lives
    there. When the host passes its limit with no worker package to blame,
    it stops nothing.
- **Starting again:** a package that stopped while it ran — its worker died,
  hit a cap or the host's memory limit, a command timed out or failed three
  times — starts again on the next call to one of its commands (a page's
  "Try again" is such a call), and that call runs on the new start. If it
  stops again soon after, the next start waits 10 s, then 20 s, doubling up
  to 5 minutes; until then a call answers "Host extension … is not active."
  A package that ran for more than 5 minutes before it stopped starts again
  at once. One that failed to activate, or that the user turned off, is not
  started this way; `host-extension.restarting` in the host log names each
  start and why.
- **Compiled code in a worker:** a crash in native code is a crash of the host
  process, with every thread in it; no worker boundary catches a segfault. That
  is why a worker package loads no addon without the `native` grant (§6). A
  package that loads one at its top without the grant does not start: its
  settings page shows "Extension <id> lacks permission native".
- **A denied permission is not a failure:** reaching past the grant — a guarded
  service member, the network without `network`, an addon without `native` —
  throws inside the command and logs `host-extension.denied`, but the package
  stays active. Only the
  three-strikes rule above can turn repeated denials into a deactivation.
- **A failed reload is not a failure:** when a watched edit leaves a package
  that no longer parses or compiles, the version that is running stays
  running. The error is reported (toast, Settings → Inspector) and nothing is
  counted against the package — neither the three-strikes counter nor the
  timeout rule applies to code that never ran.
- **What the user sees:** the deactivation reason is recorded in
  `summaries()` and shown on the package's own settings page — never a crash
  or a frozen workbench. On the renderer side every slot a package renders
  (panel, sidebar item, status item, etc.) sits behind a `LazyFeatureBoundary`
  that deactivates the package and raises a toast instead of blanking the
  workbench on a render error. A chunk that failed to load is not the
  package's fault: it reloads the page once and leaves the package on.

## 6. What an isolated (worker) package cannot use

By default a package's host half runs in a worker thread: no Electron
(`import "electron"` throws), no network, no `child_process` and no compiled
code unless it asked for them, a 256 MB heap cap, a 512 MB buffer memory cap and the host's memory limit (§5), and a facade that only carries plain data across
the port — nothing that hands out a live object. From
`src/main/host-extension-worker-protocol.ts` and ADR 0009:

| Available in a worker | Not available — declare `"isolation": "in-process"` instead |
|---|---|
| `cwd`, `log`, `safeMode` | `attachedRuntime` (a live Pi terminal) |
| `openWorkspace`, `knownWorkspacePath`, `pickDirectory`, `workspaceRef`, `admitWorkspace` | `registerRuntimeBackend`, `registerRuntimeExtension`, `loadRuntimeExtension`, `loadDependency`, `mcp` |
| `projectName`, `rememberProjectName`, `describeProjects` (round trip) | `decorateUiPrompt`, `setPermissionLevel`, `presentUi` |
| `runtimeOwner`, `thread(sessionId)` (a plain snapshot), `transcript`, `setThreadTitle` | `sessions.open` (a live `HostSessionFile`), `sessions.prepare`, `sessions.refreshIndex`, `executionPolicy` (a provider is a live object) |
| `noteSubprocess`, `findCommand`, `skills` | a `beforeActivate` transaction (a worker hook returns nothing, so it cannot roll back an activation) |
| `clients.observe`, `clients.count` | |
| `refreshExtensionPackages` | `listPackages`, `installPackage`, `removePackage`, `updatePackages` (installing hands the host a live progress callback), `projectTrust`, `packageBuilds` |
| `sessions.list`, `sessions.read` (entries as data), `sessions.import`, `sessions.exclusive` | anything else that would hand out a live host object |
| `registerThreadLifecycle`, `registerTurnObserver`, `setPendingWork`, `pinTranscriptEntries` (pins as data) | |
| `sessions.remove`, `sessions.restore`, `sessions.trash`, `sessions.purge` | |
| `observeConfigChanges` (one change per call, plain data) | |

Everything on the left is asynchronous, even members that are synchronous
in-process (`cwd()`, `thread()`), because every call is a round trip over the
worker's message port. If your package needs anything on the right —
registering a Pi tool or extension, registering a runtime backend, presenting
Pi's own UI surfaces, or holding a live session handle — declare
`"isolation": "in-process"`. That is a privilege, not a permission, but it is
requested and granted exactly like one: it shows in the approval box next to
the permission list ("runs inside the host process, outside the worker
isolation") and is recorded in the grant, so a package that later leaves the
worker has to be approved again even if its permission list did not change.

### The network, processes and native code, in a worker

A worker meets a guardrail for whichever of `network`, `process` and `native`
its grant left out. Before the package's bundle is loaded,
`host-extension-worker.ts`

- replaces whichever of `fetch`, `WebSocket`, `EventSource` and
  `XMLHttpRequest` this Node defines on the worker global (without `network`);
- refuses `http`, `https`, `net`, `tls`, `dgram`, `http2`, `dns` and
  `inspector` (without `network`; `inspector.open` listens on a port) and
  `child_process`, `cluster` and `node:test` (without `process`; the last two
  start processes of their own) — under any `node:` prefix and any submodule,
  so `node:dns/promises` is the same door as `dns`;
- refuses compiled code (without `native`): `process.dlopen`, the `.node`
  handler behind `require` (so a `.node` file, or a helper such as `bindings`
  or `node-gyp-build` that requires one, is refused with its path), an
  `import` that resolves to a `.node` file, `DatabaseSync#loadExtension` of
  `node:sqlite` (a SQLite extension is a shared library), `process.binding`
  and `process._linkedBinding` (the raw handles behind the socket, spawn and
  Electron modules, which walk around the other two grants) and
  `v8.setFlagsFromString` (V8 flags are process-wide, and one of them enables
  intrinsics that abort the process). `node:sqlite` itself stays available;
- refuses `worker_threads` while any of the three grants is still missing,
  because a nested worker runs outside every guard and would hand the package
  back whatever it asked for;
- refuses `electron` always: it only exists in the main process.

These hold for `require`, `import()` and `process.getBuiltinModule` alike. Each
throws `Extension <id> lacks permission <name>` (the nested worker says why it
is refused instead) and logs `host-extension.denied` with what was asked for —
`process.dlopen("/path/addon.node")`, `require("/path/addon.node")` — so the
Inspector and Signals show a denied socket, spawn or addon exactly like a
denied service member.

`native` is the widest of the three. Compiled code is not held by anything
here: it can open sockets and start processes without asking, allocates
memory no cap counts (§5), and takes the host down with every thread when it
crashes. A package that needs it — a database driver, a pty, anything built
with `node-gyp` — lists it, and the approval box says what it means beside
the name. No kit Tau ships as a worker needs it; the ones with addons (Terminal
Kit's `node-pty`) run `in-process` and load them through
`services.loadDependency`. A bundled `ws` or `undici` needs `net`/`tls` and hits
the same wall. The grant does not do the host's bookkeeping for you: a package
that spawns still calls `noteSubprocess` itself.

Two interceptions are installed, because neither covers the other:
`Module._load`, which is what `require` goes through, and
`module.registerHooks`, which is what `import()` goes through (and which sees
`require` as well). `await import("node:https")` used to walk straight past the
first one; it does not any more.

**This is still a guardrail, not an OS-level boundary.** A package holds
`node:module` like any other Node code and can put both hooks back the way it
found them (the native doors are the exception: the worker keeps no copy of
`process.dlopen` or `process.binding` to put back); it reads and writes files either way, and an `in-process` package
meets nothing at all. What the worker gives you is crash containment, a heap
cap and a wall a mistake runs into — not a sandbox against hostile code.
[ADR 0018](adr/0018-sandboxed-host-extensions.md) collects what a real boundary
would cost. Install only host packages whose code you trust.

An `in-process` package is a different story. It runs with everything the host
process can reach, so none of the three is enforced there — the approval box says
"runs inside the host process; permissions are not enforced there" rather than
naming one of them. If you rely on a package not reaching the network, not
spawning anything or not loading native code, do not grant it `in-process`.

Electron works the same way round. An `in-process` host half may
`import { BrowserWindow } from "electron"` — the host bundler keeps `electron`
and the `node:*` builtins external and the main process resolves them, so no
seam hands the module out and none has to. That is how `kits/preview/view.ts`
gets its `WebContentsView` and the window to hang it on. Keep the import
dynamic, behind a `process.versions.electron` check, if the package also has to
work on a host without a window.

A kit Tau ships chooses the same way and for the same reasons: most declare
`in-process`, because they register runtime backends and Pi extensions, hand
out session managers or take part in the activation transaction, none of which
the worker table above can carry. The difference is only that nobody is asked
to approve it (ADR 0014).

## 7. Testing a package locally

`npm run smoke:extension-install` is the end-to-end test of the installer
path: keygen, sign, install a folder and a Git source into a temp home, list
them, run the signed package's host half in its worker (one command inside its
grant, one that dials out without `network` and is refused), tamper with a
signed file and watch the scan refuse it, then remove both. It needs `npm run build` first (it imports the compiled main modules
from `dist-electron/main`). Run it as-is to see the whole install/sign/verify
path exercised without opening Tau at all:

```
npm run build
npm run smoke:extension-install
```

Its fixture is generated inline (`writePackage` in
`scripts/extension-install-smoke.mjs`) rather than checked into the repo — it
writes a manifest and a two-command host half to a temp directory, signs it,
and drives it through `installExtensionSource`, `listExtensionPackages` and
`loadHostExtensionPackages` directly, including running its worker and
invoking a command. Read it for the lowest-level API surface (no Electron, no
UI) a package goes through.

To test interactively in the running app, `/install <path to your package>`
(`-l` for project scope), approve it in Settings → Extensions, and use it; no
`/reload` is needed. This is how `examples/hello-package` was verified for this
document. In a test instance of a checkout (`npm run dev:instance`), a global
install lands in `.tau-dev/packages-home/.tau/`, never in your own `~/.tau`.


## 8. Themes: the tokens a theme may set

A package whose manifest names `styles` and neither `desktop` nor `host` is a
**theme**. It brings CSS and no code, so it declares no `permissions` and no
`isolation` — the manifest refuses both — and there is nothing for the user to
approve: `/install` applies it there and then, `/remove` takes it back off, and
neither needs a reload. Settings → Packages marks the row "Theme"; the switch
beside it turns the stylesheet off and on like any other extension's.

```json
{
  "id": "acme.midnight",
  "name": "Midnight",
  "version": "1.0.0",
  "engines": { "api": "^1.3.0" },
  "styles": "./theme.css"
}
```

Its stylesheet is served over `tau-ext://` and linked **last**: after core's
`tokens.css`, which `index.html` links before anything else, and after every
kit's own stylesheet. Order is the whole of the precedence — a theme sets a
name again at the same specificity and wins because it comes later, so no theme
ever needs `!important` or a deeper selector.

### The two token sets, and how one is chosen

`src/renderer/tokens.css` declares each token once, as
`light-dark(light, dark)`; the used `color-scheme` picks the side. `data-theme`
on `<html>` sets that: `system` (the default, and what the document ships with,
so the OS decides the first paint), `dark` or `light`. The preference lives in
Settings → Appearance → Mode (Settings → General → Theme without that page) and in the
palette ("Theme: …", "Cycle the theme"); the client writes it onto `<html>` and
nothing else in the client ever reads a colour.

Besides theme packages, a **user theme** is a `.css` (or `.json`) file in
`~/.tau/themes/` or a project's `.tau/themes/`; choosing it as the preference
applies it whole. Appearance Kit adds a theme per scheme on top: under System,
Light and Dark it lays the chosen light theme's tokens over the light scheme and
the dark theme's over the dark one, and its theme editor and VS Code importer
write such files.

A theme writes `light-dark()` too if it means both schemes, or a single colour
if it means one:

```css
:root {
  --acid: light-dark(#d2603a, #ff9d6b);   /* the accent as a fill */
  --acid-text: light-dark(#9a3d18, #ff9d6b); /* the accent as ink on a surface */
  --mono: "IBM Plex Mono", ui-monospace, monospace;
}
```

`examples/theme-terracotta/` is that example in full: a manifest, one
stylesheet, a new accent and a new code face. Two more sit beside it:
`examples/theme-mono-labels/` sets the four label tokens back to the
monospace capitals Tau's labels had before API 1.11.0 (label texts are written
in sentence case, so `--label-case: uppercase` is all it takes), and
`examples/theme-zinc/` lays zinc greys, an indigo primary and smaller radii
over the tokens, for telling a difference of colour from one of layout.

### The table

These names are the contract, and the only one: no layout class is API. A theme
that restyles `.thread-row` or `.panel-body` is reaching past the seam and will
break — core's class vocabulary is documented in [CORE.md](CORE.md) to be used,
not overridden.

Two rules keep the table honest, both checked by `src/renderer/tokens.test.ts`:
no colour may be written anywhere but `tokens.css` (kit stylesheets included),
and every token that carries text must reach WCAG AA — 4.5:1 on the eight
surfaces text is read on, in **both** schemes; marks, fills (the accent among
them) and small print reach 3:1, and each ink reaches 4.5:1 on the fill it sits
on (the accent, the user's bubble, a diff line). A theme is not held to that automatically, so check your own values.

**Surfaces**

Two grounds carry the window: the document area (`--stage`, `--shell`) and the side surface (`--rail`, `--chrome`, `--field`, `--inset`), which in the dark scheme is the lighter of the two. The sidebar and the stage's tab strip lie on the side surface and run to the window's top edge; the conversation, its header and the tab in front lie on the document's ground.

| Token | Role | Light | Dark |
|---|---|---|---|
| `--well` | deepest: an inset control | `#e8e5e0` | `#0f1116` |
| `--shell` | the window | `#fbfaf8` | `#0f1116` |
| `--rail` | the sidebar | `#f0eeea` | `#171a1f` |
| `--chrome` | panel chrome | `#f0eeea` | `#171a1f` |
| `--stage` | the document area and panel bodies | `#fbfaf8` | `#0f1116` |
| `--sunken` | a well inside a surface | `#f4f2ef` | `#13161b` |
| `--field` | an input, and the composer: filled, no edge | `#f0eeea` | `#171a1f` |
| `--thread-active` | the selected thread row | `#fbfaf8` | `#0f1116` |
| `--raised` | a chip or inline code | `#e1dfdb` | `#24272c` |
| `--raised-strong` | a raised surface that is hovered or floating | `#dbd9d5` | `#2a2c31` |
| `--raised-hover` | the hover of a raised control | `#d2d0cd` | `#313439` |
| `--overlay` | a modal panel | `#fbfaf8` | `#191c21` |
| `--float` | a menu, a toast, a popover card | `#fbfaf8` | `#191c21` |
| `--hover` | the wash under a hovered row | `#e8e6e2` | `#1f2226` |
| `--hover-strong` | the same, in a list that needs to read | `#e3e1dd` | `#23252a` |
| `--code-bg` | code blocks, tool output, diffs | `#f0eeea` | `#171a1f` |
| `--inset` | a block inside a settings page | `#f0eeea` | `#171a1f` |
| `--chip` | a small label's background | `#e8e5e0` | `#23252a` |
| `--chip-hover` | a small label, hovered | `#d8d4cd` | `#2e3136` |
| `--track` | an empty progress track | `#d8d4cd` | `#2e3136` |
| `--scrim` | the dim behind a modal | `#1c1b19a3` | `#050608e0` |
| `--scrim-deep` | the dim behind a full-screen image, dark in either scheme | `#0e0e0df0` | `#0e0e0df0` |
| `--term` | the terminal's ground, a step under the dark one and so dark in either scheme | `#0a0b0e` | `#0a0b0e` |
| `--media` | the ground of a full-window picture viewer (the lightbox, Evidence's viewer), dark in either scheme so pictures read true | `#0e0e0d` | `#0e0e0d` |
| `--media-ink` | text on it | `#f1efeb` | `#f1efeb` |
| `--media-muted` | secondary text on it | `#f1efeb8c` | `#f1efeb8c` |
| `--media-faint` | times and small print on it | `#f1efeb73` | `#f1efeb73` |
| `--media-control` | a round control beside a picture | `#ffffff1f` | `#ffffff1f` |
| `--media-shade` | a round control on a picture | `#0000008c` | `#0000008c` |
| `--media-hover` | a control on it, hovered | `#ffffff14` | `#ffffff14` |
| `--media-well` | where a picture loads | `#2a2926` | `#2a2926` |
| `--drop-card` | the card in a drag-and-drop overlay | `#fbfaf8ee` | `#191c21ee` |

**Hairlines**

The design's divider is the ink at a low alpha, so one hairline reads on either ground; the two focus and hover edges are opaque.

| Token | Role | Light | Dark |
|---|---|---|---|
| `--line` | the ordinary hairline | `#1c1b1917` | `#e3e6ec1a` |
| `--line-soft` | a hairline that should barely show | `#1c1b190f` | `#e3e6ec12` |
| `--line-inset` | between rows of one list | `#1c1b1912` | `#e3e6ec14` |
| `--line-card` | the edge of a card | `#1c1b191a` | `#e3e6ec1c` |
| `--line-control` | the edge of a button or chip | `#1c1b191f` | `#e3e6ec21` |
| `--line-strong` | an edge that has to be read as one | `#1c1b192e` | `#e3e6ec2e` |
| `--line-field` | the edge of an input | `#1c1b1929` | `#e3e6ec29` |
| `--line-focus` | a field with focus inside it | `#b7b1a8` | `#45484d` |
| `--line-float` | a menu or popover edge | `#1c1b191f` | `#e3e6ec21` |
| `--line-hover` | a control's edge while hovered | `#b7b1a8` | `#45484d` |
| `--edge-highlight` | the inner top edge of a raised surface | `#ffffffcc` | `#ffffff08` |
| `--edge-highlight-strong` | the same, on a round control | `#ffffff` | `#ffffff26` |
| `--edge-line` | the edge of a selected row | `#1c1b1914` | `#e3e6ec0f` |
| `--wash` | a fill barely above its surface | `#1c1b1908` | `#e3e6ec05` |
| `--wash-2` | the same, one step up | `#1c1b190f` | `#e3e6ec0c` |

**Ink**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--ink` | headings and emphasis | `#1c1b19` | `#e3e6ec` |
| `--ink-prose` | assistant prose | `#1c1b19` | `#e3e6ec` |
| `--ink-2` | body text of the chrome | `#35312c` | `#d0d4db` |
| `--ink-3` | secondary text | `#504a43` | `#b3b8c1` |
| `--ink-code` | code and diff bodies | `#433e38` | `#c2c6ce` |
| `--muted` | labels | `#6d665d` | `#9197a1` |
| `--muted-2` | small print | `#8f887e` | `#71767f` |
| `--faint` | glyphs and disabled text | `#8f887e` | `#71767f` |
| `--fainter` | a mark that is only a hint of one | `#b7b1a8` | `#45484d` |
| `--scrollbar` | the scrollbar thumb | `#d8d4cd` | `#2e3136` |
| `--scrollbar-hover` | the same, hovered | `#b7b1a8` | `#45484d` |

**Accent**

Blue, and only for Tau's own actions and selection (send, a primary button, focus, the picked row) and the user's own message. The Tau mark is the same family of blue, in its own tokens (`--brand`): the app icon, the reload curtain and the onboarding mark, never a control.

| Token | Role | Light | Dark |
|---|---|---|---|
| `--acid` | the accent as a fill | `#4b75c5` | `#6b93e0` |
| `--acid-text` | the accent as text or an icon on a surface | `#2f4f8f` | `#a6bfee` |
| `--acid-ink` | text on the accent fill | `#ffffff` | `#10131a` |
| `--acid-strong` | the accent fill, hovered | `#3d63b0` | `#86a7e7` |
| `--acid-bg` | the accent as a surface | `#e9effa` | `#121d36` |
| `--acid-line` | the accent as an edge | `#b4c8ee` | `#2c4478` |
| `--acid-chip` | the accent as a chip behind accent text | `#d4e0f6` | `#19284c` |
| `--acid-track` | the accent as a filled track | `#80a1dd` | `#3a5ca3` |
| `--acid-glow` | the accent as a glow around a mark | `#4f79c9bb` | `#6b93e0bb` |
| `--focus` | the focus ring | `#4f79c9` | `#6b93e0` |
| `--user-bubble` | the user's own message: the accent's tint | `#e9effa` | `#121d36` |
| `--user-bubble-ink` | its text | `#182747` | `#e2eafa` |
| `--brand` | the Tau mark's plate | `#4f79c9` | `#6b93e0` |
| `--brand-on` | the τ on the plate | `#fbfaf8` | `#0f1116` |
| `--brand-ink` | the mark's blue as text on a surface | `#3d63b0` | `#6b93e0` |

**Status**

A run in flight is blue (`--info`, `--info-ink`), a question amber (`--warn`), a finished run green (`--ready`, `--done`), a failure red. `--working` names a file a turn changed and a write, not a run.

| Token | Role | Light | Dark |
|---|---|---|---|
| `--working` | a file a turn changed; a write | `#a34a08` | `#ff8a4d` |
| `--ready` | a run that finished | `#2f633c` | `#a4d0b1` |
| `--removed` | something taken away | `#8c352f` | `#eba9a2` |
| `--stop` | the abort control | `#c2282d` | `#e5484d` |
| `--stop-ink` | the square on the stop button | `#ffffff` | `#ffffff` |
| `--qr-paper` | a QR code's light modules: scanners want dark on light in either scheme | `#ffffff` | `#ffffff` |
| `--qr-ink` | its dark modules | `#000000` | `#000000` |
| `--cyan` | numbers and types | `#06706c` | `#6fd3cf` |
| `--danger` | destructive text | `#8c352f` | `#eba9a2` |
| `--danger-line` | the edge of a destructive control | `#edb0a8` | `#6b352f` |
| `--danger-bg` | that control, hovered | `#fbe9e7` | `#301613` |
| `--warn` | a caution, and a question waiting for the user | `#82601a` | `#e8c67f` |
| `--warn-chip` | a caution as a chip | `#fcf3dc` | `#291e05` |
| `--fail` | a failed run's mark | `#c9564d` | `#d9756b` |
| `--fail-ink` | what that run says | `#8c352f` | `#eba9a2` |
| `--info` | a run or a step in progress | `#4f79c9` | `#6b93e0` |
| `--info-deep` | a step already done, in a dense bar | `#3d63b0` | `#86a7e7` |
| `--info-ink` | the same, as text | `#2f4f8f` | `#a6bfee` |
| `--merged` | a merged pull or merge request | `#7446c2` | `#b59cf2` |
| `--done` | a step that finished | `#4f9660` | `#6fae82` |
| `--stale` | how long ago something ran | `#8a5a3f` | `#c9a18b` |
| `--folder` | a directory | `#6f6118` | `#a59d68` |

**Providers**

A provider's own colour, for its share in a chart or a limit bar; never a state.

| Token | Role | Light | Dark |
|---|---|---|---|
| `--provider-openai` | OpenAI, ChatGPT, Codex | `#2a62c4` | `#6ea6f7` |
| `--provider-anthropic` | Anthropic, Claude | `#b3572f` | `#e5936a` |
| `--provider-google` | Google, Gemini, Antigravity | `#237a52` | `#5fc28f` |
| `--provider-pi` | Pi, across its providers | `#7a4fc4` | `#ae93f0` |
| `--provider-other` | any other provider or runtime | `#6f6a5c` | `#9ea3ad` |

**Diff**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--diff-add-bg` | an added line | `#e6f2e8` | `#122016` |
| `--diff-add-ink` | its text | `#2f633c` | `#a4d0b1` |
| `--diff-add-mark` | the changed run inside an added line | `#a9d1b1` | `#2e4d38` |
| `--diff-add-mark-ink` | the run's text | `#17301d` | `#e1f1e5` |
| `--diff-add-mark-line` | the run's edge | `#4f9660` | `#6fae82` |
| `--diff-del-bg` | a removed line | `#fbe9e7` | `#301613` |
| `--diff-del-ink` | its text | `#8c352f` | `#eba9a2` |
| `--diff-del-mark` | the changed run inside a removed line | `#edb0a8` | `#6b352f` |
| `--diff-del-mark-ink` | the run's text | `#431a17` | `#fae6e3` |
| `--diff-del-mark-line` | the run's edge | `#c9564d` | `#d9756b` |
| `--diff-add-edge` | an addition as a bar, a sign or a count | `#2f633c` | `#a4d0b1` |
| `--diff-del-edge` | a removal as a bar, a sign or a count | `#8c352f` | `#eba9a2` |
| `--syntax-fn` | highlight.js function and class names | `#5c6b13` | `#d9e88f` |

**Project and reload curtain**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--project-tint` | a project's mark (declared on `.thread-project-icon`) | `hsl(var(--project-hue) 46% 88%)` | `hsl(var(--project-hue) 34% 15%)` |
| `--project-ink` | its letters | `hsl(var(--project-hue) 55% 27%)` | `hsl(var(--project-hue) 70% 66%)` |
| `--reload-core` | the centre of the reload curtain | `#dfe7f6` | `#172136` |
| `--reload-halo` | its falloff | `#eef2f9` | `#11141b` |
| `--reload-panel` | the panel inside it | `#f2f5fa` | `#13171e` |

**Shadows**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--shadow-soft` | a small float | `#1c1b1914` | `#00000066` |
| `--shadow` | a menu or a toast | `#1c1b191a` | `#00000073` |
| `--shadow-strong` | a modal | `#1c1b192e` | `#0000008c` |

**Type, size, motion**

Figtree (400–700, a variable face under the SIL Open Font License, `src/renderer/assets/fonts/figtree/`) ships with Tau and loads from its own files, never from a font server; the system stack is its fallback. Code and the terminal keep `--mono`.

The type scale is one size per text role and device class ([ADR 0029](adr/0029-type-scale-per-device-class.md)): the values below are a desktop's, the design's; `data-device="tablet"` and `"phone"` on `<html>` set the `--type-*` bases larger (the ADR has the table). Each `--text-*` is its base times `--text-scale`, the system's text size on a touch device, plus `--text-step`, Tau's own Text size; a kit reads the `--text-*` tokens and never a pixel size, and sizes a row that holds text with `min-height` or `em` so a larger text size never cuts it.

| Token | Role | Value |
|---|---|---|
| `--elevation-0` | a control that sits on its surface | `0 1px 2px var(--shadow-soft)` |
| `--elevation-1` | a small float | `0 3px 10px var(--shadow)` |
| `--elevation-2` | a menu, a toast, a popover | `0 12px 32px var(--shadow-strong)` |
| `--elevation-3` | a modal | `0 12px 32px var(--shadow-strong)` |
| `--mono` | code and numbers | `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace` |
| `--sans` | everything else | `"Figtree", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` |
| `--label-font` | a section or status label | `var(--sans)` |
| `--label-case` | its text-transform | `none` |
| `--label-tracking` | its letter-spacing | `normal` |
| `--label-size` | its size | `var(--text-xs)` |
| `--text-xs` | meta: a branch, an age, a status | `12px` (tablet 12, phone 13) |
| `--text-sm` | a control, a chip, a menu | `13px` (tablet 13, phone 14) |
| `--text-md` | body and a thread's title | `14px` (tablet 15, phone 16) |
| `--text-lg` | a row that leads a sheet or a menu | `15px` (tablet 16, phone 17) |
| `--text-title` | a thread's heading | `17px` |
| `--text-display` | a page's heading; no Text size step | `24px` (phone 27) |
| `--text-code` | code, a diff, a file tree | `13px` (tablet 13, phone 14) |
| `--text-input` | what the user types; never under 16px on a touch device, where iOS would zoom | `14px` (tablet and phone 16) |
| `--text-scale` | the system's text size on a touch device, 1–1.5 (`type-scale.ts`) | `1` |
| `--text-step` | Tau's own Text size (Appearance Kit): `-1px`, `0px`, `1px` | `0px` |
| `--touch-target` | the least a finger needs, grown with `--text-scale` | `calc(44px * var(--text-scale))` |
| `--radius-xs` | a tag | `4px` |
| `--radius-sm` | a button or a chip | `6px` |
| `--radius-row` | a row, a field, a footer button | `8px` |
| `--radius-md` | a card or a popover | `10px` |
| `--radius-lg` | a panel, the composer | `12px` |
| `--radius-xl` | a modal | `16px` |
| `--radius-pill` | a pill or a knob | `999px` |
| `--control-pill-height` | one pill of that row; 36px in compact | `32px` |
| `--control-pill-icon` | its icon | `14px` |
| `--motion-fast` | a hover or a chevron | `120ms` |
| `--motion` | a row or a card arriving | `180ms` |
| `--motion-slow` | a curtain | `320ms` |
| `--ease` | the curve all three use | `cubic-bezier(.4, 0, .2, 1)` |

**Spacing**

One scale, multiplied by `--density` (`1` in `tokens.css`). A client may set
`--density` on `<html>` — Appearance Kit does through `data-density`: compact
`.8`, comfortable `1.2` — and every step follows; unset, each step is its pixel
value. A value between two steps is written `calc(Npx * var(--density))`.

| Token | Role | Value |
|---|---|---|
| `--density` | the multiplier | `1` |
| `--space-1` | a hairline gap | `2px` |
| `--space-2` | between a glyph and its label | `4px` |
| `--space-3` | inside a chip | `6px` |
| `--space-4` | between rows of a list | `8px` |
| `--space-5` | inside a row | `12px` |
| `--space-6` | inside a card | `16px` |
| `--space-7` | around a page | `24px` |
| `--space-8` | between sections | `32px` |

So far the structural spacing reads the scale: the thread rail and its search
(Workspace Kit), the thread row, the transcript's padding, the conversation and
panel headers, the composer, and the whole Settings screen. Detail rules keep
their pixels until a visual pass moves them.

**Set on `<html>` by a client, not by a theme**

| Name | What reads it | Unset |
|---|---|---|
| `--font-family-override`, `--font-size-override` | the interface face and size (core's preferences) | Figtree (`--sans`), `13px` |
| `--prompt-font-family`, `--prompt-font-size` | the composer's text | the interface face, `13px` |
| `--code-font-family`, `--code-font-scale` | code blocks, tool output, the file view and diffs | `--mono`, `1` |
| `data-density` | Appearance Kit's stylesheet, into `--density` | normal |
| `data-timestamps` | message and tool timestamps: `12h`, `24h` or `locale` | 24-hour |
| `--panel-motion` | how long the drawer takes to open; never while a divider is dragged or the system asks for reduced motion | `0ms` |

`--project-hue` is not a token: the thread row sets it per project, and
`--project-tint` and `--project-ink` say how deep that hue reads. Both are
declared on `.thread-project-icon`, not on `:root`, because a custom property's
`var()` resolves where it is declared; a theme overrides them on that selector. The same goes
for the handful of layout variables a component sets on itself
(`--keep-clear-x`, `--composer-inset`, `--used`).
