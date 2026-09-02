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
- [ADR 0004](docs/adr/0004-one-pi-runtime-per-thread.md) records why every open thread keeps its own Pi runtime.

## Run

```bash
npm install
npm start
```

`npm start` performs the minified production build and opens the Electron app. For development, use `npm run dev` (Electron + Vite hot reload) or `npm run dev:web` (browser fixture preview); `npm run start:existing` opens the last production assets without rebuilding. Build and startup measurements are written to `reports/build-report.json` and `reports/start-report.json`; `npm run build:budget` and `npm run start:budget` enforce the local budgets. It uses your existing `~/.pi/agent` models, credentials, skills and extensions. The initial workspace is this repository; use the project picker in the left sidebar to open another folder. Recent projects persist in Electron's user-data directory.

For a UI-only browser preview with fixture data:

```bash
npm run dev:web
```

Start without Pi or desktop extensions to inspect or recover the minimal core:

```bash
npm run start:safe
```

The production renderer is minified and does not ship source maps unless `TAU_SOURCEMAP=true` is explicitly set. Review, Settings, optional panels, and Highlight.js languages are demand-loaded; their slots expose a Retry action if a chunk cannot be loaded.

### Share a live session with Pi

Tau can attach to a Pi TUI that already owns the active session instead of opening a second `SessionManager`. Open Pi in the project first. For an already-running Pi session, run `/reload` once so Pi loads `.pi/extensions/tau-session-bridge.ts`, then start or restart Tau. Prompts, steering, aborts, assistant streaming, tool activity, model changes, thinking changes, compaction, and thread renames travel over an authenticated local socket and remain visible in both clients.

The Pi TUI is the sole writer while attached. Tau will not fall back to writing the same session if the owner is alive but unreachable. It retries a lost socket with bounded backoff and resnapshots automatically after Pi reloads or restarts the bridge. Enter `/reload` in Tau, or run “Reload Pi and desktop extensions” from the command palette, to reload Pi resources and rebuild the renderer-side extension registry. Electron main-process and preload changes still require an app restart; production source changes must be built first. Image prompts, Tau project-shell actions, Tau access-policy changes, new-session creation, and automatic title generation remain Pi-side operations in this mode. Safe mode refuses to attach because it cannot enforce safe-mode tool policy on a runtime owned by another process.

### Extend Tau while it runs

Tau loads desktop extensions the way Pi loads its own. Put a `.tsx` (or `.ts`) file in `~/.tau/extensions/`, or in `<project>/.tau/extensions/` for a project Pi trusts, and run `/reload`. The file default-exports a `DesktopExtension` and may import `react`, `lucide-react` and `tau` (the workbench hooks and types); the host compiles it with esbuild and the renderer binds those imports to its own copies. `examples/desktop-extensions/hello-panel.tsx` is a complete example; `tau.d.ts` next to it gives an editor the types.

Tau's own source can be changed from inside Tau too. `/rebuild` runs the production build without leaving the app and reloads the renderer; when the main process or preload changed, it says so and `/restart` relaunches the app. Both are also in the command palette.

## Prototype surface

- real Pi SDK session with streamed text, thinking and tool events
- recent Pi threads across projects, including project identity, Git branch, live activity, and a settled shelf
- searchable recent-project modal (`Cmd/Ctrl+P`) and extension-provided add-project sources
- working local-folder and Git-clone project flows, plus thread search (`/`)
- file index marked with the working tree's changes, and a Signals event stream
- full-window diff review (`Cmd/Ctrl+Shift+D`) with unified and split views, driven by a real `git diff`
- commit and push from the review, with the message editable before it runs
- composer-level model, thinking and access controls, plus a context dial wired to Pi's own usage and manual compaction
- composer autocomplete for Pi skills, prompt templates, and extension commands; skills are searchable as `$skill` or `/skill`, and the selected runtime adapter resolves the shorthand to its supported invocation form when sent
- `TAU_RUNTIME_ADAPTER=pi` (default) keeps the embedded Pi runtime; `TAU_RUNTIME_ADAPTER=claude-code` selects the Claude Code transport at host startup (optionally configured with `TAU_CLAUDE_CODE_COMMAND`)
- model picker with provider tabs, cross-provider search and favourites
- clickable workspace bar under the composer: switch between the checkout and its worktrees, create a worktree for a new branch, and pick a ref from a searchable list
- enforced access levels: Tau's inline Pi extension gates workspace mutations and computer-control actions; read-only threads retain inspection tools, while ask-before-edits requires approval before clicks, typing, launches, shell commands, and file changes
- built-in cross-platform computer use through `@amaster.ai/pi-computer-use` (Apache-2.0) and its bundled Cua Driver assets; safe mode excludes it, and an explicitly configured Pi package wins over Tau's bundled registration
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

The context accepts these contribution types:

```ts
context.registerPanel(...);
context.registerSidebar(...);
context.registerProjectSource(...);
context.registerCommand(...);
context.registerSlashCommand(...);   // `/name` in the composer, run in the workbench
context.registerKeybinding(...);     // "mod+k", "ctrl+shift+p", "escape" → a command id
context.registerPromptRenderer(...); // draws Pi dialogs it recognises, e.g. by a marker in `prompt.extras`
context.registerPromptHook(...);
context.registerToolRenderer(...);
context.registerOptions(...);
context.registerRegion(...);
context.registerStatusItem(...);
context.registerOverlay(...);
context.registerComposerControl(...);
context.registerTranscriptRows(...);
context.registerDocumentSource(...);
```

Every contribution is stamped with the extension that supplied it, which is what lets the palette, panel headers and settings page attribute behaviour back to its source. `registerOptions` is the whole of the settings surface: an extension declares toggles and chip rows, and Tau renders the page from that declaration — an extension with no options shows only its on/off switch.

See `src/renderer/extension-system.tsx` and `src/renderer/extensions/index.tsx`. The left sidebar and right dock are empty core slots. Workspace Kit contributes the thread and project sidebar, local-folder and Git-clone sources, and Files. Review Kit contributes Changes and the diff review. Other bundled extensions contribute Signals, thread title generation, and the runtime commands.

## Deliberately missing

This prototype does not yet prove dynamic third-party package loading, extension isolation, extension UI dialogs, session tree navigation, editor/file mutation UI, mobile rendering or secure remote access. Those should only be built if the host/UI seam feels right in use.
