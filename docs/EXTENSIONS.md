# Writing a Tau package

This is the entry document for anyone writing a Tau extension package. It
follows the code, not the aspiration; where the code and an ADR disagreed
while writing this, a footnote says so.

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
internals and quietly stops working), so a package brings its own dependencies
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

`when` (new in API 1.10.0) says where a chord applies, as in VS Code and T3
Code: context names joined by `!`, `&&`, `||` and parentheses, e.g.
`"terminalFocus && !stageFocus"`; `true` and `false` are constants. Contexts
come from the page when the key goes down. Mark an element
`data-keybinding-context="<name>"` (several names may be space-separated) and
`<name>Focus` holds while the keyboard is inside it, `<name>Open` while one is
drawn (`src/renderer/keybinding-context.ts`). Core marks `composer`, `stage`
and `modelPicker`; Terminal Kit marks `terminal`, Files Kit's editor `editor`
and Preview Kit's panel `preview`. `editableFocus` (new in API 1.11.0) is the
one context nothing marks: it holds while a text field, a select or anything
`contenteditable` has the keyboard, so a chord native editing shares yields to
it — Thread Rail's `mod+z` is `"!terminalFocus && !editableFocus"`, as in T3
Code. A clause Tau cannot read throws at registration.

A clause that needs a context — false when nothing is focused or open, like
`terminalFocus` but unlike `!terminalFocus` — makes the binding *specific*. On
a keydown, of the bindings whose chord and clause match, a config.json
override beats a replacing binding beats a default; within that, a specific
one beats one that is not; then the first registered wins. A specific winner
runs in the capture phase, before the focused element sees the key: that is
how Terminal Kit's `mod+d` reaches its command before xterm, and Files Kit's
`mod+s` saves the editor tab before Prompt Tools' stash could hear it. Every
other binding waits for the bubble phase, so a field or a shell that handled a
key (`preventDefault()`) keeps it. Two bindings conflict only when they press
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
Delete are the shipped callers, with Snooze in the tray as in T3 Code.
On a device paired Read only, the thread surfaces (the title menu, the compact
list's sheet and tray) disable a command with the reason unless it declares
`access: "read"` (new in API 1.13.0): running it changes nothing on the host.
Workspace Kit's "Copy branch" declares it.

`registerPanel` takes `Icon`, a component of your own (`{ size?: number }`) —
`lucide-react` is a shared module, so a package draws its glyph from the set
the workbench itself uses, and core no longer keeps a table of names it would
have to know a kit by. A panel without one gets core's fallback glyph.
`registerSettingsPage` takes the same `Icon`.

#### Where a panel shows: dock, drawer, stage (new in API 1.11.0)

A panel shows in the dock on the right unless it asks for `placement:
"drawer"`: then it draws below the conversation and the stage, full width,
and the title bar gets a toggle for it instead of a rail button. One drawer
panel shows at a time. The drawer starts at 280 px, is dragged or moved with
the arrow keys from its top edge, and its height (180 px up to three quarters
of the window) is kept per client. Terminal Kit's "Show the terminal in"
setting registers its panel again with the other placement.

`maximizable: true` lets the user move the panel into a stage tab beside the
chat: the button over the end of the panel's header, or
`rightPanel.toggleMaximized` (`mod+alt+shift+b`), which acts on the panel tab
in front, else the panel the keyboard is in, else the dock's, else the
drawer's. Core moves the *mounted* panel — its DOM host goes from dock to
stage and back — so React state, scroll and a terminal's buffer go with it,
and the panel is never drawn twice: the dock shows a stand-in with "Show tab"
and "Move back here" while it is away. Closing the tab, or the same command
again, puts it back where it was placed. The tab is a core kind
(`StagePanelTab`, `kind: "panel"`, `panelId`) and is restored with the stage.

`PanelProps.placement` says where the panel is drawn now (`dock`, `drawer` or
`stage`); a panel that positions something outside the page, as Preview Kit's
native view does, reports its bounds again when it changes. `active` is false
while the panel's tab is behind another. `actions.openPanel(id)` shows a panel
wherever it is, bringing its tab forward when it is maximized;
`actions.closePanel(id)` hides it (the dock or drawer closes, or the tab);
`actions.togglePanelMaximized()` is the command's action.

#### Tool rows and tool cards

`registerToolRenderer(id, match, render)` says how one tool call reads: its
glyph, title, tone and detail. `ToolPresentation` also takes an optional
`source` — what the tool reaches, a browser, a machine, an MCP server. A group
summary hoists a named source to the front of its sentence ("Used the browser
3 times and read 2 files") instead of counting those calls as anonymous tools;
core reads `mcp__<server>__<tool>` as a source by itself, because that spelling
is the protocol's, not a kit's.

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
`actions.stageTabs()` lists what is on the stage. **`params` is plain JSON and
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

The tab strip's own gestures are core's: double-click pins a preview, the
middle button and Escape close, `mod+w` closes the active tab, `ctrl+tab` and
`ctrl+shift+tab` move through them, and the right-click menu offers close,
close others, close to the right and pin/unpin. `examples/desktop-extensions/hello-stage-tab.tsx`
is the whole of the above as one file; Terminal Kit's "open as tab" is the
shipped caller, and Review Kit's pull-request view (`review.pull-request`,
params `{ url, number, service, workspace? }`) the second.

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
| `takeFiles` | Offered every file of a drop, a paste or the attach button before core; answers with the files it left, which core treats as images. While any contribution takes files, the attach button accepts any type and the thread-wide drop overlay lets any file through — the contribution checks its own limits. |
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
start, once the host is back (`host-connection` below). The kit's own limits
are T3 Code's: eight attachments a message, 10 MB an image (an image goes to
core as an image whenever the model sees images), 50 MB any other file, and a
paste from 32 KiB on becomes `pasted-text-<n>.txt` with a chip — removing the
chip is the undo. A file travels to the host in 4 MiB pieces, so a 50 MB one
stays under the host socket's 64 MiB frame.

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
runtime's default. Answer `true` and core draws `Component` over a backdrop,
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
under the list, shown while any listed model wears the badge.

`registerRegion({ placement: "thread-title", … })` draws before the thread's
title in the conversation header — a mark about the thread on screen, which
reads the `snapshot` it is given. The other placements are `title-bar`,
`composer-above`, `composer-below`, `transcript-header` and
`transcript-footer`.

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
non-empty query. `search` may answer at once or with a promise; `index` is the
thread index this window holds (`projects`, `threads`, `activeThreadId`), and
`signal` aborts as soon as the query changes or the palette closes. An answer
that arrives after that is dropped, so a slow source never paints rows for a
query the user already left; a source that talks to its host half should wait
a moment on the signal before it asks. A row is `{ id, label, detail?, run }`:
`detail` is shown after the label, the source's `label` beside it.

