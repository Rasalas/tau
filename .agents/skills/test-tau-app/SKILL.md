---
name: test-tau-app
description: Launch, retain, and drive an isolated Tau desktop instance to verify a change in the real app — its own userData, scratch workspace, and CDP port, never the user's real ~/Library/Application Support/tau or their own running Tau. Use when an agent needs to run Tau, confirm a UI or host change actually works, take a screenshot, read toasts or thread state, or send a prompt through the composer.
---

# Test the Tau app

Tau is the Electron app this repo builds. Use this skill instead of starting `electron .` by hand, so verification never touches the user's real data or their own running window.

## Start an isolated instance

Run from the repository root:

```
npm run dev:instance -- --build
```

It builds only if `dist-electron/main/index.js` is missing (pass `--build` to force one), then starts Electron with its own userData and scratch workspace under this worktree's gitignored `.tau-dev/`, and a CDP port derived from the worktree's path (9300–9399, next free if occupied). It stays in the foreground and prints exactly one line:

```
[dev-instance] pid=<pid> port=<port> userData=<path> workspace=<path> sessions=<path> log=<path>
```

The instance also gets its own Pi session store, `.tau-dev/pi-sessions`, via `PI_CODING_AGENT_SESSION_DIR`. Pi normally keeps every session under `~/.pi/agent/sessions/<encoded cwd>/`, and Tau's thread index lists all of them across every project — without this, an instance's test threads (a verification run's "Index n" sub-agent threads, for example) would land in the user's real session store and show up in their own Tau sidebar under "All projects". Pi's own directory is the instance's too: `PI_CODING_AGENT_DIR=<worktree>/.tau-dev/pi-agent`, where `auth.json`, `models.json`, `npm` and `extensions` link to the real `~/.pi/agent` and `settings.json`, `models-store.json`, `trust.json` and `keybindings.json` are copied once (Settings → Keybindings writes that file; a link an older instance made becomes a copy on the next start). Pi writes into its agent dir by itself (`lastChangelogVersion`, the default model when one is picked), so an instance on the real one changes the user's settings. Pass `--real-agent-dir` only for a test that must run on it. Pass `--shared-sessions` for the rare test that needs the user's own real threads (it skips the override and reads/writes `~/.pi/agent/sessions` directly — treat it like `--workspace` pointing outside `.tau-dev`: only use it when the test is specifically about the user's existing threads).

Run it with `run_in_background` (or the harness's own backgrounding) — you need the terminal free to drive it. Flags: `--safe` (`TAU_NO_EXTENSIONS=1`), `--fresh` (wipes this instance's userData and its `.tau-dev/pi-sessions` first — safe, since it never wipes outside `.tau-dev`), `--shared-sessions` (use the real `~/.pi/agent/sessions` instead of the isolated one), `--workspace <path>` (an existing repo instead of the scratch one), `--port <n>` (pin the port), `--agent-dir <path>` (sets `PI_CODING_AGENT_DIR`, Pi's own config directory, for this instance).

### Testing a custom keybindings.json without touching the real one

`--agent-dir <path>` points the instance at a directory of your own instead of the real `~/.pi/agent` — the one place Pi keeps `keybindings.json`. Build a shadow directory rather than editing the real one:

```
mkdir -p /tmp/tau-shadow-agent
ln -s ~/.pi/agent/auth.json /tmp/tau-shadow-agent/auth.json
ln -s ~/.pi/agent/settings.json /tmp/tau-shadow-agent/settings.json
ln -s ~/.pi/agent/npm /tmp/tau-shadow-agent/npm
echo '{"app.session.new": "mod+shift+d"}' > /tmp/tau-shadow-agent/keybindings.json
npm run dev:instance -- --build --agent-dir /tmp/tau-shadow-agent
```

Symlink whatever the test needs from the real dir (auth, settings, the `npm` extension cache, …) so models and extensions keep working; write `keybindings.json` itself as a plain file so the instance reads your test's bindings — never a link, since Settings → Keybindings writes through a symlink to its target. Never write into the real `~/.pi/agent` — the shadow directory is the only thing that ever changes.

### Codex runs in a shadow home

`dev-instance` sets `CODEX_HOME=.tau-dev/codex-home`, which links only `auth.json` from `~/.codex`; every session and config file Codex writes stays there. Never start Codex against the real `~/.codex`. Pin the cheapest model in that shadow's own `config.toml` (`model = "gpt-5.6-luna"`, `model_reasoning_effort = "low"`) before a Codex thread's first prompt; `docs/agents/testing-the-app.md` has the recipe.

### Session imports read fixtures only

`dev-instance` also sets `TAU_IMPORT_ROOTS=.tau-dev/import-roots` (a caller's own value is kept): Onboarding's import then reads `<root>/<backend kind>/…` and never the user's own CLI homes. Write small synthetic sessions there to test it.

## Keep it alive across turns

Treat the verification loop, not one assistant turn, as the instance's lifetime. Do not stop it because one pass finished — a follow-up turn may reuse it. Before starting another one, check whether a live instance already answers: `npm run cdp -- pid` succeeds only while one is running, and `.tau-dev/instance.json` (written by `dev-instance.mjs`) names its port and userData.

**But stop it once the task itself is done.** "Keep it alive across turns" is about not restarting between passes of the same task — it is not license to leave an instance running once you deliver your final report. When you are about to report your work as finished, stop every instance you started, by PID (see "Tear down only your own PID" below), before you report.

## Drive it

```
npm run cdp -- <command> [...args]
```

reads the port from `.tau-dev/instance.json` automatically; pass one explicitly (`npm run cdp -- 9345 snapshot`) only when driving a second, unrelated instance.

- `snapshot` — a compact text outline of the workbench: headings, buttons with aria-labels, thread rows (marking the active one), toasts, composer state (`value`, `streaming`, `sendDisabled`, `sendBusy`), and active dock panels. Run this first on any turn, before clicking anything blind.
- `eval <expr>` — runs an async JS expression in the renderer. In scope: `all(sel)`, `byText(sel, /re/)`, `rect(el)`, `setValue(el, v)`, `sleep(ms)`, `toasts()`.
- `click <expr>` — resolves `expr` to an element, scrolls it into view and dispatches real `mouseMoved`/`mousePressed`/`mouseReleased` events at its center. A plain `el.click()` is ignored by React-controlled rows in the sidebar; this is why `click` exists instead of `eval`-ing `.click()`.
- `hover <expr>` — moves the mouse onto the element's center without pressing, so a tooltip opens after its delay.
- `rightclick <expr>` — a right-click at the element's center. Where the page asks for the OS's menu, that menu is a native window CDP cannot drive; capture it with `screencapture -l <id>` of a window your instance's PID owns and stop the instance to close it.
- `type <expr> <text>` — sets a textarea's value through its native setter and fires `input`, the way React's controlled composer expects.
- `press <key>` — dispatches a real key event: `Enter`, `Escape`, `Tab`, `Backspace`, an arrow, `Home`, `End`, `F6`, or any single character. Also takes a chord — `mod+shift+d`, `mod+k`, `ctrl+enter` — with the same spelling as the workbench's own keybindings; `mod` resolves to the platform's primary modifier (⌘ on macOS, Ctrl elsewhere). Use this to fire a keybinding instead of clicking.
- `wait-for <expr> [timeoutMs]` — polls `expr` until truthy (default 15 s timeout).
- `screenshot <file.png>` — writes a PNG via `Page.captureScreenshot`.
- `toasts` — the current toast list as JSON.
- `pid` — the instance's own Electron PID, found by cross-checking the port's devtools endpoint against `ps`. Kill only this PID.
- `stop` — stops the instance: SIGTERM, then SIGKILL if it is still alive after ~2s. Electron's main process does not reliably quit on SIGTERM alone (it installs no handler of its own) — use this instead of a bare `kill <pid>`, which can leave the process running indefinitely.

## Recipe: from a fresh instance to a test reply

A `--fresh` instance opens the welcome wizard, and it inherits the user's Pi default model from the copied `settings.json`, which may be an expensive one. Never send before the chip names a cheap model: GPT-5.6 Luna (or Codex's smallest with the shadow `CODEX_HOME`); never Sol, Fable or Opus.

```
# welcome wizard: agents → projects → conversations
npm run cdp -- click "byText('button', /^Continue/)"
npm run cdp -- click "byText('button', /^Do not add projects/)"
npm run cdp -- click "byText('button', /^Do not import/)"

# a new thread's draft, then the model
npm run cdp -- press mod+n
npm run cdp -- click "all('button').find(b => /^Select model/.test(b.getAttribute('aria-label') ?? ''))"
npm run cdp -- click "all('[role=option]').find(o => /^GPT-5\.6 Luna, Pi\b/.test(o.getAttribute('aria-label') ?? ''))"
npm run cdp -- eval "all('button').map(b => b.getAttribute('aria-label') ?? '').find(t => /^Select model/.test(t))"
#   must print "Select model: GPT-5.6 Luna" — otherwise stop here

# send, then wait for the assistant's message and the end of the stream
npm run cdp -- type "document.querySelector('textarea')" "Reply with one word: ok"
npm run cdp -- press Enter
npm run cdp -- wait-for "document.querySelector('.message.assistant') && !document.querySelector('.send-button.stop')" 90000
npm run cdp -- snapshot
```

- Picker rows are `role="option"` with an aria-label `<model>, <runtime or instance>, <billing>[, in use]`; the search field has the focus when the picker opens, so typing narrows it across all runtimes. Pick by aria-label, not by text: several runtimes can offer the same model.
- Proof of the model: the thread's session file under `.tau-dev/pi-sessions/` has a `model_change` to `gpt-5.6-luna` before the user message, and the assistant message carries `"model":"gpt-5.6-luna"`. A `model_change` to the inherited default at the very start is normal.
- Waiting for a word of the reply in the page's text is a trap: the prompt itself contains it.
- In zsh, call `npm run cdp -- …` per step; a command kept in a variable (`C="npm run cdp --"; $C …`) is not split into words.

## Known traps

- Stop the instance before `npm run dist` in the same worktree: while it runs, Chromium keeps dangling `Singleton*` symlinks in `.tau-dev/userdata`, and electron-builder aborts on the first one it cannot `stat`.
- `byText('button', /send/i)` can match a sidebar thread row whose title happens to contain "send" (seen with German "ungesendete"). The send button is the one with `aria-label === 'Send'`; prefer `document.querySelector('.send-button[aria-label="Send"]')` or an exact-match regex.
- While a turn streams, the Send button is replaced by a Stop button (`class="send-button stop"`, no `aria-label="Send"`, `title="Stop the run"`). `snapshot`'s composer line reports this as `streaming=true` — wait for `streaming=false` again before asserting on a finished reply, not just for the toast.
- The composer `<textarea>` carries no id or class of its own; `document.querySelector('textarea')` is reliable because exactly one is ever mounted.
- Selecting a thread row still needs `click`, not `eval`-ing `.click()` on the row — see above.
- If the display has gone to sleep, `screencapture` returns a black or stale image; run it under `caffeinate -u` (a synthetic user-activity tick) first to wake the display before capturing.
- The renderer's own `screenshot` command (`Page.captureScreenshot` on the main window) never shows a preview `WebContentsView` — that view is a separate native layer Chromium composites on top, not part of the renderer's page. Use `screencapture` (with `caffeinate -u` per above) to see it.

## Tear down only your own PID

Stop exactly the PID `npm run cdp -- pid` names (or the one `dev-instance.mjs` printed) — `npm run cdp -- stop` does this and escalates to SIGKILL if a bare `kill` would not have been enough. Never `pkill -f Electron` or `pkill -f electron` — that also kills the user's own running Tau. Never `git stash` in the scratch workspace or in this worktree. Never point `TAU_USER_DATA` anywhere but a path under this worktree's `.tau-dev/`; the isolated instance must never read or write the user's real `~/Library/Application Support/tau`. The same goes for the Pi session store: leave `PI_CODING_AGENT_SESSION_DIR` at its default (`--shared-sessions` aside) so test threads never land in the user's real `~/.pi/agent/sessions`.

## Advanced: attached mode, where a `pi` TUI owns the session

A change to a kit's `pi` entry, to `.pi/extensions/tau-session-bridge.ts` or to
`src/main/pi-kit-extensions.ts` is not covered by an isolated instance: there
Tau owns the runtime. Run `npm run build && npm run smoke:attached` for that
path. It starts a real `pi` TUI in a throwaway git repository under
`.tau-dev/attached-smoke/`, attaches over the bridge socket the way the host
does, sends one prompt with GPT-5.6 Luna and checks the session file for the
two kit entries. `docs/agents/testing-the-app.md` explains the moving parts
(the pty, the symlinks, the `ctx.mode === "tui"` guard). It kills only the PID
in the bridge descriptor.

## Advanced: testing the Electron client against a headless host

To verify the remote-client path instead of the embedded host, start a headless host (`node dist-electron/main/headless.js` with `TAU_WORKSPACE`, `TAU_USER_DATA`, `TAU_HOST_LISTEN=127.0.0.1:0` — see `scripts/remote-host-smoke.mjs` for the full pattern of spawning and reading the token) and start a normal window against it with `TAU_HOST_URL=ws://127.0.0.1:<port>` plus that host's `~/.tau/host-token`. `dev-instance.mjs` does not do this for you; wire the env vars by hand for this case. For TLS, add `TAU_HOST_TLS=1` to the host and `TAU_HOST_FINGERPRINT=<the printed fingerprint>` to the window (without a pin the window asks on a native sheet that CDP cannot answer, so an agent always pins, or seeds `<userData>/known-hosts.json`); a wrong fingerprint must show `.host-connection-status.refused` in the window, never a native alert. `TAU_HOST_TOKEN_FILE` under `.tau-dev/` keeps the token out of `~/.tau`.
