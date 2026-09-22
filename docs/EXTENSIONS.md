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

`registerKeybinding({ keys, commandId })` adds a chord; the first binding of a
chord wins and a later one is recorded as a conflict. Pass `replaces:
<commandId>` when the chord is meant to *be* that command's key rather than
another one beside it — every other binding of that command is hidden while
yours lives and comes back when it is disposed, and if the chord you ask for is
the very one that command already had, you take it over instead of colliding
with it. Keybindings Kit uses it for the actions the user rebound in
`~/.pi/agent/keybindings.json`: someone who wrote `app.session.new` there meant
that key, not that key and Tau's default too. Without `replaces`, a binding is
additive, which is what a package adding a chord of its own wants.

`registerPanel` takes `Icon`, a component of your own (`{ size?: number }`) —
`lucide-react` is a shared module, so a package draws its glyph from the set
the workbench itself uses, and core no longer keeps a table of names it would
have to know a kit by. A panel without one gets core's fallback glyph.
`registerSettingsPage` takes the same `Icon`.

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
shipped caller.

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

`scope` is the draft key core persists the text under; a new thread's draft
gets a new one once the thread exists, so a contribution keeps its state by
scope and lets go of it on `settleSend(scope, true)`.

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
| `text-excerpt` | `{ source, text }` | `From <source>:` and the text as a `>` quote |
| `pull-request` | `{ number, title, url, branch? }` | `Pull request [#n](url): title` |
| `attachment` | `{ name, mimeType, size, path? }`, `path` on the host | a `kind: "file"` attachment for a runtime that opens files; otherwise the text inline (200 KB at most) or, for anything else, a sentence naming the path |

A draft's chips persist with its text (the `draftState` slot above) and go when
the prompt was accepted; a refused prompt puts them back. The kit's own limits
are T3 Code's: eight attachments a message, 10 MB an image (an image goes to
core as an image whenever the model sees images), 50 MB any other file, and a
paste from 32 KiB on becomes `pasted-text-<n>.txt` with a chip — removing the
chip is the undo. A file travels to the host in 4 MiB pieces, so a 50 MB one
stays under the host socket's 64 MiB frame.

#### Which clients draw it

Every contribution the workbench draws — panels, settings pages, stage tabs,
regions, status items, overlays, composer controls, composer inlines, the sidebar, project
sources, prompt renderers, the document source, transcript rows, tool renderers
and tool cards — takes an optional `profiles`:

```ts
context.registerPanel({ id: "agents", label: "Agents", profiles: ["desktop", "web", "compact"], Component: AgentsPanel });
context.registerToolRenderer("git.rows", match, render, { profiles: ["desktop", "web", "compact"] });
```

`"desktop"` is the Electron window, `"web"` a browser at the same host,
`"compact"` a browser small enough that the thread list is a sheet and diffs do
not split. The default is `["desktop"]`, so a package that says nothing keeps
working and stays honest: it claims no client it was never tried on.

A client whose profile is not in the list never registers the contribution, so
your component never mounts there — but the extension still activates and **its
host half still runs**. Settings → Inspector lists what this client leaves out
under "Not on this client", with the kind and the profiles you did claim. Claim
a profile only for a contribution you have actually seen work there; a Git
panel over the machine's own files or a native view over the window is
desktop-only, and saying so is the correct answer, not a gap.

Commands, keybindings, slash commands, prompt hooks and services carry no
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
of the Settings modal with its own nav entry, typed `SettingsPageContribution`
(`id`, `label`, an optional `Icon` the way panels pass theirs, an optional
`order`, and a `Component` receiving `SettingsPageProps`: `cwd` and
`onNotify`) — and `inspectPackages(cwd)`, which answers core's own scan of the
package folders and the shipped kits (`ExtensionInspection`) without loading
any code — including `distribution`, the name and version of the set the
`bundled` entries came in, absent in safe mode, which loads none. Core keeps Defaults, Keybindings and the Inspector; every other page
is a contribution and is gone with its extension.

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
`reserveRegion`, and the workbench's own floats — menus, popovers; a toast is
pinned to the window's bottom-left corner and never reaches the dock — slide
out of it rather than disappear behind it; `reserveRegion(undefined)` gives the
window back, and nothing is reserved until a package asks for it — and `Menu`
with its `MenuItem` and `MenuSection` types, the popover list a composer chip
drops, with the scrim, the Escape handling and the shift that keeps it clear of
a native view.

