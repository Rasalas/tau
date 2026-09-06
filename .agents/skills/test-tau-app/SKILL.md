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
[dev-instance] pid=<pid> port=<port> userData=<path> workspace=<path> log=<path>
```

Run it with `run_in_background` (or the harness's own backgrounding) — you need the terminal free to drive it. Flags: `--safe` (`TAU_NO_EXTENSIONS=1`), `--fresh` (wipes this instance's userData first — safe, since it never wipes outside `.tau-dev`), `--workspace <path>` (an existing repo instead of the scratch one), `--port <n>` (pin the port).

## Keep it alive across turns

Treat the verification loop, not one assistant turn, as the instance's lifetime. Do not stop it because one pass finished — a follow-up turn may reuse it. Before starting another one, check whether a live instance already answers: `npm run cdp -- pid` succeeds only while one is running, and `.tau-dev/instance.json` (written by `dev-instance.mjs`) names its port and userData.

## Drive it

```
npm run cdp -- <command> [...args]
```

reads the port from `.tau-dev/instance.json` automatically; pass one explicitly (`npm run cdp -- 9345 snapshot`) only when driving a second, unrelated instance.

- `snapshot` — a compact text outline of the workbench: headings, buttons with aria-labels, thread rows (marking the active one), toasts, composer state (`value`, `streaming`, `sendDisabled`, `sendBusy`), and active dock panels. Run this first on any turn, before clicking anything blind.
- `eval <expr>` — runs an async JS expression in the renderer. In scope: `all(sel)`, `byText(sel, /re/)`, `rect(el)`, `setValue(el, v)`, `sleep(ms)`, `toasts()`.
- `click <expr>` — resolves `expr` to an element and dispatches real `mouseMoved`/`mousePressed`/`mouseReleased` events at its center. A plain `el.click()` is ignored by React-controlled rows in the sidebar; this is why `click` exists instead of `eval`-ing `.click()`.
- `type <expr> <text>` — sets a textarea's value through its native setter and fires `input`, the way React's controlled composer expects.
- `press <key>` — dispatches a real key event: `Enter`, `Escape`, `Tab`, `Backspace`, an arrow, or any single character.
- `wait-for <expr> [timeoutMs]` — polls `expr` until truthy (default 15 s timeout).
- `screenshot <file.png>` — writes a PNG via `Page.captureScreenshot`.
- `toasts` — the current toast list as JSON.
- `pid` — the instance's own Electron PID, found by cross-checking the port's devtools endpoint against `ps`. Kill only this PID.

## Known traps

- Stop the instance before `npm run dist` in the same worktree: while it runs, Chromium keeps dangling `Singleton*` symlinks in `.tau-dev/userdata`, and electron-builder aborts on the first one it cannot `stat`.
- `byText('button', /send/i)` can match a sidebar thread row whose title happens to contain "send" (seen with German "ungesendete"). The send button is the one with `aria-label === 'Send'`; prefer `document.querySelector('.send-button[aria-label="Send"]')` or an exact-match regex.
- While a turn streams, the Send button is replaced by a Stop button (`class="send-button stop"`, no `aria-label="Send"`, `title="Stop the run"`). `snapshot`'s composer line reports this as `streaming=true` — wait for `streaming=false` again before asserting on a finished reply, not just for the toast.
- The composer `<textarea>` carries no id or class of its own; `document.querySelector('textarea')` is reliable because exactly one is ever mounted.
- Selecting a thread row still needs `click`, not `eval`-ing `.click()` on the row — see above.

## Tear down only your own PID

Stop exactly the PID `npm run cdp -- pid` names (or the one `dev-instance.mjs` printed). Never `pkill -f Electron` or `pkill -f electron` — that also kills the user's own running Tau. Never `git stash` in the scratch workspace or in this worktree. Never point `TAU_USER_DATA` anywhere but a path under this worktree's `.tau-dev/`; the isolated instance must never read or write the user's real `~/Library/Application Support/tau`.

## Advanced: testing the Electron client against a headless host

To verify the remote-client path instead of the embedded host, start a headless host (`node dist-electron/main/headless.js` with `TAU_WORKSPACE`, `TAU_USER_DATA`, `TAU_HOST_LISTEN=127.0.0.1:0` — see `scripts/remote-host-smoke.mjs` for the full pattern of spawning and reading the token) and start a normal window against it with `TAU_HOST_URL=ws://127.0.0.1:<port>` plus that host's `~/.tau/host-token`. `dev-instance.mjs` does not do this for you; wire the env vars by hand for this case.
