# Testing the app: isolated instances and CDP driving

Verifying a change against the real Tau app must never touch the user's real `~/Library/Application Support/tau` or the Tau window they may already have open. `scripts/dev-instance.mjs` and `scripts/tau-cdp.mjs` exist for this; `.agents/skills/test-tau-app/SKILL.md` is the agent-facing version of this same material.

## Starting an isolated instance

`npm run dev:instance -- --build` starts Electron from the current worktree with its own userData and scratch workspace under that worktree's gitignored `.tau-dev/`, and a CDP port derived from a hash of the worktree's path (range 9300–9399, the next free one if that port is occupied). It builds first only when `dist-electron/main/index.js` is missing, unless `--build` forces one. It stays in the foreground until Electron exits, forwarding `SIGINT`/`SIGTERM` to the Electron process, and prints one line:

```
[dev-instance] pid=<pid> port=<port> userData=<path> workspace=<path> log=<path>
```

Flags: `--safe` sets `TAU_NO_EXTENSIONS=1`; `--fresh` wipes this instance's userData before starting (guarded to only ever delete paths under `.tau-dev`); `--workspace <path>` uses an existing repository instead of creating the default scratch one (a fresh git repo with one commit); `--port <n>` pins the CDP port instead of deriving one.

Because the default userData and workspace live under the worktree's own `.tau-dev/`, and there is no flag to point userData anywhere else, an isolated instance structurally cannot reach the user's real Tau data.

## Keeping an instance alive across turns

An isolated instance is meant to outlive a single verification pass. `dev-instance.mjs` writes `.tau-dev/instance.json` (pid, port, userData, workspace, log path) on every start; check that file, or run `npm run cdp -- pid`, before starting a second instance that would only duplicate a live one.

## Driving an instance

`npm run cdp -- <command> [...args]` reads the port from `.tau-dev/instance.json` when none is given; pass one explicitly (`npm run cdp -- 9345 <command>`) to address a second, unrelated instance. Subcommands:

| Command | What it does |
| --- | --- |
| `snapshot` | A compact text outline: headings, buttons with aria-labels, thread rows (marking the active one), toasts, composer state, active dock panels. |
| `eval <expr>` | Runs an async JS expression in the renderer with `all`, `byText`, `rect`, `setValue`, `sleep`, `toasts` in scope. |
| `click <expr>` | Resolves `expr` to an element and dispatches real mouse events at its center, since a plain `.click()` is ignored by React-controlled sidebar rows. |
| `type <expr> <text>` | Sets a textarea's value through its native setter and fires `input`. |
| `press <key>` | Dispatches a real key event (`Enter`, `Escape`, `Tab`, an arrow, or any single character). |
| `wait-for <expr> [timeoutMs]` | Polls `expr` until truthy (15 s default). |
| `screenshot <file.png>` | Writes a PNG via `Page.captureScreenshot`. |
| `toasts` | The current toast list as JSON. |
| `pid` | The instance's own Electron PID, found by checking the port's devtools endpoint and cross-referencing `ps`, so a caller kills only its own instance. |

## Known traps

`byText('button', /send/i)` can match a sidebar thread row whose title contains "send" (observed with the German "ungesendete"); the send button is the one with `aria-label === 'Send'`. While a turn streams, that button is replaced by a Stop button (`class="send-button stop"`, no `aria-label="Send"`) — `snapshot` reports this as the composer's `streaming` flag, and it is the more reliable signal that a reply is still in flight than the presence of a toast. The composer's `<textarea>` has no id or class of its own; querying the only `<textarea>` on the page is reliable because exactly one is ever mounted.

## Tearing down

Kill exactly the PID `npm run cdp -- pid` names. Never `pkill -f Electron` (or any pattern match on the binary name) — that also kills the user's own running Tau. Never `git stash` in the scratch workspace or the worktree.

## Advanced: the Electron client against a headless host

To test the socket transport instead of the embedded host, start a headless host with `node dist-electron/main/headless.js` (`TAU_WORKSPACE`, `TAU_USER_DATA`, `TAU_HOST_LISTEN=127.0.0.1:0`; see `scripts/remote-host-smoke.mjs` for the full pattern, including reading the printed listen URL and the `~/.tau/host-token` file) and start an ordinary window against it with `TAU_HOST_URL=ws://127.0.0.1:<port>`. `dev-instance.mjs` only starts the embedded-host path; wire this one by hand.
