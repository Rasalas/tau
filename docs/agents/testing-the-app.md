# Testing the app: isolated instances and CDP driving

Verifying a change against the real Tau app must never touch the user's real `~/Library/Application Support/tau` or the Tau window they may already have open. `scripts/dev-instance.mjs` and `scripts/tau-cdp.mjs` exist for this; `.agents/skills/test-tau-app/SKILL.md` is the agent-facing version of this same material.

## Starting an isolated instance

`npm run dev:instance -- --build` starts Electron from the current worktree with its own userData and scratch workspace under that worktree's gitignored `.tau-dev/`, and a CDP port derived from a hash of the worktree's path (range 9300–9399, the next free one if that port is occupied). It builds first only when `dist-electron/main/index.js` is missing, unless `--build` forces one. It stays in the foreground until Electron exits, forwarding `SIGINT`/`SIGTERM` to the Electron process, and prints one line:

```
[dev-instance] pid=<pid> port=<port> userData=<path> workspace=<path> sessions=<path> log=<path>
```

Flags: `--safe` sets `TAU_NO_EXTENSIONS=1`; `--fresh` wipes this instance's userData and its isolated Pi session store before starting (guarded to only ever delete paths under `.tau-dev`); `--shared-sessions` opts back into the real `~/.pi/agent/sessions` (see below) for the rare test that needs the user's own threads; `--workspace <path>` uses an existing repository instead of creating the default scratch one (a fresh git repo with one commit); `--port <n>` pins the CDP port instead of deriving one; `--agent-dir <path>` sets `PI_CODING_AGENT_DIR`, Pi's own config directory, for this instance.

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

Symlink whatever the real dir has that the test still needs — auth, settings, the `npm` extension cache — so models and extensions keep working, and write `keybindings.json` as a plain file so it holds the test's own bindings. Never write to the real `~/.pi/agent`; only the shadow directory changes.

Because the default userData and workspace live under the worktree's own `.tau-dev/`, and there is no flag to point userData anywhere else, an isolated instance structurally cannot reach the user's real Tau data.

### Its Pi session store is isolated too