What the list shows, in order: commands whose label matches, then every
source's rows in `order` (eight at most each), then core's own Settings rows —
a page or a row of one found by the words Settings search uses — and last the
commands that matched only by their group. An empty query lists the commands
alone. Search Kit (`kits/search/`) is the shipped caller: threads by title and
by what was said in them, and projects.

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
`current: true`, which the row shows as "Current". An `items` that throws
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
is a screen of its own (a sidebar on a tablet) and diffs do not split. A panel
that claims `compact` is not docked there: its glyph sits in the title bar and
opens the panel as a sheet over the thread, with `placement` reading `stage`.
`actions.openPanel(id)` and `actions.closePanel(id)` open and close that sheet
there (API 1.13.0), so a panel can close itself after it handed something to the composer.
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
`label`, an optional `Icon` the way panels pass theirs, an optional `order`,
optional `keywords` — the words the Settings search field and the palette find
the page by besides its label — an optional `scope` (below) and a `Component`
receiving `SettingsPageProps`: `cwd` and `onNotify`). A page that also names a
`runtime` — a backend kind — gets no nav entry: core draws it as that runtime's
card on its Providers page, under the runtime's mark and `label`, in `order`,
and opens Providers for its `id`. The backend kits Tau ships put the CLI, its
version and update, the login and a path override there, one card per
instance (below). `inspectPackages(cwd)`
answers core's own scan of the package folders and the shipped kits
(`ExtensionInspection`) without loading any code — including `distribution`,
the name and version of the set the `bundled` entries came in, absent in safe
mode, which loads none. Core keeps Defaults, Pi, Keybindings and the Inspector;
every other page is a contribution and is gone with its extension. The search
field at the top of the Settings column finds core's own rows (and scrolls to
the row), a contributed page by its label and `keywords`, an extension's page
by its name and its options, and every live keybinding — which opens the
Keybindings page filtered to its command.

#### Settings pages: the full page, the levels and the rows

Settings is a page of its own that covers the whole window (T3 Code's layout):
the section column on the left with the search and a Back button, a bar with
the breadcrumb `Settings / <page> / <scope>`, and the page below at a readable
width. Escape, Back and `mod+,` return to the workbench, which stays mounted
underneath (`inert`). `actions.openSettings(page)` opens a page by id.

A page is built from the same pieces core builds its own with, all on `tau`:

| Export | What it is |
|---|---|
| `SettingsSection({ title, id?, headerAction?, plain?, children })` | A muted heading over one card of rows. `plain` drops the card, for content that draws its own (a table). |
| `SettingRow({ id?, title, description?, status?, control?, setting?, disabledReason?, children? })` | One setting: what it is on the left, its control on the right. `id` is the anchor a search result scrolls to. `disabledReason` (new in API 1.13.0) turns the control of a row without a `setting` inert, with the reason as its tooltip — `READ_ONLY_REASON` on a Read-only device. |
| `useSetting(key, options)` | One key of Tau's config read across the levels, as a `SettingHandle`. |
| `userThemes()` | The user themes (`UserTheme`) the last preferences sync registered — the files in the themes folders. Read-only; the preferences store emits when they change. |

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
`"both"` gets the scope menu as the breadcrumb's last crumb — "This machine" or
a project from the project list — and a page without one always edits this
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
`reserveRegion`, and the workbench's own floats — menus, popovers, the toast
stack — slide out of it rather than disappear behind it;
`reserveRegion(undefined)` gives the window back, and nothing is reserved
until a package asks for it — and `Menu` with its `MenuItem` and `MenuSection`
types, the popover list a composer chip drops, with the scrim, the keyboard
and the shift that keeps it clear of a native view (below).

#### The UI primitives (new in API 1.11.0)

Core draws its menus, tooltips, toasts and dialogs with the pieces below, and
a package that uses them behaves like core without drawing a look-alike. They
are Tau's own, not a component library; the reasons and the numbers are in
[PERFORMANCE.md](PERFORMANCE.md#ui-primitives-in-core).

| Export | What it does |
|---|---|
| `Menu` | `items` or `sections` (`MenuSection`: an optional `heading` and `MenuItem`s). Arrows, Home and End move between the enabled items, typing jumps to an item by its label, Enter or a click picks one, Escape and Tab close it, and focus goes back to whatever had it when it opened — the trigger, usually. Opened from the keyboard it focuses its first item (or the `selected` one), opened by a click it takes focus itself. A `MenuItem` with `submenu: MenuSection[]` opens beside it on ArrowRight, Enter or hover, and ArrowLeft comes back. It flips above its anchor or slides sideways to stay inside the window. With `at: { x, y }` it opens at that point over the whole window instead of inside the trigger's `.menu-anchor`; `label` names it for a screen reader when no heading does. |
| `useContextMenu()` | `(event, sections) => Promise<string \| undefined>` for an `onContextMenu` handler: the OS draws the menu where the client's platform offers one (Electron's `Menu.popup`, through the client-side `context-menu` method), the page draws a `Menu` at the pointer everywhere else — the browser client, a test — and when the OS refuses. It answers the chosen item's id, or `undefined`. Headings become macOS menu headers, `selected` a check mark, a `badge` part of the label; icons, descriptions and hints stay in the page's version. Opened from the keyboard (Shift-F10, the menu key) it opens under the element instead of at 0,0. Workspace Kit's rail rows are the shipped caller. |
| `tooltipProps(text, options?)`, `Tooltip` | A tooltip on any element: spread `tooltipProps("Settle thread", { shortcut: "⌘S", side: "bottom" })` on it, or wrap it in `<Tooltip content="…">`. Both only set `data-tooltip` (and `data-tooltip-side`, `-shortcut`, `-when`, `-variant`), which core's one `TooltipLayer` reads from the document, so a list of a thousand rows costs attributes, not components. It opens after the pointer rests for 600 ms, at once while another tooltip was open in the last 400 ms, at once on keyboard focus, and closes on Escape, a press, a scroll that moves its element or leaving. `when: "truncated"` shows it only while the element's own text is cut off (a thread title); `variant: "code"` sets it in the monospace face (a path); `variant: "lines"` keeps the text's line breaks, for a few lines of details (a rail row's hover card). A trigger whose `aria-label` differs from the text gets `aria-describedby` while it shows. Use it instead of `title=`, whose OS tooltip waits a second and cannot show a shortcut. |
| `actions.toast(options)` | A toast on the window's stack, top right, and a handle with `update(patch)` and `dismiss()`. `ToastOptions`: `type` (`info`, `success`, `warning`, `error`, `loading`; the icon, and an `error` is an ARIA alert), `title`, `description`, `actions` (`{ label, run, keepOpen? }` buttons; a click runs and closes unless `keepOpen`), `copyText` (a copy button), `timeoutMs` (5,000 by default; 0 keeps it until dismissed; a `loading` toast waits until it is updated to another type), `id` (showing it again replaces the toast and starts its time again) and `onClose`. Three are visible, newest in front, the rest waiting with their clocks stopped; the time runs only while nobody hovers or focuses the stack and the window is visible, and F6 moves focus into it. `actions.notify(message)` is still the one-line way: every notice is a toast. Thread Rail's undo is a toast whose `timeoutMs` is 0 and whose own undo window dismisses it. |
| `MiddleTruncate`, `splitMiddle` | `<MiddleTruncate value={branch} />` cuts in the middle, as Finder does, for values that mean something at both ends — branches, paths, shas: a head that ellipsizes and a tail that stays (a short last path segment, else `tail` characters, 10 by default). No measuring and inline styles only, so it costs what an end cut costs in a long list; both halves are real text, so copy and screen readers get the whole value. Other props go to the outer `span`. `splitMiddle(value, tail?)` answers the cut, or `undefined` when the value is too short to be worth one. The rail's branch line uses it. |
| `Dialog` | A modal centred over core's scrim with `label` and `className`: Tab and Shift-Tab stay inside it, Escape and a click on the scrim call `onClose`, the first `autoFocus` field (else the first control) gets focus, and focus goes back when it closes. |
| `ConfirmDialog` | A yes-or-no question on `Dialog`, after T3 Code's: `title`, `message`, `confirmLabel` (`destructive` draws it red), `cancelLabel`, and with `dontAskAgain` a box whose state `onConfirm(dontAskAgain)` hears; `onCancel` on Cancel, Escape or the scrim. The action has focus, so Enter answers it. Thread Rail's delete, archive and unpin questions and core's quit question use it (API 1.12.0). |
| `Popover` | A card beside an element (`anchor`, a ref) or a point, `side` and `align` preferred and flipped or shifted to stay in the window; a press outside it or Escape closes it, and focus goes back. |
| `useFocusReturn(active, ref?, fallback?)`, `useFocusTrap(ref, active?)` | The two halves of the above for a surface of your own: give focus back to what had it when `active` turned on (`fallback` when that element is gone), and keep Tab inside. The palette, the model picker and the project picker use them. |
| `Spinner`, `Skeleton`, `Empty` | `Spinner` with `size` `xs` (the 10 px ring of a status line), `sm`, `md`, `lg` and `tone` `working`, `accent` or `current`; `Skeleton` with `shape` `block`, `card` or `pill`, sized by its `className` or `style`; `Empty` with `size` `compact`, `default` or `hero`, an `icon`, a `title`, a `description` and actions as children. |