A package that takes over a Pi dialog (`registerPromptRenderer`) gets the
pieces core draws its own four with, so its dialog is not a look-alike:
`ExtensionPromptFrame` and `OptionRow` (the frame and one choice row), the
`PromptRendererProps` and `PromptRendererContribution` types, and the parsers
for what the ask tool folds into a dialog's title and options —
`splitPromptTitle`, `splitInputTitle`, `splitOption`, `choiceOptions`,
`freeTextOption` and `optionForLabel`, with their `OptionParts` and
`OptionPreview` types.

`actions.openFile(path, options?)` puts a document in the stage;
`actions.openStageTab(kind, params?, options?)` puts a tab of your own kind
there (above); `actions.openThread(sessionId, options?)`
puts a thread there instead — its transcript, read-only, with the title, status
and cost the thread index carries and a "Take over" button, while the composer
goes on addressing the thread it was already addressing. Both take
`{ pin: true }` for a tab the next preview must not replace. Agents Kit opens a
spawned thread that way rather than switching to it. A thread reads whether or
not the host still holds a runtime for it: runtimes are capped and idle ones are
released oldest first, so a released thread's transcript is projected from its
session file, with the same paging, cursors and client-message correlation.

One consequence for `pinTranscriptEntries`: your provider is now also called
with a thread the host has only a file for. `sessionId`, `cwd`, `sessionFile`,
`parentThreadId`, `sessionName()`, `entries()` and `transcript()` answer as
usual; the members that need a live runtime (`complete`, `appendEntry`) throw,
and a provider that throws simply contributes no pins for that thread.

It also lends two document surfaces core owns: `ReviewMode`, the full-workbench
review of a set of changes (file tree, diffs, line notes, commit box), and
`ChangesTree`, the changed files of a workspace with stage, unstage and revert.
Both load as their own chunk the first time they are rendered and bring their
own loading state, so an extension renders them like any other component. The
shapes their props speak — `UiWorkspaceChanges`, `UiChangedFile`, `UiFileDiff`,
`UiDiffHunk`, `UiDiffLine`, `DiffLoadOptions`, `WorkspaceChangesQuery`,
`WorkspaceDiffScope`, `ChangeStatus`, `UiEditor`, `UiWorkspaceChangesPage` —
are exported as types beside them.

It also exports the renderer's shared state and presentation:

| Export | What it is |
|---|---|
| `usePreferences` | the same store as `context.preferences`, for a component rendered in a slot. |
| `useClientStorage`, `getClientStorage`, type `ClientStorage` | the renderer's key/value storage, in and out of the component tree. |
| `useHostCapabilities`, `hostHasLocalFiles` | what the connected host announced; `hostHasLocalFiles` reads the ambient client when given none. |
| `useKeepClear` | keeps a floating element clear of the reserved regions of the window. |
| `readCachedTurnActivity`, `changesSinceTurn`, `changesTouchedByTools` | what a turn touched, from the cache core writes. |
| `formatCost` | core's money formatting. `ThreadRow` already draws a thread's own cost and token detail. |
| `StageTabContribution`, `StageTabHandle`, `StageTab` and its three kinds, `StageState` | the stage-tab seam above, and the shape `actions.stageTabs()` answers with. |
| `VirtualList`, `Menu`, `MenuItem`, `FileKindIcon`, `ChangesTree`, `ThreadRow`, `ThreadActivity`, `usePagedWorkspaceFiles` | presentation core owns. `ThreadRow` draws provider icons from core's asset pipeline, which an esbuild-bundled package has no loader for, so it is API rather than something a navigator kit re-implements. Its optional `accessory` node is drawn beside the branch label (and before the age on a compact row): a navigator passes other kits' marks through it. |
| `loadReviewMode` | the full-window review surface, as its own chunk. |
| the workspace vocabulary | `UiWorkspaceChanges`, `UiFileDiff`, `FileNode`, `WorkspaceInfo`, `UiTurnCheckpoint`, `HostActionResult` … the shapes the stage and the host commands both speak. |