Pi (the coding agent Tau embeds) keeps every session under `~/.pi/agent/sessions/<encoded cwd>/`, and Tau's thread index lists all of them across every project the user has ever opened — that is how the sidebar's "All projects" grouping works. Without isolating this store, an instance's test threads would write into that real store and show up in the user's own Tau sidebar (this happened: a verification run once left twenty "Index n" sub-agent threads in a real user's projects).

By default `dev-instance.mjs` sets `PI_CODING_AGENT_SESSION_DIR=<worktree>/.tau-dev/pi-sessions`, so every session the instance creates, opens, or lists lives under that path instead — it never reaches `~/.pi/agent/sessions`, and threads it writes never reach the user's real sidebar. Auth, models, settings, and extensions are unaffected and still come from the real `~/.pi/agent`, so models keep working. `--fresh` wipes `.tau-dev/pi-sessions` along with userData. Pass `--shared-sessions` to skip the override and use the real session store — only for a test that specifically needs the user's existing threads.

Tau's own settings get the same treatment: `TAU_CONFIG_FILE=<worktree>/.tau-dev/tau-config.json`, seeded once as a copy of the user's `~/.tau/config.json` (read, never written), `TAU_WORKTREES_DIR=<worktree>/.tau-dev/worktrees` for the worktrees its threads create, `TAU_THEMES_DIR=<worktree>/.tau-dev/themes` for the themes it saves (so the real `~/.tau/themes` is neither read nor written), and `TAU_HOST_TOKEN_FILE=<worktree>/.tau-dev/host-token` for the secret its host process and window share. A setting toggled in the instance — `hostBackground`, `threads.continueAfterRestart` — stays in the instance. `--fresh` reseeds the config.

### Codex gets a shadow home

The Codex CLI keeps its sessions, config, logs and caches under `CODEX_HOME` (`~/.codex` by default), and a Codex thread writes there from its first turn. `dev-instance.mjs` therefore sets `CODEX_HOME=<worktree>/.tau-dev/codex-home` and prepares that directory the way the keybindings shadow above is prepared, with one difference: only `auth.json` is linked from `~/.codex`, nothing else, so the instance signs in as the user while every rollout, `config.toml` and SQLite file Codex writes lands under `.tau-dev`. A `CODEX_HOME` already set in the calling shell is kept as it is. By hand, for a test that drives `codex app-server` without an instance:

```
mkdir -p .tau-dev/codex-home
ln -s ~/.codex/auth.json .tau-dev/codex-home/auth.json
printf 'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"\n' > .tau-dev/codex-home/config.toml
CODEX_HOME=$PWD/.tau-dev/codex-home codex app-server
```

The `config.toml` is the shadow's own and pins the cheapest model, so a new Codex thread's first turn does not run on the account's default. List the models first (`model/list` on the app server, or the Codex page in Settings) and pick the smallest; ask for one-word answers. Never write into the real `~/.codex`.

### Earlier sessions to import come from fixtures

Onboarding lists and imports the conversations the agent CLIs kept in their own homes. `dev-instance.mjs` sets `TAU_IMPORT_ROOTS=<worktree>/.tau-dev/import-roots` (a caller's own value is kept), and with it set the backend kits read only `<root>/<backend kind>/…` — laid out like the CLI's own home — and never the user's. Put small synthetic sessions there to test the wizard; an instance with an empty folder finds nothing to import.

## Keeping an instance alive across turns

An isolated instance is meant to outlive a single verification pass. `dev-instance.mjs` writes `.tau-dev/instance.json` (pid, port, userData, workspace, log path) on every start; check that file, or run `npm run cdp -- pid`, before starting a second instance that would only duplicate a live one.

This is about not restarting between passes of the same task, not about leaving an instance running forever: once the task is done, stop every instance you started, by PID (see "Tearing down" below), before you report.

## Driving an instance

`npm run cdp -- <command> [...args]` reads the port from `.tau-dev/instance.json` when none is given; pass one explicitly (`npm run cdp -- 9345 <command>`) to address a second, unrelated instance. Subcommands:

| Command | What it does |
| --- | --- |
| `snapshot` | A compact text outline: headings, buttons with aria-labels, thread rows (marking the active one), toasts, composer state, active dock panels. |
| `eval <expr>` | Runs an async JS expression in the renderer with `all`, `byText`, `rect`, `setValue`, `sleep`, `toasts` in scope. |
| `click <expr>` | Resolves `expr` to an element and dispatches real mouse events at its center, since a plain `.click()` is ignored by React-controlled sidebar rows. |
| `type <expr> <text>` | Sets a textarea's value through its native setter and fires `input`. |
| `press <key>` | Dispatches a real key event (`Enter`, `Escape`, `Tab`, an arrow, or any single character), or a chord (`mod+shift+d`, `mod+k`, `ctrl+enter`) using the same spelling as the workbench's own keybindings — `mod` resolves to the platform's primary modifier (⌘ on macOS, Ctrl elsewhere). |
| `wait-for <expr> [timeoutMs]` | Polls `expr` until truthy (15 s default). |
| `screenshot <file.png>` | Writes a PNG via `Page.captureScreenshot`. |
| `toasts` | The current toast list as JSON. |
| `pid` | The instance's own Electron PID, found by checking the port's devtools endpoint and cross-referencing `ps`, so a caller kills only its own instance. |
| `stop` | Stops the instance: SIGTERM, then SIGKILL if it is still alive after ~2s. Electron's main process installs no SIGTERM handler of its own and does not reliably quit from one alone; prefer this over a bare `kill <pid>`. |

## Known traps

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
  Auth, models and settings still come from the real `~/.pi/agent`.
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
