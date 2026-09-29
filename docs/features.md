# What Tau does

The first builds of Tau set out to prove that Pi can stay the agent runtime while a desktop shell around it becomes independently extensible. This is what the workbench does with Pi today, across the core and the kits Tau ships. Other runtimes are in [Runtimes and tools](runtimes.md); other machines, the browser and the phone in [Hosts, machines and devices](hosts.md).

- real Pi SDK session with streamed text, thinking and tool events
- recent Pi threads across projects, including project identity, the Git branch Workspace Kit supplies, live activity, and a settled shelf
- searchable recent-project modal (`Cmd/Ctrl+P`) and extension-provided add-project sources
- working local-folder and Git-clone project flows, plus thread search (`/`)
- file index marked with the working tree's changes, and a Signals event stream
- full-window diff review (`Cmd/Ctrl+Shift+D`) with unified and split views, driven by a real `git diff`
- commit and push from the review, with the message editable before it runs
- composer-level model, thinking and access controls, plus a context dial wired to Pi's own usage and manual compaction
- composer autocomplete for Pi skills, prompt templates, and extension commands; skills are searchable as `$skill` or `/skill`, and the selected runtime adapter resolves the shorthand to its supported invocation form when sent
- `@` file mentions in the composer, expanded to the file's workspace-relative path the way Pi reads it
- `!` shell commands from the composer, run through the login shell with their output styled in the transcript
- prompt history that survives a restart, plus a search over it
- open the workspace in the user's own editor (`Cmd/Ctrl+O`) or terminal (`Cmd/Ctrl+J`), and the draft prompt in the editor (`Cmd/Ctrl+E`)
- a runtime per thread, with Pi as the default ([Which runtime a thread gets](runtimes.md#which-runtime-a-thread-gets))
- model picker with provider tabs, cross-provider search and favourites
- the branch in the thread's head is a menu: switch or create a branch, open, add or remove a worktree; "New thread" asks for the project first (the one in context selected, ↵ confirms), and the new thread's page offers project, machine ("Run on") and branch (its own worktree, its `tau/…` branch and the base) as pills under its heading
- enforced access levels: Tau's inline Pi extension gates workspace mutations and computer-control actions; read-only threads retain inspection tools, while ask-before-edits requires approval before clicks, typing, launches, shell commands, and file changes
- a Preview panel (`/preview <url>`, `Cmd/Ctrl+Shift+B`) showing a real browser view the host draws over the dock, and `preview_open/navigate/status/snapshot/screenshot/click/type/press/scroll/evaluate/wait_for/resize/set_appearance/recording_start/recording_stop` tools so the agent can read and drive the page it just changed; a floating picture of what an agent drives while the panel is hidden
- `request_takeover` for every runtime: when only the user can go on (a sign-in, a 2FA code, a captcha), a Your turn card above the composer brings the Preview, the driven app or a page in the user's own browser forward, offers to bring a signed-in session over from the user's browser, holds Computer Use, the Preview and evidence pictures, and Done hands control back
- built-in cross-platform computer use through `@amaster.ai/pi-computer-use` (Apache-2.0) and its bundled Cua Driver assets; safe mode excludes it, and an explicitly configured Pi package wins over Tau's bundled registration
- grouped command palette (`Cmd/Ctrl+K`) with arrow-key navigation, attributing every command to the extension that contributed it
- one settings page: workbench defaults, keybindings, and a click-through list of extensions rendered from the options each one declares
- Markdown rendering of messages: GFM tables, task lists, inline code, and syntax-highlighted code blocks with copy, all styled on the workbench palette; raw HTML is deliberately not enabled
- extension-provided tool renderers for reads, writes and shell commands
- thread title generation on a small model (the one the settings name, else one close to the thread's), automatic after the first prompt and manual on demand
- extension-free safe mode with empty layout slots collapsed