`Menu`, `Dialog`, `Popover`, `ConfirmDialog`, `SettingRow`, `SettingsSection`, `ChangesTree`, `ExtensionPromptFrame` and `OptionRow` load with chunks of their own: the names and props are the same, and Tau preloads the chunks once the window is idle after start-up. One drawn before that shows nothing until its chunk arrives, a few milliseconds; the hooks (`useSetting`, `usePromptSubmit`, `useContextMenu`, `useFocusTrap`) are always there.

A package that takes over a Pi dialog (`registerPromptRenderer`) gets the
pieces core draws its own four with, so its dialog is not a look-alike:
`ExtensionPromptFrame` and `OptionRow` (the frame and one choice row), the
`PromptRendererProps` and `PromptRendererContribution` types, and the parsers
for what the ask tool folds into a dialog's title and options —
`splitPromptTitle`, `splitInputTitle`, `splitOption`, `choiceOptions`,
`freeTextOption` and `optionForLabel`, with their `OptionParts` and
`OptionPreview` types.

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
the same line again scrolls there again;
`actions.openStageTab(kind, params?, options?)` puts a tab of your own kind
there (above); `actions.openThread(sessionId, options?)`
puts a thread there instead — its transcript, read-only, with the title, status
and cost the thread index carries and a "Take over" button, while the composer
goes on addressing the thread it was already addressing. Both take
`{ pin: true }` for a tab the next preview must not replace. Agents Kit opens a
spawned thread that way rather than switching to it. A thread reads whether or
not the host still holds a runtime for it: runtimes are capped, idle ones are
released oldest first, and one nobody used for ten minutes is released too, so a
released thread's transcript is projected from its session file, with the same
paging, cursors and client-message correlation.

