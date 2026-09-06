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

## Tearing down

Run `npm run cdp -- stop` (SIGTERM, then SIGKILL after ~2s if the process is still alive — observed necessary in practice, since Electron's main process has no SIGTERM handler of its own and a bare `kill <pid>` can leave it running indefinitely). Never `pkill -f Electron` (or any pattern match on the binary name) — that also kills the user's own running Tau. Never `git stash` in the scratch workspace or the worktree.

## Advanced: the Electron client against a headless host

To test the socket transport instead of the embedded host, start a headless host with `node dist-electron/main/headless.js` (`TAU_WORKSPACE`, `TAU_USER_DATA`, `TAU_HOST_LISTEN=127.0.0.1:0`; see `scripts/remote-host-smoke.mjs` for the full pattern, including reading the printed listen URL and the `~/.tau/host-token` file) and start an ordinary window against it with `TAU_HOST_URL=ws://127.0.0.1:<port>`. `dev-instance.mjs` only starts the embedded-host path; wire this one by hand.
