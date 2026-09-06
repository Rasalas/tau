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

**The Pi half** is not a separate manifest field: it is a Pi extension the
host half registers itself, in-process, with
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
  "host": "./host.ts"
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
| `desktop` / `host` | Relative entry paths inside the package folder; either may be missing, not both. |

`desktop` and `host` entries are compiled with esbuild at load time (Node
builtins and `electron` stay external for the host half, `react`, `react-dom`
and `lucide-react` stay external — bound to the renderer's own copies — for the
desktop half, because a second copy of React or of react-dom holds its own
internals and quietly stops working), so a package brings its own dependencies
from its own `node_modules` and needs no build step of its own.

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
(`id`, `label`, an optional `glyph` spelled the way panels spell theirs, an
optional `order`, and a `Component` receiving `SettingsPageProps`: `cwd` and
`onNotify`) — and `inspectPackages(cwd)`, which answers core's own scan of the
package folders and the shipped kits (`ExtensionInspection`) without loading
any code. Core keeps Defaults, Keybindings and the Inspector; every other page
is a contribution and is gone with its extension.

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
`reserveRegion`, and the workbench's own floats (menus, popovers, toasts) slide
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

It also lends two document surfaces core owns: `ReviewMode`, the full-workbench
review of a set of changes (file tree, diffs, line notes, commit box), and
`ChangesTree`, the changed files of a workspace with stage, unstage and revert.
Both load as their own chunk the first time they are rendered and bring their
own loading state, so an extension renders them like any other component. The
shapes their props speak — `UiWorkspaceChanges`, `UiChangedFile`, `UiFileDiff`,
`UiDiffHunk`, `UiDiffLine`, `DiffLoadOptions`, `WorkspaceChangesQuery`,
`WorkspaceDiffScope`, `ChangeStatus`, `UiEditor`, `UiWorkspaceChangesPage` —
are exported as types beside them.