`actions.newSession()` opens the project picker for a new thread, as the rail's
button does. `actions.newSession({ workspace })` puts a new thread's draft
straight into the project that workspace id names, and does nothing for a
project the window does not know yet (new in API 1.10.0). Workspace Kit's
`tau app <path>` is the caller: it opens the folder with `openWorkspace` first,
so a project Tau never saw arrives on its own empty thread.

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
| `useClientStorage`, `getClientStorage`, type `ClientStorage` | the renderer's key/value storage, in and out of the component tree. |
| `useHostCapabilities`, `hostHasLocalFiles`, `hostIsReadOnly` | what the connected host announced; the two functions read the ambient client when given none. `readOnly` (new in API 1.13.0) is true on a device paired Read only (ADR 0024): the host refuses every call that changes something, so disable a write with that reason, or leave it out, rather than offer it. `READ_ONLY_REASON` is core's wording for a disabled control. Core does it for the composer (a note instead of the field), setting rows (inert, with the reason), the title menu (new thread, pin and settle included), the compact list (its Stop, swipe tray and new-thread button), Edit/Fork, the changes tree and the Defaults page's model, thinking and runtime; preferences stay on the device, and a copied chat goes to the device's own clipboard. |
| `useCommandAllowed(extensionId, command)`, `hostCommandAllowed(extensionId, command, client?)` | (new in API 1.13.0) whether this device may run a kit's host command: always with Full access; on a Read-only device only a command registered `access: "read"`, and none until the host has said which those are (the hook re-renders then). One line disables a control: `disabled={!allowed}` with `READ_ONLY_REASON` as its tooltip. The function is for palette sources and other code outside a component. |
| `useKeepClear` | keeps a floating element clear of the reserved regions of the window. |
| `readCachedTurnActivity`, `changesSinceTurn`, `changesTouchedByTools` | what a turn touched, from the cache core writes. |
| `formatCost` | core's money formatting. `ThreadRow` already draws a thread's own cost and token detail. |
| `StageTabContribution`, `StageTabHandle`, `StageTab` and its three kinds, `StageState` | the stage-tab seam above, and the shape `actions.stageTabs()` answers with. |
| `Markdown`, `highlightSource`, `loadHighlightLanguage`, `canonicalHighlightLanguage` | core's Markdown renderer, the one the transcript draws with, and the highlight.js core behind its code blocks (new in API 1.10.0). highlight.js and each language load on first use; `highlightSource(code, language)` answers HTML once `loadHighlightLanguage(language)` resolved, and nothing for a language core does not ship. |
| `VirtualList`, `Menu`, `MenuItem`, `FileKindIcon`, `ChangesTree`, `ThreadRow`, `ThreadActivity`, `usePagedWorkspaceFiles` | presentation core owns; the UI primitives have their own table above. `ThreadRow` draws provider icons from core's asset pipeline, which an esbuild-bundled package has no loader for, so it is API rather than something a navigator kit re-implements. Its optional `accessory` node is drawn beside the branch label (and before the age on a compact row): a navigator passes other kits' marks through it. Since API 1.11.0 `actions` are buttons drawn before Settle while the row is hovered or focused (not on a settled row), and `showLabel: false` leaves out a label that says nothing — Workspace Kit's rail passes it for `main` and `master`, as T3 Code's card shows no default branch. `details` (API 1.11.0) is a few lines shown beside the row on hover in place of the title's own tooltip, and the branch is cut in the middle (`MiddleTruncate`). A `UiSession` carries `createdAt` since API 1.11.0 where the runtime's store knows it (Pi's threads), which the rail's "Order threads by: Created" reads. |
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
`actions.openExternal` when Preview Kit is off. Its `jump(target, actions)`
(new in API 1.12.0) brings forward what an agent drives: `{ kind: "browser" }`
the Preview panel with the page, `{ kind: "app", threadId }` the window that
thread's Computer Use driver steers, raised by the driver itself; a handover
that asks the user to take over uses it. On a client away from the host's
machine (a phone, a browser, a window on another computer) `jump` opens the
Preview there instead, where the user drives the page or window by tapping and
typing, and `remote()` (new in API 1.13.0) says so. `watch(target, maxWidth, onFrame)`
(new in API 1.13.0) delivers a small live picture of the page or of a thread's
driven window while the calling page is visible, until the returned stop. Preview Kit also publishes
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
`registerRailSection?(Component)` (new in API 1.13.0) draws a section at the foot of
the rail, above its footer, given the rail's `actions`; Machines Kit lists the other
machines' threads there. An older Workspace Kit lacks it, so call it as `registerRailSection?.(…)`.
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
(`{ relPath, text, expectedMtimeMs? }`) name `tau.files` as a caller. A write
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
`shelf` folds away under its label with compact rows; `menu(session)` and
`runMenu(session, itemId, actions)` are a row's right-click menu;
`toggleSettled(session)` answers the row's own settle button; the optional
`rowActions(session)` (new in API 1.11.0) lists buttons `{ id, label, icon,
menu() }` the row shows beside Settle on hover and keyboard focus, each dropping
the list `menu()` answers at that moment in a `Popover` — arrows, Home and End
walk it, Escape closes it — and a pick goes to `runMenu` (Thread Rail's snooze
clock with its presets and "Custom…"); and
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
`prepareThreadWorktree({ prompt, preparing, force?, branchSuffix? })` makes the
worktree a new thread of the followed project runs in, the way the new-thread
gate does and named by the same naming kit; `force` makes one although the
draft runs in the current checkout, and `branchSuffix` keeps several worktrees
for one prompt apart. It answers `{}` (with a notice) for a project that is no
repository or a worktree that could not be made.

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
`true` wins; one that throws is reported and the prompt goes on as if nobody had
claimed it. The event is `beforeNewThread`'s plus `alternate` (the prompt was
sent with the modifier held: ⌘↵ on macOS, Ctrl+↵ elsewhere — a plain send
otherwise), `model` (what the thread would start with, absent when its runtime
chooses), `runtime` (the backend kind) and `attachments` (how many images and
files ride along). Thread Rail claims ⌘↵ to start a thread in the background,
and a prompt with several models chosen to start one thread per model.

`registerModelSelection({ id, selected, subscribe, toggle, reset })` lets a new
thread's model picker hold more than one model. Shift-click (or Shift+↵) on a
row calls `toggle(model, current)` instead of choosing — `current` is the model
the draft has now — and the picker stays open, marking every key `selected()`
answers (`provider/id`, once per time chosen, so a model may be in the set
twice); a plain pick calls `reset()` first and then chooses as always. The
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
`assertAllowedCloneSource`, `readBoundedImagePreview`,
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
reads back as `UiSession.parentThreadId`), and, for the package manager, the row shape and the scope name as types: `InstalledPackage`,
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
thread's runtime is chosen (the composer's runtime chip, Settings → Defaults);
it defaults to the kind. The host publishes every installed backend as
`runtimeBackends` on the snapshot and the catalog, with `defaultBackendKind`
naming the one a client gets when it names none. The list is in the one order
every runtime list uses — the model picker's rail, the composer's runtime
menu, Settings → Defaults and Providers, onboarding: Pi, then backends by the
provider's `order` (new in API 1.11.0; lower first, unset last, ties in
registration order). The bundled kits take 10 (the Agent SDK runtime), 20
(Codex), 30 (Antigravity), 40 (OpenCode), 50 (Cursor) and 60 (Grok); every instance of a program shares its order.

A backend that drives a program the user installed may say which version that
is: `version()` on the provider answers `{ tool, installed?, latest?,
updateCommand? }` (`RuntimeToolVersion`), or `undefined` when it cannot tell.
The host asks each backend once a day, never while a snapshot waits for it,
and publishes the answer as `version` on that backend's `runtimeBackends` entry;
the picker's runtime tab and Settings → Defaults then say that an update is
out, with `updateCommand`, whenever `installed` is older than `latest`
(`compareVersions`). `updateCommand` is what the user runs — a shell command,
or where in Tau to click. For a CLI that npm publishes, `tau/host-extension`
has the pieces: `npmLatestVersion(packageName, { cacheFile })` reads the
registry's `latest` tag with one GET a day, cached in a file of the caller's
(under `services.stateDir`), and never throws; `packageUpdateCommand(realPath,
packageName)` names the Homebrew, npm, pnpm or bun command that owns an
executable's resolved path, or `undefined` for the program's own updater. The
registry request needs the `network` permission. Claude Code and Codex use
both; Antigravity reports the release it pins.

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
command stands. The picker's runtime tab and Settings → Defaults put an unsafe
or broken version before an available update. Tau never runs either command on its own:
the shipped kits draw `RuntimeVersionBanner` above the composer of the thread
and on the card, and its button types the command into a new Terminal Kit
shell without pressing Enter (without Terminal Kit it is copied). A backend
should refuse to open a thread on a `broken` version; Codex's policy calls
every release older than its protocol broken.