`context.provideService(id, value)` and `context.useService(id, use)` are how
the extensions of one product reach one another without core learning what
travels between them: one publishes under an id its own protocol file names,
the others use it. `use` runs as soon as the value exists — before or after
the user's own activation — and whatever it returns is disposed when the
provider withdraws or either side deactivates, so activation order does not
matter. The shipped kits publish two: Workspace Kit's store as
`tau.workspace/store`, and Preview Kit's `tau.preview/browser`, whose
`open(url, actions)` brings the Preview panel forward and navigates — Project
Scripts opens a script's `previewUrl` through it, and falls back to
`actions.openExternal` when Preview Kit is off. `actions.copyText(text)` puts text on the user's clipboard and `actions.openExternal(url)` opens a URL in whatever the client calls a browser; both go through the client's `Platform`, so on a host across the network they still mean *this* machine.

Workspace Kit's store (`tau.workspace/store`, typed in
`kits/workspace/protocol.ts`) is such a service, and besides reading the
followed project it lends two places another kit may draw into:
`registerChangesSection(Component)` puts a section at the top of the Changes
panel, clean worktree or not, with the panel's `actions`, the commit message as
the user left it and `committed()` to hand the box back to the proposal; and
`registerThreadRowAccessory(Component)` draws a mark on every rail row, given
the row's `session`. `refresh()` re-reads the project's changes and Git facts
after another kit changed them. Review Kit fills both with the pull or merge
request of the branch.