`tau/host-extension` re-exports every host seam type, every type of the host
protocol (`src/shared/contracts.ts`: `UiMessage`, `UiComposerCommand`,
`GlobalHostEvent` — what `context.emit` becomes on the wire, which a package's
own tests read off the host harness — …) and of a runtime backend
(`ThreadRuntimeBackend`, `ThreadBackendPromptInput`, `AgentRuntimeAdapter`,
`RuntimeTransport`, `RuntimePermissionLevel`, … — types only, so nothing of
core is bundled), plus `HostCommandError`, `isExpectedCommandError`, the
permission and isolation vocabularies, the `PiShortcut` and `PiUserKeybindings`
types that `HostThread.shortcuts` and `runShortcut` speak, and the
text projections a package that reads transcripts needs: `textFromContent`
(content blocks to plain text), `visibleTitleText` (a raw skill wrapper reduced
to a safe label), `firstSentence`, `cleanThreadTitle` (a model's answer as a
thread title), `safeSessionTitle`, `buildTitleConversation` (a thread's first
exchanges as the prompt a title model reads) and `parseSkillEnvelope` /
`isSkillName` (Pi's skill envelope grammar). It also exports the contracts types
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

### `engines` and `engines.api`

`engines.tau`, `engines.pi` and `engines.api` are version ranges checked
against the running Tau, its bundled Pi, and `EXTENSION_API_VERSION`
(`src/shared/extension-compat.ts`, currently `1.2.0`) — the version of the
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
`engines` surfaces immediately. While Tau's own version is still `0.0.0`, pin
`engines.api` rather than `engines.tau`.

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
| `process` | spawn child processes and look up commands on the host's PATH. |
| `network` | open a socket: `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest` and the `http`/`https`/`net`/`tls`/`dgram`/`http2`/`dns` builtins. |
| `packages` | install, update, remove and list other extension packages (`listPackages`, `installPackage`, `removePackage`, `updatePackages`). Tau's own Packages kit holds it; a package that asks for it can add code that later runs, so read the request carefully. |

`services.agentDir` is ungated: it is the path of Pi's own configuration
directory (`~/.pi/agent`, or what `PI_AGENT_DIR` names), and reading inside it
is ordinary file work that no permission gates either. A worker gets it in its
bootstrap, so it costs no round trip. `services.sessionsDir` is its sibling:
the Pi session directory Tau actually uses (`PI_CODING_AGENT_SESSION_DIR` when
set, else `<agentDir>/sessions`). A package that persists thread-like state of
its own keeps it beside that directory, so an isolated test instance never
writes into the user's real store.

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
The worker enforces it for itself instead — see §6. For an `in-process`
package it stays advisory, because a package running in the host process can
reach everything the host process can; that is what granting `in-process`
means.

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
Update/Remove buttons per row. The page lists the kits Tau ships above the
installed packages and never offers to remove one: shipping a kit is the
approval, so it carries no grant and no source to drop.

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
lies, which is also how you develop one: edit it in place, `/reload`.

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
- **What the user sees:** the deactivation reason is recorded in
  `summaries()` and shown on the package's own settings page — never a crash
  or a frozen workbench. On the renderer side every slot a package renders
  (panel, sidebar item, status item, etc.) sits behind a `LazyFeatureBoundary`
  that deactivates the package and raises a toast instead of blanking the
  workbench on a render error.

## 6. What an isolated (worker) package cannot use

By default a package's host half runs in a worker thread: no Electron
(`import "electron"` throws, intercepted through `Module._load`, the only hook
Node 22.14 gives Electron for this), no network unless it asked for it, a
256 MB heap cap, and a facade that only carries plain data across the port —
nothing that hands out a live object. From
`src/main/host-extension-worker-protocol.ts` and ADR 0009:

| Available in a worker | Not available — declare `"isolation": "in-process"` instead |
|---|---|
| `cwd`, `log`, `safeMode` | `attachedRuntime` (a live Pi terminal) |
| `openWorkspace`, `knownWorkspacePath`, `pickDirectory`, `workspaceRef` | `registerRuntimeBackend`, `registerRuntimeExtension`, `loadRuntimeExtension` |
| `projectName`, `rememberProjectName`, `describeProjects` (round trip) | `decorateUiPrompt`, `setPermissionLevel`, `presentUi` |
| `runtimeOwner`, `thread(sessionId)` (a plain snapshot), `transcript`, `setThreadTitle` | `sessions.open` (a live `HostSessionFile`), `sessions.prepare`, `sessions.refreshIndex` |
| `noteSubprocess`, `findCommand`, `skills` | a `beforeActivate` transaction (a worker hook returns nothing, so it cannot roll back an activation) |
| `refreshExtensionPackages` | `listPackages`, `installPackage`, `removePackage`, `updatePackages` (installing hands the host a live progress callback) |
| `sessions.list`, `sessions.read` (entries as data), `sessions.exclusive` | anything else that would hand out a live host object |
| `registerThreadLifecycle`, `registerTurnObserver`, `setPendingWork`, `pinTranscriptEntries` (pins as data) | |

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

### The network, in a worker

A worker that was not granted `network` has no way out. Before the package's
bundle is loaded, `host-extension-worker.ts` replaces whichever of `fetch`,
`WebSocket`, `EventSource` and `XMLHttpRequest` this Node defines on the worker
global, and refuses `require`/`import` of `http`, `https`, `net`, `tls`,
`dgram`, `http2` and `dns` — under any `node:` prefix and any submodule, so
`node:dns/promises` is the same door as `dns`. Both throw
`Extension <id> lacks permission network` and log `host-extension.denied`, so
Signals and the Inspector show a denied socket exactly like a denied service
member. A bundled `ws` or `undici` needs `net`/`tls`, so it hits the same wall.
`child_process` is *not* on that list: spawning stays governed by `process`.

An `in-process` package is a different story. It runs with everything the host
process can reach, so `network` there is advisory and the approval box says so:
"network access is enforced only for isolated packages". If you want the
permission to mean something, stay in the worker.

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