A newer release is offered as a toast, after T3 Code's provider update
notification (new in API 1.11.0). `loadRuntimeUpdateToasts()` on `tau` loads
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
its stylesheet) that holds `RuntimeInstanceSetup` — the SETUP rows of a card:
how the instance is set up, Edit, Remove with a confirmation in place, and on
the default instance's card "Add instance…" — the dialog behind it
(`RuntimeInstanceDialog`: name, id taken from the name, executable, home,
environment as `NAME=value` lines, launch arguments) and
`RuntimeVersionBanner`. Codex and the Agent SDK runtime use all three: the
default card keeps its page id, each other instance gets a page naming its
kind, and an `instances` event from the host half keeps every client's cards
in step.

`services.sessions.start(options)` (`sessions`) creates a thread off screen:
`cwd`, the first `prompt`, and optionally `title`, `model`, `parent` and
`backend`. `backend` is the kind the thread runs on — `"pi"`, the default, or
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
start yet (`unavailable`: "Set GEMINI_API_KEY first"). An **account**
(`SignInAccount`) says whether the program is signed in, as whom and through
what, and whether a sign-out has anything to remove (a key from the
environment does not). A **flow** (`SignInFlowState`) has an id and a phase
(`starting`, `waiting`, `verifying`, `succeeded`, `failed`, `cancelled`) and,
while it waits, what the user acts on: a consent page to open (`browser`), a
code to enter on a page (`deviceCode`), a command to run in a terminal the
user sees (`terminal`), a question (`prompt`: `text`, `secret`, `select` or
`code`, the last one for a code or an address pasted back), a line and links.