A host half reaches another kit's host half with `context.invokeHostExtension(id,
command, input)`, and only for a command the target registered with
`{ callers: [<caller id>] }` (ADR 0020). Usage Kit (`kits/usage/`) is such a caller: a
runtime backend that keeps its own per-thread totals answers a `usage` command
granted to `tau.usage` with `{ threads: [{ threadId, cwd, model?, updatedAt, usage? }] }`,
`usage` being a `UiThreadUsage`, read from the kit's own store and never from the
provider. Claude Code and Antigravity answer it; a backend that adds it also adds
its row to `BACKEND_USAGE_SOURCES` in `kits/usage/protocol.ts`, and one that does
not answer is listed as not available.

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
`isWorkspaceRelativePath`, `gitExecutable`/`findExecutable`,
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
and settled, assistant start, delta, thinking and end, tool start, update and
end, the queue, notices, and `usage` when its `catalogView().usage` changed —
and core turns them into the same workbench events a Pi thread produces, keeps
the live turn state, closes the fold of a turn, and brackets the turn with the
turn observers, so checkpoints and status watchers do not care which program
answers. `ask(prompt)` puts a blocking question on the workbench's dialog
surface (the one Pi's extension dialogs use); aborting the thread answers it as
cancelled. The Claude Code kit is the reference: `kits/claude-code/` (ADR 0005).

`complete(request, model?)` asks a model for one short answer — a thread
title, a branch name, a commit message. It runs on the user's own model
configuration in `~/.pi/agent` and takes the model the extension names, or
the default from that configuration; it is deliberately apart from the thread
the job is about, because which program answers a conversation says nothing
about which model should name it, and a thread whose runtime cannot complete
would otherwise go unnamed. It needs the `sessions` permission. The models it accepts are the snapshot's
`completionModels`, which a `kind: "model"` option offers the user; they are the
same list whatever runtime owns the visible thread, while `models` stays that
thread's own.

A registered backend's `label` is what the workbench calls it where a new
thread's runtime is chosen (the composer's runtime chip, Settings → Defaults);
it defaults to the kind. The host publishes every installed backend, Pi first,
as `runtimeBackends` on the snapshot and the catalog, with `defaultBackendKind`
naming the one a client gets when it names none.

`services.sessions.start(options)` (`sessions`) creates a thread off screen:
`cwd`, the first `prompt`, and optionally `title`, `model`, `parent` and
`backend`. `backend` is the kind the thread runs on — `"pi"`, the default, or
any registered kind — and a kind nobody registered is refused before anything
is created. A model is applied through the runtime's `catalogWrite`
capability, so a runtime without model selection refuses one. `parent` is
written into a Pi thread's session file; a thread of another backend has no
such file, so the host keeps its link in the index for as long as it runs and
the extension that asked for it is the durable record. Agents Kit starts a
thread whose agent definition names a runtime this way.

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
| `threadDeleted(sessionId, cwd)` | the thread is gone for good: its session file was removed, or is about to be. Runtime eviction is **not** this — that is `HostTurnObserver.closed`. |
| `sweep(sweep)` | a periodic pass over every persisted session the host indexes. |

`threadDeleted` runs once per deletion, whether the host deleted the thread
itself (`services.sessions.remove(sessionId)`, the verb behind a rail's
"delete thread") or a sweep found the file gone. A throwing hook is reported
and the others still run: the thread is gone either way.

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
without asking the host what changed.

### `engines` and `engines.api`

`engines.tau`, `engines.pi` and `engines.api` are version ranges checked
against the running Tau, its bundled Pi, and `EXTENSION_API_VERSION`
(`src/shared/extension-compat.ts`, currently `1.9.0`) — the version of the
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
| `sessions` | read session files, threads and transcript entries, and hook into thread lifecycle and turns. `agentDir`, Pi's configuration directory, is plain bootstrap data every package may read. |
| `runtime:extend` | register Pi runtime extensions, load one Tau ships, register runtime backends, permission levels and UI decorators — the members that hand out a live runtime — and read a workspace's skill catalog (`skills`). |
| `process` | start processes, and call `noteSubprocess` and `findCommand` — the host-side bookkeeping for them. In a worker `child_process` is refused without the grant, by `require` and by `import()` alike. For an `in-process` package nothing is enforced. |
| `network` | reach the network. In a worker the grant gates `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest` and the socket builtins, by `require` and by `import()` alike. For an `in-process` package nothing is enforced. Either way it is a guardrail against a mistake, not a boundary against code written to get around it — see §6. |
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

`network` is the one permission not in `HOST_SERVICE_PERMISSIONS`: a package
that dials out never asks the host for anything, so there is no member to gate.
The worker enforces it for itself instead — see §6. `process` is enforced in
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

Two limits: an isolated (worker) package cannot use `callClient` at all, and a
client that has no window half (the browser client, a host nobody is attached
to) makes the call reject. Treat it as an optional capability and say what is
missing, the way Preview Kit answers "Preview needs the Tau desktop app on this
host".

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

**Turning it off.** `extensions.watch: false` in `~/.tau/config.json` (or
`<project>/.tau/config.json`), or `TAU_NO_WATCH=1` in the environment, stops
the host from watching anything; `/reload` then applies changes as before.
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
| `openWorkspace`, `knownWorkspacePath`, `pickDirectory`, `workspaceRef` | `registerRuntimeBackend`, `registerRuntimeExtension`, `loadRuntimeExtension`, `loadDependency` |
| `projectName`, `rememberProjectName`, `describeProjects` (round trip) | `decorateUiPrompt`, `setPermissionLevel`, `presentUi` |
| `runtimeOwner`, `thread(sessionId)` (a plain snapshot), `transcript`, `setThreadTitle` | `sessions.open` (a live `HostSessionFile`), `sessions.prepare`, `sessions.refreshIndex` |
| `noteSubprocess`, `findCommand`, `skills` | a `beforeActivate` transaction (a worker hook returns nothing, so it cannot roll back an activation) |
| `clients.observe`, `clients.count` | |
| `refreshExtensionPackages` | `listPackages`, `installPackage`, `removePackage`, `updatePackages` (installing hands the host a live progress callback) |
| `sessions.list`, `sessions.read` (entries as data), `sessions.exclusive` | anything else that would hand out a live host object |
| `registerThreadLifecycle`, `registerTurnObserver`, `setPendingWork`, `pinTranscriptEntries` (pins as data) | |
| `sessions.remove` | |
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
Settings → Defaults → Appearance and in the palette ("Theme: …", "Cycle the
theme"); the client writes it onto `<html>` and nothing else in the client ever
reads a colour.

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
stylesheet, a new accent and a new code face.

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
| `--mono` | code, labels and numbers | `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace` |
| `--sans` | everything else | `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` |
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

`--project-hue` is not a token: the thread row sets it per project, and
`--project-tint` and `--project-ink` say how deep that hue reads. The same goes
for the handful of layout variables a component sets on itself
(`--keep-clear-x`, `--composer-inset`, `--used`).
