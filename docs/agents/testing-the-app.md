# Testing the app: isolated instances and CDP driving

Verifying a change against the real Tau app must never touch the user's real `~/Library/Application Support/tau` or the Tau window they may already have open. `scripts/dev-instance.mjs` and `scripts/tau-cdp.mjs` exist for this; `.agents/skills/test-tau-app/SKILL.md` is the agent-facing version of this same material.

## Starting an isolated instance

`npm run dev:instance -- --build` starts Electron from the current worktree with its own userData and scratch workspace under that worktree's gitignored `.tau-dev/`, and a CDP port derived from a hash of the worktree's path (range 9300–9399, the next free one if that port is occupied). It builds first only when `dist-electron/main/index.js` is missing, unless `--build` forces one. It stays in the foreground until Electron exits, forwarding `SIGINT`/`SIGTERM` to the Electron process, and prints one line:

```
[dev-instance] pid=<pid> port=<port> userData=<path> workspace=<path> sessions=<path> log=<path>
```

Flags: `--safe` sets `TAU_NO_EXTENSIONS=1`; `--fresh` wipes this instance's userData, its isolated Pi session store and the runtime kits' thread stores beside it (`.tau-dev/tau`, where imported conversations land) before starting (guarded to only ever delete paths under `.tau-dev`); `--shared-sessions` opts back into the real `~/.pi/agent/sessions` (see below) for the rare test that needs the user's own threads; `--workspace <path>` uses an existing repository instead of creating the default scratch one (a fresh git repo with one commit); `--port <n>` pins the CDP port instead of deriving one; `--agent-dir <path>` sets `PI_CODING_AGENT_DIR`, Pi's own config directory, for this instance.

### A shadow agent dir, for testing keybindings.json

Pi keeps `keybindings.json` in its config directory (`~/.pi/agent` by default). To test a custom one without touching the real file, build a shadow directory and point `--agent-dir` at it:

```
mkdir -p /tmp/tau-shadow-agent
ln -s ~/.pi/agent/auth.json /tmp/tau-shadow-agent/auth.json
ln -s ~/.pi/agent/settings.json /tmp/tau-shadow-agent/settings.json
ln -s ~/.pi/agent/npm /tmp/tau-shadow-agent/npm
echo '{"app.session.new": "mod+shift+d"}' > /tmp/tau-shadow-agent/keybindings.json
npm run dev:instance -- --build --agent-dir /tmp/tau-shadow-agent
```

Symlink whatever the real dir has that the test still needs — auth, settings, the `npm` extension cache — so models and extensions keep working, and write `keybindings.json` as a plain file so it holds the test's own bindings. Never link it: Settings → Keybindings writes through a symlink to the file it points at. Never write to the real `~/.pi/agent`; only the shadow directory changes.

Because the default userData and workspace live under the worktree's own `.tau-dev/`, and there is no flag to point userData anywhere else, an isolated instance structurally cannot reach the user's real Tau data.

### Its Pi session store is isolated too