A kit's host half registers the flows with `registerSignIn(context, {
report, signIn, signOut, changed })` from `tau/host-extension`. It registers
five commands and one event, the same for every kit, so the window can drive
any of them: `sign-in-state` (the methods, the account and the last flow),
`sign-in` (`{ target, method }`, answers the new flow at once), `sign-in-respond`
(`{ target, flowId, value }`), `sign-in-cancel` and `sign-out`, each with a
`target` naming an instance or a provider; the `sign-in` event carries a
moved flow, or the whole report once a flow ended or a sign-out ran. The helper
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
with its stylesheet): the account row with sign-out (confirmed in place),
the methods while signed out, and the flow drawn after T3 Code's provider
setup — Open sign-in page and Copy link, the device code with Copy and the
page's host, the question's field (a password field for a secret) or its
choices, Cancel sign-in and the time the flow gives up. A `terminal` step of
a flow this window started runs once through `runInTerminal` — the shipped
kits pass Terminal Kit's `tau.terminal/run`, so the login runs where the user
sees it — and its exit status answers the flow; without a terminal the
command is shown to copy with "I have signed in". `showAccount: false` leaves
the account row to a caller that draws its own.

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
and from where (`source`, `label`), and what Pi's file holds for it
(`stored`); `login(providerId, "oauth" | "api_key", interaction)` runs Pi's
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
`connected` after any other state means it is back.

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
only writes; the host still enforces it.

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
Kit and Files Kit do to reread the disk.

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

On the desktop side, `registerSettingsSection({ id, page, order?, Component })`
(new in API 1.13.0) adds a section to one of core's Settings pages, below
core's own sections; `page` is `"connections"` so far. The component gets
`onNotify` and `onChanged`, which reads the page's own data again after the
section changed something it shows (a new endpoint in the address list). It is
profile-scoped like a panel.

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

The host sends push notifications itself (`kits/push/`), with the user's own
APNs key and Firebase service account, entered in Settings → Push and kept in
`<userData>/kit-state/tau.push/keys.json` (mode 0600, not encrypted — the host
has no keychain). The native app registers its token with the `register`
command after connecting. A package that wants a phone to hear of something
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
| `open(id, target?)` | Points the window at another machine: the page loads again there, and `target` — `{ thread: { path } }` or `{ newThread: { draft?, workspaceId? } }` — waits for it. It rejects for a machine that is not connected. For the machine already shown, open the target yourself. |
| `takeArrival()` | What this page was sent to show, once. |
| `pair({ text, deviceName? })` or `pair({ nearby })` | Adds a machine from a pairing link, its QR code's text, or an address; or (new in API 1.13.0) one the last `discover()` found, by its host id: it asks without a link, pinned to the fingerprint the record carried. Resolves `added`, `denied`, `expired`, `cancelled` or `failed` once the other owner decided. `cancelPairing()` stops waiting. |
| `discover()` | New in API 1.13.0. `UiDiscoveredHosts`: the machines that announce themselves on this network, looked for a few seconds by the window's own host, whichever machine the page shows. A saved machine found with its pinned fingerprint takes the addresses it has now. Look only when the user asks: looking makes macOS ask about local network access. `NearbyMachineList` draws the result with an action slot per host. |
| `shownElsewhere`, `showLocal()` | New in API 1.13.0. The id of the machine the page shows when it is not the window's own (from the page's address, so known before the list loads), and the way back. Core offers "Back to this computer" in the palette whenever `shownElsewhere` is set, whatever kits that machine serves. |
| `setPreferences({ reopenShown })` | New in API 1.13.0. Whether the window shows the machine it showed last again at start (`UiEnvironments.reopenShown`); it does when that machine answers within 2.5 s. |
| `rename(id, name)`, `remove(id)`, `retry(id)` | Rename or forget a saved machine (its key goes with it), or try to reach it now. |

The window's process answers all of it through client-side methods
(`environments-list`, `-pair`, `-cancel-pairing`, `-rename`, `-remove`, `-retry`,
`-open`, `-take-arrival`, `-discover`, `-set-preferences`) and the `environments` window event; a host refuses the
methods with `unsupported`. Every kit a page loads comes from the machine it shows,
so a kit needs nothing of its own to work on another machine; what needs *this*
window's machine — a window half, `local-files` — is not offered there.

### `engines` and `engines.api`

`engines.tau`, `engines.pi` and `engines.api` are version ranges checked
against the running Tau, its bundled Pi, and `EXTENSION_API_VERSION`
(`src/shared/extension-compat.ts`, currently `1.13.0`) — the version of the
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
| `workspace:read` | read the current project's path, name and file contents through the host services. |
| `workspace:write` | change files and write Git in the current project. |
| `workspace:switch` | open or pick another project. |
| `sessions` | read session files, threads and transcript entries, hook into thread lifecycle and turns, and provide and read turn attachments. `agentDir`, Pi's configuration directory, is plain bootstrap data every package may read. |
| `runtime:extend` | register Pi runtime extensions, load one Tau ships, offer tools to other runtimes over MCP (`mcp`), register runtime backends, permission levels and UI decorators — the members that hand out a live runtime — read a workspace's skill catalog (`skills`), and sign Pi's model providers in and out (`modelAuth`). |
| `process` | start processes, and call `noteSubprocess` and `findCommand` — the host-side bookkeeping for them. In a worker `child_process` is refused without the grant, by `require` and by `import()` alike. For an `in-process` package nothing is enforced. |
| `network` | reach the network, and take part in the host's own network access (`services.network`). In a worker the grant gates `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest` and the socket builtins, by `require` and by `import()` alike. For an `in-process` package nothing is enforced. Either way it is a guardrail against a mistake, not a boundary against code written to get around it — see §6. |
| `packages` | install, update, remove and list other extension packages (`listPackages`, `installPackage`, `removePackage`, `updatePackages`). Tau's own Packages kit holds it; a package that asks for it can add code that later runs, so read the request carefully. |

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
configuration the user edits: Agents Kit reads its running budget from
`~/.tau/agents.json` and never writes it.

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
refuses `child_process` for itself. For an `in-process` package neither is
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
nobody is attached to) makes the call reject. Treat it as an optional
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
  tau.d.ts              # editor types for "tau" and "tau/host-extension"
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

(`-l` installs it for the current project only; drop it to install globally.)
Approve it in Settings when it appears waiting for approval, then `/reload`.
The status item shows "Say hello" in the footer; clicking it calls the host's
`greet` command and shows the reply in its place. Prompting the agent with
something like "call hello_tau" makes it call the tool and answer with the
greeting.

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
Settings as *waiting for approval* with the list it asks for; **Allow** writes
the grant and starts both halves, **Deny** leaves it off. Until approved, the
host half is never even imported, in either scope.

**`/reload`** is the single "apply changes" command: it re-syncs packages
(also done at startup and on every project change), rebuilds Tau if its own
source changed, and reloads the renderer or restarts the app as needed.
Installing, updating or removing a folder never needs a rebuild — only a
`/reload`.

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
stays running, the error is a toast and a line in Settings → Inspector, and it
counts as nothing — a reload failure is not a command failure, so it can never
add up to a deactivation. Fix the file, save again, and the new version takes
over.

The panels of a reloaded package remount, so whatever state they held is gone.
That is the price of swapping a module in place, and it is why only the package
you edited is swapped.

**Turning it off.** Settings → Defaults → "Reload files when they change", or
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
  Throw a `HostCommandError` (from `tau/host-extension`) for bad input or a
  missing prerequisite — a path that is not a folder, npm not installed — and
  it reaches the caller like any error but neither counts nor resets; the
  flag survives a worker's port. Three typos must not switch a package off.
- **Worker heap cap:** a worker-isolated host half runs with a 256 MB old-space
  cap (plus a 32 MB young-generation cap); exceeding it, throwing, or exiting
  terminates the worker and deactivates the package with the reason recorded.
  A synchronous infinite loop inside a worker's command is also survivable —
  the worker that hangs is not the main process.
- **A denied permission is not a failure:** reaching past the grant — a guarded
  service member, or the network without `network` — throws inside the command
  and logs `host-extension.denied`, but the package stays active. Only the
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
  workbench on a render error.

## 6. What an isolated (worker) package cannot use

By default a package's host half runs in a worker thread: no Electron
(`import "electron"` throws), no network and no `child_process` unless it asked
for them, a 256 MB heap cap, and a facade that only carries plain data across
the port — nothing that hands out a live object. From
`src/main/host-extension-worker-protocol.ts` and ADR 0009:

| Available in a worker | Not available — declare `"isolation": "in-process"` instead |
|---|---|
| `cwd`, `log`, `safeMode` | `attachedRuntime` (a live Pi terminal) |
| `openWorkspace`, `knownWorkspacePath`, `pickDirectory`, `workspaceRef`, `admitWorkspace` | `registerRuntimeBackend`, `registerRuntimeExtension`, `loadRuntimeExtension`, `loadDependency`, `mcp` |
| `projectName`, `rememberProjectName`, `describeProjects` (round trip) | `decorateUiPrompt`, `setPermissionLevel`, `presentUi` |
| `runtimeOwner`, `thread(sessionId)` (a plain snapshot), `transcript`, `setThreadTitle` | `sessions.open` (a live `HostSessionFile`), `sessions.prepare`, `sessions.refreshIndex` |
| `noteSubprocess`, `findCommand`, `skills` | a `beforeActivate` transaction (a worker hook returns nothing, so it cannot roll back an activation) |
| `clients.observe`, `clients.count` | |
| `refreshExtensionPackages` | `listPackages`, `installPackage`, `removePackage`, `updatePackages` (installing hands the host a live progress callback) |
| `sessions.list`, `sessions.read` (entries as data), `sessions.exclusive` | anything else that would hand out a live host object |
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

### The network and processes, in a worker

A worker meets a guardrail for whichever of `network` and `process` its grant
left out. Before the package's bundle is loaded, `host-extension-worker.ts`

- replaces whichever of `fetch`, `WebSocket`, `EventSource` and
  `XMLHttpRequest` this Node defines on the worker global (without `network`);
- refuses `http`, `https`, `net`, `tls`, `dgram`, `http2` and `dns` (without
  `network`) and `child_process` (without `process`) — under any `node:`
  prefix and any submodule, so `node:dns/promises` is the same door as `dns`;
- refuses `worker_threads` while either grant is still missing, because a
  nested worker runs outside both guards and would hand the package back
  whatever it asked for;
- refuses `electron` always: it only exists in the main process.

Each of those throws `Extension <id> lacks permission <name>` (the nested
worker says why it is refused instead) and logs `host-extension.denied`, so the
Inspector and Signals show a denied socket or a denied spawn exactly like a
denied service member. A bundled `ws` or `undici` needs `net`/`tls` and hits
the same wall. The grant does not do the host's bookkeeping for you: a package
that spawns still calls `noteSubprocess` itself.

Two interceptions are installed, because neither covers the other:
`Module._load`, which is what `require` goes through, and
`module.registerHooks`, which is what `import()` goes through (and which sees
`require` as well). `await import("node:https")` used to walk straight past the
first one; it does not any more.

**This is still a guardrail, not an OS-level boundary.** A package holds
`node:module` like any other Node code and can put both hooks back the way it
found them; it reads and writes files either way, and an `in-process` package
meets nothing at all. What the worker gives you is crash containment, a heap
cap and a wall a mistake runs into — not a sandbox against hostile code.
[ADR 0018](adr/0018-sandboxed-host-extensions.md) collects what a real boundary
would cost. Install only host packages whose code you trust.

An `in-process` package is a different story. It runs with everything the host
process can reach, so neither grant is enforced there — the approval box says
"runs inside the host process; permissions are not enforced there" rather than
naming one of them. If you rely on a package not reaching the network or not
spawning anything, do not grant it `in-process`.

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
(`-l` for project scope), approve it in Settings, `/reload`, and use it. This
is exactly how `examples/hello-package` was verified for this document.


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
Settings → Defaults → Theme (and Settings → Appearance → Mode) and in the
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
`examples/theme-t3-like/` lays T3 Code's greys, indigo primary and radii over
the tokens, for telling a difference of colour from one of layout.

### The table

These names are the contract, and the only one: no layout class is API. A theme
that restyles `.thread-row` or `.panel-body` is reaching past the seam and will
break — core's class vocabulary is documented in [CORE.md](CORE.md) to be used,
not overridden.

Two rules keep the table honest, both checked by `src/renderer/tokens.test.ts`:
no colour may be written anywhere but `tokens.css` (kit stylesheets included),
and every token that carries text must reach WCAG AA — 4.5:1 on the five
surfaces text is read on, in **both** schemes; marks, fills and small print
reach 3:1. A theme is not held to that automatically, so check your own values.

**Surfaces**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--well` | deepest: an inset control | `#e6e4da` | `#11110f` |
| `--shell` | the window | `#f2f0e8` | `#131311` |
| `--rail` | the sidebar | `#eeece2` | `#151513` |
| `--chrome` | title bar, panel chrome | `#f0eee5` | `#161614` |
| `--stage` | the document area and panel bodies | `#faf9f4` | `#191917` |
| `--sunken` | a well inside a surface | `#edebe0` | `#1c1c18` |
| `--field` | an input | `#fdfcf8` | `#1d1d19` |
| `--thread-active` | the selected thread row | `#e9e7db` | `#1e1e1a` |
| `--raised` | a chip or inline code | `#e7e5d9` | `#22221d` |
| `--raised-strong` | a raised surface that is hovered or floating | `#dedcce` | `#272722` |
| `--raised-hover` | the hover of a raised control | `#d4d2c3` | `#343431` |
| `--overlay` | a modal panel | `#fbfaf5` | `#1a1a17` |
| `--float` | a menu, a toast, a popover card | `#fdfcf8` | `#1f1f1b` |
| `--hover` | the wash under a hovered row | `#eae8dc` | `#1a1a17` |
| `--hover-strong` | the same, in a list that needs to read | `#e5e3d6` | `#1c1c19` |
| `--code-bg` | code blocks, tool output, diffs | `#f6f4ec` | `#101010` |
| `--inset` | a block inside a settings page | `#f0eee3` | `#191916` |
| `--chip` | a small label's background | `#e4e2d5` | `#26261f` |
| `--chip-hover` | a small label, hovered | `#dbd9ca` | `#2a2a23` |
| `--track` | an empty progress track | `#d8d6c8` | `#393932` |
| `--scrim` | the dim behind a modal | `#2a2a24a3` | `#0a0a09e8` |
| `--scrim-deep` | the dim behind a full-screen image | `#1a1a16e0` | `#050505ed` |
| `--drop-card` | the card in a drag-and-drop overlay | `#fbfaf3ee` | `#20221cee` |

