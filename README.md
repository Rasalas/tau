# Tau: throwaway Pi desktop prototype

> **PROTOTYPE, not production.** This repository answers one design question: can Pi remain the agent runtime while a desktop shell becomes independently extensible like Neovim?

Tau embeds the real `@earendil-works/pi-coding-agent` SDK in an Electron host. The renderer does not know Pi internals; it receives a small stream of host events. A separate desktop extension registry contributes sidebar modules, project sources, panels, commands, and tool presentation.

## Project documents

- [VISION.md](VISION.md) explains the product goal and guiding principles.
- [CONTEXT.md](CONTEXT.md) defines the product language used in code and discussions.
- [PLAN.md](PLAN.md) records the phased roadmap and open decisions.
- [docs/PERFORMANCE.md](docs/PERFORMANCE.md) records performance budgets and the optimization plan adapted from T3 Code.
- [ADR 0001](docs/adr/0001-embed-pi-behind-a-desktop-host.md) records why Pi runs behind a desktop host.
- [ADR 0002](docs/adr/0002-core-owns-placement-extensions-own-features.md) records why core owns placement while extensions own features.
- [ADR 0003](docs/adr/0003-core-owns-threads-extensions-own-navigation.md) records why thread semantics stay in core while navigation remains replaceable.

## Run

```bash
npm install
npm start
```

`npm start` builds and opens the Electron app. It uses your existing `~/.pi/agent` models, credentials, skills and extensions. The initial workspace is this repository; use the project picker in the left sidebar to open another folder. Recent projects persist in Electron's user-data directory.

For a UI-only browser preview with fixture data:

```bash
npm run dev:web
```

Start without Pi or desktop extensions to inspect or recover the minimal core:

```bash
npm run start:safe
```

## Prototype surface

- real Pi SDK session with streamed text, thinking and tool events
- recent Pi threads across projects, including project identity, Git branch, live activity, and a settled shelf
- searchable recent-project modal (`Cmd/Ctrl+P`) and extension-provided add-project sources
- working local-folder and Git-clone project flows, plus thread search (`/`)
- file index marked with the working tree's changes, and a Signals event stream
- full-window diff review (`Cmd/Ctrl+Shift+D`) with unified and split views, driven by a real `git diff`
- commit and push from the review, with the message editable before it runs
- composer-level model, thinking and access controls, plus a context dial wired to Pi's own usage and manual compaction
- model picker with provider tabs, cross-provider search and favourites
- clickable workspace bar under the composer: switch between the checkout and its worktrees, create a worktree for a new branch, and pick a ref from a searchable list
- enforced access levels: Pi has no permission model, so Tau installs an inline Pi extension that blocks `edit`, `write`, `bash` and `powershell` on read-only, and prompts for approval on ask-before-edits
- grouped command palette (`Cmd/Ctrl+K`) with arrow-key navigation, attributing every command to the extension that contributed it
- one settings page: workbench defaults, keybindings, and a click-through list of extensions rendered from the options each one declares
- Markdown rendering of messages — GFM tables, task lists, inline code, and syntax-highlighted code blocks with copy, all styled on the workbench palette; raw HTML is deliberately not enabled
- extension-provided tool renderers for reads, writes and shell commands
- thread title generation using the thread's own model, automatic after the first prompt and manual on demand
- extension-free safe mode with empty layout slots collapsed

## The seam under test

```text
Electron renderer                    Node host
┌──────────────────────────┐         ┌────────────────────────────┐
│ minimal workbench shell  │ events  │ Pi AgentSession SDK        │
│ + desktop extensions     │◄────────│ skills + Pi extensions     │
│ panels / commands / UI   │────────►│ tools / models / sessions  │
└──────────────────────────┘ commands└────────────────────────────┘
```

Desktop extensions implement one small interface:

```ts
interface DesktopExtension {
  id: string;
  name: string;
  activate(context: DesktopExtensionContext): void | (() => void);
}
```

The context currently accepts seven contribution types:

```ts
context.registerPanel(...);
context.registerSidebar(...);
context.registerProjectSource(...);
context.registerCommand(...);
context.registerPromptHook(...);
context.registerToolRenderer(...);
context.registerOptions(...);
```

Every contribution is stamped with the extension that supplied it, which is what lets the palette, panel headers and settings page attribute behaviour back to its source. `registerOptions` is the whole of the settings surface: an extension declares toggles and chip rows, and Tau renders the page from that declaration — an extension with no options shows only its on/off switch.

See `src/renderer/extension-system.tsx` and `src/renderer/extensions/index.tsx`. The left sidebar and right dock are empty core slots. Workspace Kit contributes the thread and project sidebar, local-folder and Git-clone sources, and Files. Review Kit contributes Changes and the diff review. Other bundled extensions contribute Signals, thread title generation, and the runtime commands.

## Deliberately missing

This prototype does not yet prove dynamic third-party package loading, extension isolation, extension UI dialogs, session tree navigation, editor/file mutation UI, mobile rendering or secure remote access. Those should only be built if the host/UI seam feels right in use.