Pi (the coding agent Tau embeds) keeps every session under `~/.pi/agent/sessions/<encoded cwd>/`, and Tau's thread index lists all of them across every project the user has ever opened — that is how the sidebar's "All projects" grouping works. Without isolating this store, an instance's test threads would write into that real store and show up in the user's own Tau sidebar (this happened: a verification run once left twenty "Index n" sub-agent threads in a real user's projects).

By default `dev-instance.mjs` sets `PI_CODING_AGENT_SESSION_DIR=<worktree>/.tau-dev/pi-sessions`, so every session the instance creates, opens, or lists lives under that path instead — it never reaches `~/.pi/agent/sessions`, and threads it writes never reach the user's real sidebar. Pi's own directory is the instance's too: `PI_CODING_AGENT_DIR=<worktree>/.tau-dev/pi-agent`, where `auth.json`, `models.json`, `npm` and `extensions` link to the real `~/.pi/agent` and `settings.json`, `models-store.json`, `trust.json` and `keybindings.json` are copied once (Settings → Keybindings writes that file; a link an older instance made becomes a copy on the next start). Pi writes into its agent dir by itself (`lastChangelogVersion`, the default model when one is picked), so an instance on the real one changes the user's settings. Pass `--real-agent-dir` only for a test that must run on it. `--fresh` wipes `.tau-dev/pi-sessions` and `.tau-dev/tau` along with userData. Pass `--shared-sessions` to skip the override and use the real session store — only for a test that specifically needs the user's existing threads.

Tau's own settings get the same treatment: `TAU_CONFIG_FILE=<worktree>/.tau-dev/tau-config.json`, seeded once as a copy of the user's `~/.tau/config.json` (read, never written), `TAU_WORKTREES_DIR=<worktree>/.tau-dev/worktrees` for the worktrees its threads create, `TAU_THEMES_DIR=<worktree>/.tau-dev/themes` for the themes it saves (so the real `~/.tau/themes` is neither read nor written), and `TAU_HOST_TOKEN_FILE=<worktree>/.tau-dev/host-token` for the secret its host process and window share. A setting toggled in the instance — `hostBackground`, `threads.continueAfterRestart` — stays in the instance. `--fresh` reseeds the config.

The host's system service never reaches the machine's service manager from an instance: `TAU_SERVICE_UNIT_DIR=<worktree>/.tau-dev/service-units` is where its unit goes, and `TAU_SERVICE_CONTROL=scripts/fake-service-manager.mjs` stands in for `launchctl`, `systemctl` and `loginctl`. The fake starts the unit's program itself, detached, with the unit's environment, records its pid in `.tau-dev/service-units/.fake-state.json` and every call in `.fake-calls.log` there. Installing the service in Settings → Connections → Background (or `TAU_USER_DATA=<instance userData> TAU_SERVICE_UNIT_DIR=… TAU_SERVICE_CONTROL=… ELECTRON_RUN_AS_NODE=1 <electron> dist-electron/main/service-cli.js status`) therefore runs a real service host that takes over from the instance's own. That host outlives `npm run cdp -- stop` by design: uninstall the service in the instance before you stop it, or stop the pid in `.fake-state.json` yourself. Never install the service in an instance started without those two variables, and never run `tau service` outside one on this machine.

### Codex gets a shadow home

The Codex CLI keeps its sessions, config, logs and caches under `CODEX_HOME` (`~/.codex` by default), and a Codex thread writes there from its first turn. `dev-instance.mjs` therefore sets `CODEX_HOME=<worktree>/.tau-dev/codex-home` and prepares that directory the way the keybindings shadow above is prepared, with one difference: only `auth.json` is linked from `~/.codex`, nothing else, so the instance signs in as the user while every rollout, `config.toml` and SQLite file Codex writes lands under `.tau-dev`. A `CODEX_HOME` already set in the calling shell is kept as it is. By hand, for a test that drives `codex app-server` without an instance:

```
mkdir -p .tau-dev/codex-home
ln -s ~/.codex/auth.json .tau-dev/codex-home/auth.json
printf 'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"\n' > .tau-dev/codex-home/config.toml
CODEX_HOME=$PWD/.tau-dev/codex-home codex app-server
```

The `config.toml` is the shadow's own and pins the cheapest model, so a new Codex thread's first turn does not run on the account's default. List the models first (`model/list` on the app server, or the Codex page in Settings) and pick the smallest; ask for one-word answers. Never write into the real `~/.codex`.

### OpenCode gets a shadow home

OpenCode keeps its config, logins, database, logs and caches in the XDG folders (`~/.config/opencode`, `~/.local/share/opencode`, `~/.local/state/opencode`, `~/.cache/opencode`). The OpenCode kit reads `TAU_OPENCODE_HOME` as all four (`<home>/config`, `<home>/data`, `<home>/state`, `<home>/cache`) for the servers it starts, and `dev-instance.mjs` sets it to `<worktree>/.tau-dev/opencode-home`; a value set in the calling shell is kept. Nothing is linked from the real folders: OpenCode Zen's free models answer without a login, so a test prompt runs on one of them (`opencode/mimo-v2.6-flash-free`, say) and asks for a one-word answer. A test that needs another provider copies only that provider's entry of `auth.json` into `<home>/data/opencode/auth.json` — never an OAuth entry, whose refresh would rotate the user's own token. By hand:

```
mkdir -p .tau-dev/opencode-home
XDG_CONFIG_HOME=$PWD/.tau-dev/opencode-home/config XDG_DATA_HOME=$PWD/.tau-dev/opencode-home/data \
XDG_STATE_HOME=$PWD/.tau-dev/opencode-home/state XDG_CACHE_HOME=$PWD/.tau-dev/opencode-home/cache \
OPENCODE_SERVER_PASSWORD=test opencode serve --hostname 127.0.0.1 --port 0
```

Stop a server you started by its PID. For import tests, `<import root>/opencode` is such a home too: start a server over it, create a session and send one prompt, and Onboarding lists it.

### Cursor gets a shadow home, and usually the fake CLI

The Cursor CLI keeps its config and chats in `~/.cursor` and, on macOS, its login in the keychain. The Cursor kit reads `TAU_CURSOR_HOME` as that folder (`CURSOR_CONFIG_DIR` and `CURSOR_DATA_DIR`) with a file login (`AGENT_CLI_CREDENTIAL_STORE=file`), so a home is an account of its own; `dev-instance.mjs` sets it to `<worktree>/.tau-dev/cursor-home` (a caller's own value is kept). Nothing is linked from `~/.cursor`, and nobody signs in there for a test. A CLI older than 2026.04.08 has no `acp` and would take the word as a prompt, so the kit never starts one with it; `--version` and `about` are all it asks of such a CLI.

A test instance drives `kits/cursor/fixtures/fake-cursor-agent.mjs` instead: an ACP server over stdio that answers `--version`, `about --format json` and `acp`, keeps its sessions under `CURSOR_DATA_DIR`, and picks a scenario from words in the prompt (`permission`, `question`, `plan`, `todos`, `tool`, `mcp`, `history`, `transport`, `sleep`; anything else answers `pong from <model> …`). `FAKE_CURSOR_LOG=<file>` records every message Tau sent. Point the instance at it:

```
TAU_CURSOR_COMMAND=$PWD/kits/cursor/fixtures/fake-cursor-agent.mjs FAKE_CURSOR_LOG=$PWD/.tau-dev/cursor.log \
  env -u ELECTRON_RUN_AS_NODE npm run dev:instance -- --build --fresh
```

### Grok gets a shadow home, and the fake CLI

The Grok CLI keeps its config, login (`auth.json`) and sessions in `~/.grok`. The Grok kit reads `TAU_GROK_HOME` as `GROK_HOME`, and `dev-instance.mjs` sets it to `<worktree>/.tau-dev/grok-home` (a caller's own value is kept). Nothing is linked from `~/.grok`, nobody signs in for a test, and no `XAI_API_KEY` goes into a test instance.

Grok Build's CLI is not installed on this machine, so a test instance drives `kits/grok/fixtures/fake-grok.mjs`: it answers `--version`, `models` and `agent … stdio` (an ACP server with models in `initialize._meta`, `session/set_model` with a reasoning effort, xAI's `_x.ai/session/prompt_complete`, `ask_user_question`, `exit_plan_mode` and `turn_completed` usage), keeps its sessions under `GROK_HOME`, and picks a scenario from words in the prompt (`permission`, `question`, `plan`, `tool`, `mcp`, `history`, `args`, `silent` — answered only by the notification —, `ratelimit`, `sleep`; anything else answers `pong from <model> (<effort>)`). `FAKE_GROK_SIGNED_OUT=1` makes it signed out, `FAKE_GROK_LOG=<file>` records every message Tau sent. Point the instance at it:

```
TAU_GROK_COMMAND=$PWD/kits/grok/fixtures/fake-grok.mjs FAKE_GROK_LOG=$PWD/.tau-dev/grok.log \
  env -u ELECTRON_RUN_AS_NODE npm run dev:instance -- --build --fresh
```

### Earlier sessions to import come from fixtures

Onboarding lists and imports the conversations the agent CLIs kept in their own homes. `dev-instance.mjs` sets `TAU_IMPORT_ROOTS=<worktree>/.tau-dev/import-roots` (a caller's own value is kept), and with it set the backend kits read only `<root>/<backend kind>/…` — laid out like the CLI's own home — and never the user's. Put small synthetic sessions there to test the wizard; an instance with an empty folder finds nothing to import.

Preview's cookie import reads the same variable: with it set, it looks for browsers only under `<root>/browsers`, laid out like a home folder, and takes Chromium keys from `<root>/browsers/keychain.json` instead of the keychain. `writeFixtureHome` in `kits/preview/cookie-fixtures.ts` writes Chrome (two profiles), Firefox and Safari stores with a test secret; run it with `node --experimental-strip-types` from a small script. Never point it at, copy or read a real browser profile, and never trigger the real keychain from a test instance.

### A stub `gh` or `glab`

Anything that writes to a pull request is tested against a stub, never a real remote. Put an executable named `gh` (or `glab`) in a folder under `.tau-dev/`, have it answer from `kits/review/fixtures/` and append every call with its stdin to a log, then start the instance with that folder first on `PATH` and an empty `ZDOTDIR`:

```
mkdir -p .tau-dev/stub-bin .tau-dev/zdotdir
env -u ELECTRON_RUN_AS_NODE PATH="$PWD/.tau-dev/stub-bin:$PATH" ZDOTDIR="$PWD/.tau-dev/zdotdir" npm run dev:instance -- --build
git -C .tau-dev/workspace remote add origin git@github.com:acme/demo.git
```

The host reads PATH from a login shell; with the user's real `ZDOTDIR` that shell puts Homebrew's real `gh` in front of the stub. A stub must read stdin only when the call passes `--input -` or `--body-file -`: the kit leaves stdin open otherwise, and a stub that waits for it never answers. The remote only names the repository; nothing is pushed to it.

A stub for the merge workflows keeps a little state beside its log: `pr merge N` marks the branch's request merged (`--auto` arms, `--disable-auto` disarms), `pr view N --repo … --json state,headRefName,…` answers the head a deleted branch is checked against, `repos/<o>/<r>/stacks?pull_request=N` a stack whose layers `graphql --input -` names (memberships, titles, permissions, `updatePullRequestBranch`, `revertPullRequest`), and `merge-async` a merged stack. Every write then shows in the log with its arguments; nothing reaches GitHub. `TAU_THREAD_RAIL_SWEEP_MS=20000` makes Thread Rail settle a thread whose linked requests ended within half a minute.

### Stub `tea` and `az`, a fake Bitbucket API

The other providers are tested the same way. A stub `tea` answers `login list --output json` and `api --include …`, writing `HTTP/2.0 200 OK` to stderr (tea exits 0 on HTTP errors, and Review Kit reads the status there); a stub `az` answers `repos …` and `devops invoke …` and reads the body file `--in-file` names. Both can answer from `kits/review/fixtures/forgejo-*` and `azure-*`. Bitbucket has no CLI: start a local server that answers `/2.0/…` from `bitbucket-*`, point `TAU_BITBUCKET_API_URL=http://127.0.0.1:<port>/2.0` at it, and give the instance a Git config of its own whose credential helper prints a fake `username`/`password`, so the real keychain is never asked:

```
GIT_CONFIG_GLOBAL=$PWD/.tau-dev/stub/gitconfig GIT_CONFIG_NOSYSTEM=1 TAU_BITBUCKET_API_URL=http://127.0.0.1:9471/2.0 \
  env -u ELECTRON_RUN_AS_NODE PATH="$PWD/.tau-dev/stub-bin:$PATH" ZDOTDIR="$PWD/.tau-dev/zdotdir" npm run dev:instance -- --build --fresh
```

A `pushInsteadOf` in that config sends a push for the fake remote to a bare repository under `.tau-dev/`. A self-hosted server is chosen in Settings → Review → Self-hosted servers and lands in `.tau-dev/userdata/kit-state/tau.review/source-hosts.json`.

### Signing in without a real account

Sign-in and sign-out are never tried against a real account. Give the instance homes of its own and stubs, set before `npm run dev:instance` so its script keeps them: `CODEX_HOME` and the Agent SDK runtime's configuration folder (its `homeVariable`) pointing at empty folders under `.tau-dev/`, `TAU_CODEX_COMMAND` at a script that runs `kits/codex/fixtures/stub-app-server.mjs` for `app-server` (it logs in and out the way the protocol does; a ChatGPT login or a device code finishes when its page on 127.0.0.1 is fetched, the key `sk-stub-good` is taken) and flips the `signed-out` marker in `CODEX_HOME` for `login` and `logout`, the Agent SDK runtime's command variable at its kit's `fixtures/stub-cli.mjs` (its `auth login`, `auth status` and `auth logout` keep a file in that configuration folder), and `TAU_ANTIGRAVITY_ACP_COMMAND` at a fake ACP server (a shell script that runs a `.cjs` file with node, beside an executable `localharness_external`) that prints Google's link with a redirect to a listener of its own and stores a token once that listener is reached. An empty `ZDOTDIR` keeps the login shell from putting the real CLIs first.

Pi signs in through `--agent-dir` pointing at a folder of plain files — never the default `.tau-dev/pi-agent`, whose `auth.json` and `models.json` are links to the real ones (check with `ls -l`). Its `models.json` names a provider Pi's gateway login speaks to, `{ "providers": { "fakegw": { "oauth": "radius", "baseUrl": "http://127.0.0.1:47811/v1" } } }`, served by `node src/main/test-support/fake-oauth-gateway.ts 47811`: its consent page approves at once and redirects to Pi's callback listener, and fetching its `/device` page approves a device code. Stand in for the browser with `curl -sL` on the consent URL (the flow's `browser.url`) or on the device page; never press Open sign-in page, which opens the user's own browser. A key typed into a flow must end up only in that `auth.json`; grep `.tau-dev` for it afterwards.

### A runtime update without a real update

The update toast of a runtime backend runs the program's update command in a
Terminal Kit shell. Never let an instance run the real `brew upgrade` or
`npm install -g`: point `TAU_RUNTIME_UPDATE_COMMAND` at a script under
`.tau-dev/` (`{"codex":"<abs path>/fake-update.sh"}`) and `TAU_CODEX_COMMAND`
at a fake `codex` that answers `--version` from a file the script bumps. A
newer `latest` comes from seeding the kit's registry cache before the start,
`.tau-dev/userdata/kit-state/tau.codex/latest-version.json`
(`{"version":1,"packages":{"@openai/codex":{"version":"<newer>","checkedAt":<now ms>}}}`),
and `TAU_VERSION_POLICY='{"codex":{"ranges":[]}}'` keeps the policy banner out
of the way.

### Release notes without a release

The notes a new version shows once come from GitHub in an installed Tau. Start
an instance with `TAU_RELEASE_NOTES_FILE=<abs path>` (a Markdown body, the way
GitHub writes one) and it reads that file instead and fetches nothing. The
notes are due when `.tau-dev/userdata/release-notes.json` names an older
`lastVersion` than the running one: stop the instance, write
`{"version":1,"lastVersion":"0.0.1"}` there, and start it again without
`--fresh`.

### What CDP keys do not reach

`npm run cdp -- press` goes to the page. The app menu's accelerators (zoom,
Paste as Text) and the window's `before-input-event` (the ⌘Q hold) never see
it; drive those from the main process (`webContents.sendInputEvent`, a menu
item's `click`) or leave them to the unit tests.

## Keeping an instance alive across turns

An isolated instance is meant to outlive a single verification pass. `dev-instance.mjs` writes `.tau-dev/instance.json` (pid, port, userData, workspace, log path) on every start; check that file, or run `npm run cdp -- pid`, before starting a second instance that would only duplicate a live one.

This is about not restarting between passes of the same task, not about leaving an instance running forever: once the task is done, stop every instance you started, by PID (see "Tearing down" below), before you report.

## Driving an instance

`npm run cdp -- <command> [...args]` reads the port from `.tau-dev/instance.json` when none is given; pass one explicitly (`npm run cdp -- 9345 <command>`) to address a second, unrelated instance. Subcommands:

| Command | What it does |
| --- | --- |
| `snapshot` | A compact text outline: headings, buttons with aria-labels, thread rows (marking the active one), toasts, composer state, active dock panels. |
| `eval <expr>` | Runs an async JS expression in the renderer with `all`, `byText`, `rect`, `setValue`, `sleep`, `toasts` in scope. |
| `click <expr>` | Resolves `expr` to an element, scrolls it into view (a button below a short window's fold was clicked in empty space before) and dispatches real mouse events at its center, since a plain `.click()` is ignored by React-controlled sidebar rows. |
| `hover <expr>` | Moves the mouse onto the element's center and nowhere else, so a tooltip opens after its delay. |
| `rightclick <expr>` | A right-click at the element's center. Where the page asks for the OS's menu (`useContextMenu`), that menu is a native window CDP cannot reach: read it with `screencapture -l <id>` of a window your instance's PID owns, and `stop` closes it with the instance. |
| `type <expr> <text>` | Sets a textarea's value through its native setter and fires `input`. |
| `press <key>` | Dispatches a real key event (`Enter`, `Escape`, `Tab`, an arrow, `Home`, `End`, `F6`, or any single character), or a chord (`mod+shift+d`, `mod+k`, `ctrl+enter`) using the same spelling as the workbench's own keybindings — `mod` resolves to the platform's primary modifier (⌘ on macOS, Ctrl elsewhere). |
| `wait-for <expr> [timeoutMs]` | Polls `expr` until truthy (15 s default). |
| `screenshot <file.png>` | Writes a PNG via `Page.captureScreenshot`. |
| `toasts` | The toast stack as JSON: each toast's `level` (its type) and text. |
| `pid` | The instance's own Electron PID, found by checking the port's devtools endpoint and cross-referencing `ps`, so a caller kills only its own instance. |
| `stop` | Stops the instance: SIGTERM, then SIGKILL if it is still alive after ~2s. Electron's main process installs no SIGTERM handler of its own and does not reliably quit from one alone; prefer this over a bare `kill <pid>`. |

## A test prompt from a fresh instance

`.agents/skills/test-tau-app/SKILL.md` has the commands, checked against the current picker. Three things make it more than "type and press Enter":

- A `--fresh` instance opens the welcome wizard first (Continue, "Do not add projects", "Do not import").
- The instance copies the user's Pi `settings.json`, so a new draft starts on the user's default model, which may be expensive. Pick the cheap model in the picker by its option's aria-label (`GPT-5.6 Luna, Pi, …`), and check the chip's label before sending.
- Proof that the turn ran on it is the session file under `.tau-dev/pi-sessions/`: a `model_change` to the cheap model before the user message, and the assistant message's `"model"`.

## Known traps

`npm run cdp` without a port only drives an instance started from this worktree: a port read from `.tau-dev/instance.json` whose process runs from another worktree is refused, because a dead instance's port can be reused by someone else's. `dev-instance` also sets `TAU_RUNTIME_UPDATE_COMMAND` to `{"*": "echo …"}`, so an update toast in a test instance never runs a real `brew upgrade`, `npm install -g` or `claude update`.


`byText('button', /send/i)` can match a sidebar thread row whose title contains "send" (observed with the German "ungesendete"); the send button is the one with `aria-label === 'Send'`. While a turn streams, that button is replaced by a Stop button (`class="send-button stop"`, no `aria-label="Send"`) — `snapshot` reports this as the composer's `streaming` flag, and it is the more reliable signal that a reply is still in flight than the presence of a toast. The composer's `<textarea>` has no id or class of its own; querying the only `<textarea>` on the page is reliable because exactly one is ever mounted.

Stop the instance before `npm run dist` in the same worktree: while it runs, Chromium keeps dangling `Singleton*` symlinks in `.tau-dev/userdata`, and electron-builder aborts on the first one it cannot `stat`.

If the display has gone to sleep, `screencapture` returns a black or stale image; run it under `caffeinate -u` first to wake the display before capturing. And the renderer's own `screenshot` command never shows a preview `WebContentsView` — that is a separate native layer Chromium composites on top of the page, not part of what the renderer captures — so use `screencapture` (with `caffeinate -u`) when a preview pane needs to be visible in the image.

## Attached mode: the kits inside a Pi runtime Tau does not own

"Attached mode" is a real `pi` process holding the session while Tau is only a
client on its bridge socket. `npm run smoke:attached` proves the whole path in
about a minute:

```
npm run build            # dist-kits/<id>/pi.cjs is what the bridge loads
npm run smoke:attached   # add --keep to inspect the scratch workspace afterwards
```

What it does, and why each part is shaped the way it is:

- **A scratch repository** under `.tau-dev/attached-smoke/repo`, with a real
  copy of `.pi/extensions/tau-session-bridge.ts` in its own `.pi/extensions/`,
  so Pi discovers the bridge the way it does in this checkout. The bridge's
  relative imports (`../../src/...`) and `piKitsRoot` reach `src/`,
  `node_modules/` and `dist-kits/` through symlinks back into the worktree — a
  symlinked *bridge file* does not work, because jiti resolves its imports
  against the link's own directory. The prompt edits a file in that scratch
  repository, and Workspace Kit's checkpoint refs land in its `.git`, not in
  yours.
- **`PI_CODING_AGENT_SESSION_DIR` under `.tau-dev/`**, so the session file never
  reaches `~/.pi/agent/sessions` and never shows up in the user's own sidebar.
  Auth, models and packages are linked from the real `~/.pi/agent`; settings are the instance's own copy.
- **`expect` for the pty.** The bridge only starts its socket when
  `ctx.mode === "tui"` (`print`, `json` and `rpc` all skip it — that guard is
  what keeps Tau's own embedded Pi from attaching to itself), and the TUI needs
  a terminal. macOS `script` calls `tcgetattr` on *its own* stdin and fails
  under a pipe, so the smoke spawns `/usr/bin/expect`, which allocates the pty
  itself. Nothing is ever typed into that terminal.
- **A minimal bridge client** (`src/shared/pi-bridge-protocol.ts` is the wire):
  read the descriptor Pi wrote to `~/.pi/agent/tau-bridge/sessions/<id>.json`
  for its socket path and token, `hello`, then `prompt`, then `extension` for a
  kit's command — the same three frames Tau's host sends.

It then checks the session file itself: Workspace Kit's
`tau.turn-checkpoint.v1` entry with its `refs/tau/checkpoints/...` snapshots,
and the `session_info` entry Thread Title Generator wrote through
`pi.setSessionName`.

Teardown kills the PID in the descriptor and nothing else, and deletes the
scratch workspace unless you passed `--keep`.

## Tearing down

Run `npm run cdp -- stop` (SIGTERM, then SIGKILL after ~2s if the process is still alive — observed necessary in practice, since Electron's main process has no SIGTERM handler of its own and a bare `kill <pid>` can leave it running indefinitely). Never `pkill -f Electron` (or any pattern match on the binary name) — that also kills the user's own running Tau. Never `git stash` in the scratch workspace or the worktree.

## Advanced: the Electron client against a headless host

To test the socket transport instead of the embedded host, start a headless host with `node dist-electron/main/headless.js` (`TAU_WORKSPACE`, `TAU_USER_DATA`, `TAU_HOST_LISTEN=127.0.0.1:0`; see `scripts/remote-host-smoke.mjs` for the full pattern, including reading the printed listen URL and the `~/.tau/host-token` file) and start an ordinary window against it with `TAU_HOST_URL=ws://127.0.0.1:<port>`. `dev-instance.mjs` only starts the embedded-host path; wire this one by hand. For TLS, add `TAU_HOST_TLS=1` to the host and `TAU_HOST_FINGERPRINT=<the printed fingerprint>` to the window (without a pin the window asks on a native sheet that CDP cannot answer, so an agent always pins, or seeds `<userData>/known-hosts.json`); a wrong fingerprint must show `.host-connection-status.refused` in the window, never a native alert. `TAU_HOST_TOKEN_FILE` under `.tau-dev/` keeps the token out of `~/.tau`.