**Hairlines**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--line` | the ordinary hairline | `#dedac9` | `#26261f` |
| `--line-soft` | a hairline that should barely show | `#e6e2d3` | `#23231e` |
| `--line-inset` | between rows of one list | `#e8e4d6` | `#1f1f1a` |
| `--line-card` | the edge of a card | `#d8d4c2` | `#2a2a23` |
| `--line-control` | the edge of a button or chip | `#d4d0bd` | `#2b2b24` |
| `--line-strong` | an edge that has to be read as one | `#c9c5b1` | `#2f2f28` |
| `--line-field` | the edge of an input | `#c2bda7` | `#34342c` |
| `--line-focus` | a field with focus inside it | `#a9a48c` | `#404036` |
| `--line-float` | a menu or popover edge | `#bcb7a0` | `#3a3a31` |
| `--line-hover` | a control's edge while hovered | `#a9a48c` | `#4a4a40` |
| `--edge-highlight` | the inner top edge of a raised surface | `#ffffffcc` | `#ffffff08` |
| `--edge-highlight-strong` | the same, on a round control | `#ffffff` | `#ffffff26` |
| `--edge-line` | the edge of a selected row | `#00000014` | `#ffffff0f` |
| `--wash` | a fill barely above its surface | `#00000008` | `#ffffff04` |
| `--wash-2` | the same, one step up | `#0000000f` | `#ffffff0a` |

**Ink**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--ink` | headings and emphasis | `#1c1b15` | `#e7e4d9` |
| `--ink-prose` | assistant prose | `#27261e` | `#ddd9cd` |
| `--ink-2` | body text of the chrome | `#38372d` | `#c9c6ba` |
| `--ink-3` | secondary text | `#56544a` | `#a09e92` |
| `--ink-code` | code and diff bodies | `#45443a` | `#b5b3a6` |
| `--muted` | labels | `#636257` | `#8b8a7f` |
| `--muted-2` | small print | `#75746a` | `#7c7b70` |
| `--faint` | glyphs and disabled text | `#85857a` | `#6b6a5f` |
| `--fainter` | a mark that is only a hint of one | `#adac9f` | `#4f4e45` |
| `--scrollbar` | the scrollbar thumb | `#cbc8b6` | `#33332b` |
| `--scrollbar-hover` | the same, hovered | `#b3b09c` | `#45453b` |

**Accent**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--acid` | the accent as a fill | `#b7e229` | `#c7ff3d` |
| `--acid-text` | the accent as text or an icon on a surface | `#4a6410` | `#c7ff3d` |
| `--acid-ink` | text on the accent fill | `#16190c` | `#141512` |
| `--acid-strong` | the accent fill, hovered | `#a6cf1c` | `#d4ff63` |
| `--acid-bg` | the accent as a surface | `#eef6d5` | `#1b2010` |
| `--acid-line` | the accent as an edge | `#c6db8d` | `#3a4423` |
| `--acid-chip` | the accent as a chip behind accent text | `#e4f0bb` | `#2c3915` |
| `--acid-track` | the accent as a filled track | `#cde596` | `#3d4d18` |
| `--acid-glow` | the accent as a glow around a mark | `#a5cf2bbb` | `#c7ff3dbb` |
| `--focus` | the focus ring | `#4a6410` | `#c7ff3d` |

**Status**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--working` | a run in flight | `#a34a08` | `#ff8a4d` |
| `--ready` | a run that finished | `#1c7440` | `#7ade9f` |
| `--removed` | something taken away | `#b03a28` | `#f07a6a` |
| `--stop` | the abort control | `#c2282d` | `#e5484d` |
| `--stop-ink` | the square on the stop button | `#ffffff` | `#ffffff` |
| `--cyan` | numbers and types | `#06706c` | `#6fd3cf` |
| `--danger` | destructive text | `#a83f30` | `#d88c83` |
| `--danger-line` | the edge of a destructive control | `#e2b4ab` | `#6f3838` |
| `--danger-bg` | that control, hovered | `#faeae6` | `#251917` |
| `--warn` | a caution | `#8a5a09` | `#e0a34d` |
| `--warn-chip` | a caution as a chip | `#f7ecd8` | `#33241d` |
| `--fail` | a failed run's mark | `#c2452f` | `#d05a4a` |
| `--fail-ink` | what that run says | `#a83b28` | `#d98a7c` |
| `--info` | a step in progress | `#3457d5` | `#4d7cff` |
| `--info-deep` | a step already done, in a dense bar | `#2745ad` | `#426fe1` |
| `--info-ink` | the same, as text | `#2b4bbf` | `#79acf0` |
| `--merged` | a merged pull or merge request | `#7446c2` | `#b59cf2` |
| `--done` | a step that finished | `#0d7f5f` | `#13c99a` |
| `--stale` | how long ago something ran | `#8a5a3f` | `#c9a18b` |
| `--folder` | a directory | `#6f6118` | `#a59d68` |

**Diff**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--diff-add-bg` | an added line | `#e6f3da` | `#1e2a17` |
| `--diff-add-ink` | its text | `#2c5418` | `#c6e6a8` |
| `--diff-add-mark` | the changed run inside an added line | `#a8dc86` | `#527a3c` |
| `--diff-add-mark-ink` | the run's text | `#1c3f0d` | `#e1ffc8` |
| `--diff-add-mark-line` | the run's edge | `#6fa552` | `#76a957` |
| `--diff-del-bg` | a removed line | `#fbe7e1` | `#2b1a17` |
| `--diff-del-ink` | its text | `#8c2f1f` | `#e0a89e` |
| `--diff-del-mark` | the changed run inside a removed line | `#f2b4a7` | `#8b433b` |
| `--diff-del-mark-ink` | the run's text | `#66200f` | `#ffd1c8` |
| `--diff-del-mark-line` | the run's edge | `#c8695c` | `#b95b50` |
| `--diff-add-edge` | an addition as a bar, a sign or a count | `#1c7440` | `#7ade9f` |
| `--diff-del-edge` | a removal as a bar, a sign or a count | `#b03a28` | `#f07a6a` |
| `--syntax-fn` | highlight.js function and class names | `#5c6b13` | `#d9e88f` |

**Project**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--project-tint` | a project's mark | `hsl(var(--project-hue) 46% 88%)` | `hsl(var(--project-hue) 34% 15%)` |
| `--project-ink` | its letters | `hsl(var(--project-hue) 55% 27%)` | `hsl(var(--project-hue) 70% 66%)` |
| `--provider-bg` | the tile behind a provider glyph | `#2a2924` | `#f3f1e9` |
| `--provider-ink` | the glyph itself | `#f3f1e9` | `#171713` |
| `--provider-google` | brand tint, the same in both schemes | `#f8faff` | `#f8faff` |
| `--provider-claude` | brand tint, the same in both schemes | `#f3e8df` | `#f3e8df` |
| `--reload-core` | the centre of the reload curtain | `#e5f0c8` | `#25320f` |
| `--reload-halo` | its falloff | `#f3f5e6` | `#171a10` |
| `--reload-panel` | the panel inside it | `#f4f7e6` | `#171a11` |

**Shadows**

| Token | Role | Light | Dark |
|---|---|---|---|
| `--shadow-soft` | a small float | `#3c38281f` | `#00000066` |
| `--shadow` | a menu or a toast | `#3c382833` | `#00000099` |
| `--shadow-strong` | a modal | `#2d2a1e40` | `#000000cc` |

**Type, size, motion**

| Token | Role | Value |
|---|---|---|
| `--mono` | code and numbers | `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace` |
| `--sans` | everything else | `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` |
| `--label-font` | section, group and status labels ("Pinned · 2", "Working 0:42", a Settings heading) | `var(--sans)` |
| `--label-case` | their `text-transform` | `none` |
| `--label-tracking` | their `letter-spacing` | `normal` |
| `--label-size` | their size | `11px` |
| `--radius-xs` | a tag | `4px` |
| `--radius-sm` | a button | `6px` |
| `--radius-md` | a card | `9px` |
| `--radius-lg` | a panel | `12px` |
| `--radius-xl` | a modal | `16px` |
| `--radius-pill` | a pill or a knob | `999px` |
| `--motion-fast` | a hover or a chevron | `120ms` |
| `--motion` | a row or a card arriving | `180ms` |
| `--motion-slow` | a curtain | `320ms` |
| `--ease` | the curve all three use | `cubic-bezier(.4, 0, .2, 1)` |
| `--elevation-1` | a small float | `0 5px 18px var(--shadow-soft)` |
| `--elevation-2` | a menu, a toast, a popover | `0 16px 40px var(--shadow)` |
| `--elevation-3` | a modal | `0 40px 100px var(--shadow-strong)` |

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
| `--font-family-override`, `--font-size-override` | the interface face and size (core's preferences) | the system sans, `13px` |
| `--prompt-font-family`, `--prompt-font-size` | the composer's text | the interface face, `13px` |
| `--code-font-family`, `--code-font-scale` | code blocks, tool output, the file view and diffs | `--mono`, `1` |
| `data-density` | Appearance Kit's stylesheet, into `--density` | normal |
| `data-timestamps` | message and tool timestamps: `12h`, `24h` or `locale` | 24-hour |
| `--panel-motion` | how long the sidebar and the dock take to open or close, and the drawer to open; never while a divider is dragged or the system asks for reduced motion | `0ms` |

`--project-hue` is not a token: the thread row sets it per project, and
`--project-tint` and `--project-ink` say how deep that hue reads. The same goes
for the handful of layout variables a component sets on itself
(`--keep-clear-x`, `--composer-inset`, `--used`).
