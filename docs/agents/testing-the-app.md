# Testing the app: isolated instances and CDP driving

Verifying a change against the real Tau app must never touch the user's real `~/Library/Application Support/tau` or the Tau window they may already have open. `scripts/dev-instance.mjs` and `scripts/tau-cdp.mjs` exist for this; `.agents/skills/test-tau-app/SKILL.md` is the agent-facing version of this same material.

## Starting an isolated instance

`npm run dev:instance -- --build` starts Electron from the current worktree with its own userData and scratch workspace under that worktree's gitignored `.tau-dev/`, and a CDP port derived from a hash of the worktree's path (range 9300–9399, the next free one if that port is occupied). It builds first only when `dist-electron/main/index.js` is missing, unless `--build` forces one. It stays in the foreground until Electron exits, forwarding `SIGINT`/`SIGTERM` to the Electron process, and prints one line:

```
[dev-instance] pid=<pid> port=<port> userData=<path> workspace=<path> sessions=<path> log=<path>
```

Flags: `--safe` sets `TAU_NO_EXTENSIONS=1`; `--fresh` wipes this instance's userData, its isolated Pi session store and the runtime kits' thread stores beside it (`.tau-dev/tau`, where imported conversations land) before starting (guarded to only ever delete paths under `.tau-dev`); `--shared-sessions` opts back into the real `~/.pi/agent/sessions` (see below) for the rare test that needs the user's own threads; `--workspace <path>` uses an existing repository instead of creating the default scratch one (a fresh git repo with one commit); `--port <n>` pins the CDP port instead of deriving one; `--agent-dir <path>` sets `PI_CODING_AGENT_DIR`, Pi's own config directory, for this instance. `--as-installed` starts it the way the Finder starts an installed app: no `TAU_WORKSPACE`, working directory `/` (so the host opens the last project it knows); it refuses `--fresh` and an instance without a saved project, since the host would otherwise open the real home folder.

### It never takes focus

The user works on this Mac while instances, smokes and benchmarks run, so none of them may take focus. `dev-instance.mjs` sets `TAU_NO_FOCUS=1`, and Tau's main process then (`src/main/background-mode.ts`):

- sets the macOS activation policy to `accessory`: no Dock icon, and the app never becomes the active one;
- creates its window with `show: false` and shows it with `showInactive()`;
- turns every later `show()` into `showInactive()` and ignores `focus()` and `app.focus({ steal: true })`, whoever calls them: `tau app`, a kit's window half, a notification click.

The window still shows and paints at full frame rate (`document.visibilityState` is `visible`, `requestAnimationFrame` runs at 60 Hz), so CDP driving, screenshots and paint timings are unchanged. Only `document.hasFocus()` is false. `TAU_FOREGROUND=1` in the calling shell overrides `TAU_NO_FOCUS` for a check that needs the key window. The installed app sets neither variable and behaves as before. `benchmark:compare` and `compare:screens` start both apps the same way (see "T3 Code comparison" in `docs/PERFORMANCE.md`), and the Electron fixtures of `benchmark:renderer` and `start:report` run as `accessory` too. The smokes start no window at all.

To check it, sample the frontmost app while something runs, reading only: `lsappinfo info "$(lsappinfo front)"` names it, and `lsappinfo list` shows an instance as `type="UIElement"` instead of `"Foreground"`. Never use System Events or `osascript` to put an app in front for such a check.

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

Tau's own settings get the same treatment: `TAU_CONFIG_FILE=<worktree>/.tau-dev/tau-config.json`, seeded once as a copy of the user's `~/.tau/config.json` (read, never written), `TAU_WORKTREES_DIR=<worktree>/.tau-dev/worktrees` for the worktrees its threads create, `TAU_THEMES_DIR=<worktree>/.tau-dev/themes` for the themes it saves (so the real `~/.tau/themes` is neither read nor written), `TAU_EXTENSION_GRANTS_FILE=<worktree>/.tau-dev/extension-grants.json` for the packages it approves, and `TAU_HOST_TOKEN_FILE=<worktree>/.tau-dev/host-token` for the secret its host process and window share. A setting toggled in the instance — `hostBackground`, `threads.continueAfterRestart` — stays in the instance. `--fresh` reseeds the config.

The host's system service never reaches the machine's service manager from an instance: `TAU_SERVICE_UNIT_DIR=<worktree>/.tau-dev/service-units` is where its unit goes, and `TAU_SERVICE_CONTROL=scripts/fake-service-manager.mjs` stands in for `launchctl`, `systemctl` and `loginctl`. The fake starts the unit's program itself, detached, with the unit's environment, records its pid in `.tau-dev/service-units/.fake-state.json` and every call in `.fake-calls.log` there. Installing the service in Settings → Connections → Background (or `TAU_USER_DATA=<instance userData> TAU_SERVICE_UNIT_DIR=… TAU_SERVICE_CONTROL=… ELECTRON_RUN_AS_NODE=1 <electron> dist-electron/main/service-cli.js status`) therefore runs a real service host that takes over from the instance's own. That host outlives `npm run cdp -- stop` by design: uninstall the service in the instance before you stop it, or stop the pid in `.fake-state.json` yourself. Never install the service in an instance started without those two variables, and never run `tau service` outside one on this machine.

### Invisible display

The display units (`tau service install --display`, Linux only) are tested the same way: `npm run smoke:display` installs them through the fake service manager, which starts Xvfb and the Tau window as ordinary processes of the smoke, checks that a preview call starts the window, that the window draws a frame, that it starts again after a stop, and that uninstalling stops everything. The fake manager carries a Wayland desktop's `WAYLAND_DISPLAY`, `WAYLAND_SOCKET` and `XDG_SESSION_TYPE` (`systemctl --user set-environment`), as a machine with a desktop session does, and the smoke checks that neither the host, the window (started with `--ozone-platform=x11`) nor a terminal of the host sees them. On macOS, or without Xvfb, it says so and passes; it runs on the Linux CI runner. Never install the display units against a real systemd from a test.

Checklist for the user, on the Linux machine itself (rex), after `sudo apt install xvfb` and `tau service install --display`:

1. `tau service status` shows `display: :N (Xvfb running; window stopped, …)`, and `systemctl --user status tau-xvfb.service` is active.
2. In a Tau terminal on that machine, `echo $DISPLAY` prints `:N`, `echo "[$WAYLAND_DISPLAY][$XDG_SESSION_TYPE]"` prints `[][]` even with a desktop session, and `xdpyinfo -display "$DISPLAY" | head -3` answers (package `x11-utils`).
3. Open a page in the preview from a thread on that machine (from the Mac, through the machine's connection): `systemctl --user status tau-window.service` turns active, the preview shows the page, no Tau window appears on the machine's own screen, and `xlsclients` in a Tau terminal lists the window.
4. Leave it alone for 10 minutes: `tau-window.service` is inactive again; the next preview call starts it.
5. `tau service install --no-display`: both display units are gone, the host runs on, and a new terminal has no `DISPLAY`.

### Codex gets a shadow home

Claude's config and login live under `CLAUDE_CONFIG_DIR` (`~/.claude` and the keychain entry that belongs to it by default). `dev-instance.mjs` sets `CLAUDE_CONFIG_DIR=<worktree>/.tau-dev/claude-home`, empty and with no link to the real one, so the Agent SDK runtime and Usage's plan limits in an instance see no login and never the user's numbers. A value already set in the calling shell is kept.

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

Sign-in and sign-out are never tried against a real account. Give the instance homes of its own and stubs, set before `npm run dev:instance` so its script keeps them: `CODEX_HOME` and the Agent SDK runtime's configuration folder (its `homeVariable`) pointing at empty folders under `.tau-dev/`, `TAU_CODEX_COMMAND` at a script that runs `kits/codex/fixtures/stub-app-server.mjs` for `app-server` (it logs in and out the way the protocol does; a ChatGPT login or a device code finishes when its page on 127.0.0.1 is fetched, the key `sk-stub-good` is taken) and flips the `signed-out` marker in `CODEX_HOME` for `login` and `logout`, the Agent SDK runtime's command variable at its kit's `fixtures/stub-cli.mjs` (its `auth login`, `auth status` and `auth logout` keep a file in that configuration folder; driven by the SDK it plays one scripted turn per prompt — two `Bash` calls, the first failing, a refused `Read`, then "Done." — and `wait <ms>` in the prompt slows each step), and `TAU_ANTIGRAVITY_ACP_COMMAND` at a fake ACP server (a shell script that runs a `.cjs` file with node, beside an executable `localharness_external`) that prints Google's link with a redirect to a listener of its own and stores a token once that listener is reached. An empty `ZDOTDIR` keeps the login shell from putting the real CLIs first.

Pi signs in through `--agent-dir` pointing at a folder of plain files — never the default `.tau-dev/pi-agent`, whose `auth.json` and `models.json` are links to the real ones (check with `ls -l`). Its `models.json` names a provider Pi's gateway login speaks to, `{ "providers": { "fakegw": { "oauth": "radius", "baseUrl": "http://127.0.0.1:47811/v1" } } }`, served by `node src/main/test-support/fake-oauth-gateway.ts 47811`: its consent page approves at once and redirects to Pi's callback listener, and fetching its `/device` page approves a device code. Stand in for the browser with `curl -sL` on the consent URL (the flow's `browser.url`) or on the device page; never press Open sign-in page, which opens the user's own browser. A key typed into a flow must end up only in that `auth.json`; grep `.tau-dev` for it afterwards.

### A runtime update without a real update

The update toast of a runtime backend runs the program's update command in a
Terminal Kit shell. A test instance offers no update at all: `dev-instance`,
`tau-test-host.mjs`, the smokes and the benchmarks set
`TAU_NO_RUNTIME_UPDATES=1`, so no backend's version carries a `latest` and
nothing asks npm or Cursor for one. Start with `TAU_NO_RUNTIME_UPDATES=0` to test
the toast itself. Never let an instance run the real `brew upgrade` or
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

### Servers: fakes

The Servers kit (SSH, SFTP, FTP targets) is tested against fakes on this machine only. Never a real server, account or password, never the real keychain (`/usr/bin/security`, `secret-tool`, `op`, `pass`, `gopass`, `bw`), never `~/.ssh/config`, `~/.ssh/known_hosts`, the real ssh-agent or a key of the user's, and never a real `.vscode/sftp.json`. Everything lives in `.tau-dev/servers/`:

| File | What it is |
|---|---|
| `id_ed25519`, `id_ed25519_passphrase` | Test keys; the second has the passphrase `test-passphrase` |
| `ssh_config` | The only config a test `ssh`/`sftp` runs with (`-F`); `Host fake` and `fake-password` point at the fake server |
| `known_hosts` | `UserKnownHostsFile` of that config; `GlobalKnownHostsFile` is `/dev/null` |
| `agent.sock`, `agent.pid` | The test ssh-agent, holding `id_ed25519` |
| `root/`, `home/` | The fake server's files (`root/site/index.php`) and its HOME (with `tmp/`) |
| `keychain.json`, `secret-tool.json` | The stub keychains' items, passwords base64-encoded |
| `calls.log` | One JSON line per call to any fake: `tool` is `ssh`, `ftp`, `security` or `secret-tool`; passwords are never written |

`dev-instance` prepares the folder and sets, whatever the caller's shell has:

- `TAU_SERVERS_SECURITY_COMMAND` → `kits/servers/fixtures/fake-security.mjs`, `TAU_SERVERS_SECRET_TOOL_COMMAND` → `fake-secret-tool.mjs`, and `FAKE_SERVERS_STATE` → `.tau-dev/servers`;
- `TAU_SERVERS_SSH_CONFIG` → `.tau-dev/servers/ssh_config`, which the kit passes as `-F`;
- `SSH_AUTH_SOCK` → `.tau-dev/servers/agent.sock`, a test `ssh-agent -D` it starts with the test key added; it drops `SSH_AGENT_PID`. The login shell only fills variables that are unset, so the real agent never comes back. When the instance exits, `dev-instance` stops that agent by its PID (`sshAgentPid` in `.tau-dev/instance.json`);
- `TAU_SERVERS_LOOPBACK_ONLY=1`: the kit refuses every target but 127.0.0.1, `::1` and `localhost`. The tests set it too, and remove `SSH_AUTH_SOCK` from their environment.
- `TAU_SERVERS_PROJECTS_ROOT` → `.tau-dev/projects`: Add project → From a server… starts there for a new project and for a folder with sftp.json, and `create-project`, `inspect-folder`, `link-scan` and `link-folder` refuse any local folder outside it (links resolved). The headless test host (`tau-test-host.mjs`) sets its own below `.tau-dev/test-host/`, with the loopback guard.

The fake SSH server runs beside the instance. It needs `ssh2`, a devDependency, and the machine's own `sftp-server`:

```
node kits/servers/fixtures/fake-ssh-server.mjs --dir .tau-dev/servers --trust-host-key &
ssh -F .tau-dev/servers/ssh_config fake 'echo ok'
printf 'ls site\nget site/index.php /tmp/index.php\n' | sftp -F .tau-dev/servers/ssh_config -b - fake
node kits/servers/fixtures/fake-ssh-server.mjs stop --dir .tau-dev/servers
```

It listens on 127.0.0.1 on a free port, with a fresh ed25519 host key each start. It writes `fake-ssh.json` (port, pid, fingerprint), points `Host fake` in `ssh_config` at the port, and drops the stale `known_hosts` lines for that port. `--trust-host-key` adds the new key to `known_hosts`; leave it out to test the host-key question. `tester` gets in with either test key (from the file or the agent), with the password `test` (`fake-password` turns keys off), and with `--otp <code>` only after a `Verification code:` prompt as well. `--no-password` turns passwords off, `--read-only` makes SFTP read-only. `exec` runs `/bin/sh -c` in the fake HOME (under a pty with `ssh -t`), the `sftp` subsystem runs `sftp-server -d root/`, and `-W`/ProxyJump reaches loopback only. `calls.log` records every connection, authentication (method, result, no secret), command, exit code and SFTP operation. SFTP paths outside `root/` and `home/` are marked `"outside": true`. Without `--sandbox` it is not a sandbox: a command or an absolute path runs as you on this machine, so keep tests inside the folder. With `--sandbox` (macOS only) `exec`, the shell and `sftp-server` run under `sandbox-exec`: they write only below `root/` and `home/`, cannot read your real HOME, and reach no network but loopback. Start it with `--sandbox` before a real model sends commands through `server_exec`. `stop` ends the PID in `fake-ssh.json`, nothing else. A test starts it in-process with `startFakeSshServer({ dir })`; `kits/servers/fixtures/*.d.mts` has the types.

The fake FTP server is `ftp-srv` (MIT, devDependency). Run it as its own process, because it exits whatever process it runs in on SIGTERM:

```
node kits/servers/fixtures/fake-ftp-server.mjs --dir .tau-dev/servers --mode explicit [--require-tls] &
curl --ssl-reqd --cacert .tau-dev/servers/tls/cert.pem --user tester:test ftp://127.0.0.1:<port>/site/
node kits/servers/fixtures/fake-ftp-server.mjs stop --dir .tau-dev/servers
```

`--mode plain` offers no TLS, `explicit` offers `AUTH TLS`, and `implicit` is TLS from the first byte. `--require-tls` refuses a login before TLS. The certificate is self-signed for 127.0.0.1 and made once with `openssl`. The port is in `fake-ftp.json`. It serves the same `root/`. Each command goes to `calls.log` with `"tls": true|false`, and `PASS` is redacted.

The stubs answer the way the real tools do. `fake-security.mjs` handles `find-generic-password` (attributes on stdout; with `-g`, `password: "…"` on stderr, or `0x<HEX>  "…"` when not printable ASCII; `-w`), `add-generic-password` (`-U`), `delete-generic-password`, `dump-keychain` (without `-d`) and `-i` with those commands on stdin. It uses the real exit codes: 44 for not found, 45 for a duplicate. Anything else exits 2. It starts no process. `kits/servers/fixtures/fake-keychain.test.ts` shows this with a spawn trace and a trap `security` first on `PATH`. Seed an item the way the VS Code SFTP fork stores one:

```
FAKE_SERVERS_STATE=$PWD/.tau-dev/servers kits/servers/fixtures/fake-security.mjs add-generic-password \
  -s vscode-sftp -a "sftp://tester@127.0.0.1:<port>/site" -l "tester@127.0.0.1 (site)" -w test
```

`fake-secret-tool.mjs` handles `store --label=… <attr> <value>…` (the secret comes from stdin), `lookup`, `clear` and `search`. Afterwards, `grep -r <password> .tau-dev` should find nothing: the stub stores are base64.

Optionally, Docker gives a real OpenSSH. Publish its port on 127.0.0.1 only, and name the container `tau-test-…` so you remove only your own:

```
docker run -d --name tau-test-sftp -p 127.0.0.1:2222:22 \
  -v "$PWD/.tau-dev/servers/id_ed25519.pub:/home/tester/.ssh/keys/id_ed25519.pub:ro" atmoz/sftp tester:test:1001::site
docker run -d --name tau-test-openssh -p 127.0.0.1:2223:2222 -e USER_NAME=tester -e USER_PASSWORD=test -e PASSWORD_ACCESS=true \
  -e PUBLIC_KEY_FILE=/keys/id_ed25519.pub -v "$PWD/.tau-dev/servers/id_ed25519.pub:/keys/id_ed25519.pub:ro" lscr.io/linuxserver/openssh-server
ssh -F .tau-dev/servers/ssh_config -p 2223 tester@127.0.0.1 'echo ok'
docker rm -f tau-test-sftp tau-test-openssh
```

`atmoz/sftp` is SFTP only, chrooted to `/home/tester`, with the site under `/site`. `linuxserver/openssh-server` has a shell. Neither writes to `calls.log`.

`ssh` resolves a relative `Include` in a config against the real home (`pw_dir`), not `$HOME`. A test config for `ssh -G` or `ssh -F` therefore uses absolute `Include` paths only; a relative one would read below the real `~/.ssh`.

### Servers: end to end

The whole flow, once over SSH and once over FTPS, in one instance. Check `uptime` first, keep every file under `.tau-dev/`, and test prompts on GPT-5.6 Luna only.

1. **Fakes and a site.** `env -u ELECTRON_RUN_AS_NODE npm run dev:instance -- --build --fresh` in the background. Put a small site under `.tau-dev/servers/root/<site>/` with a test the agent can run locally (a `test.mjs` that checks the pages will do), and `git init` it there, so the server's Git is its own and not this worktree's. Start the SSH fake with `--trust-host-key --sandbox`: a real model sends commands through `server_exec`.
2. **Project from the server.** Add project → From a server… → `fake` → Connect → the site → Use this folder → Create project. Parent folder starts at `.tau-dev/projects` (`TAU_SERVERS_PROJECTS_ROOT`), and the host refuses one outside it. The new repository has one commit, "Server state …", and a clean `git status`.
3. **A colleague.** Change a file and add one on the server: `ssh -F .tau-dev/servers/ssh_config fake "cd <root>/<site> && …"`. Then open a new thread in the project: the draft checks the server again, and the first prompt stops at "The server has changes the repository lacks". Import as branch, then Merge into main; the prompt goes on after that.
4. **The agent works locally.** Pick GPT-5.6 Luna, ask it to change a page and run the test. Its `bash` runs in the network sandbox; the session file names `gpt-5.6-luna`.
5. **Upload through the card.** Ask for `server_propose_upload`; the card's Upload button writes, nothing before it (`calls.log` has only reads until the click). The mode of a changed file stays.
6. **Check on the server.** Ask for `server_exec` with a harmless command (`grep -c … index.html`). At the target's default level "ask" a question comes first; `calls.log` has the `exec` only after Yes, as `cd '<root>' && { … }`.
7. **Roll back, upload again, commit.** Server chip → History → Roll back… → the preview's button; the server file is back. Upload again from Not uploaded, or from a paired phone's Servers sheet (`npm run cdp:mobile -- launch --fresh`, `pair`, then open the thread and the sheet). Commit locally; History marks the deployment `committed`.
8. **FTPS.** Start `fake-ftp-server.mjs --dir .tau-dev/servers-ftps --mode explicit --require-tls`, put a copy of its site in a folder under `.tau-dev/projects/` with a `.vscode/sftp.json` (`"protocol": "ftp"`, `"secure": true`, the fake's port, `"remotePath": "/<site>"`) and seed a `vscode-sftp` item for `ftp://tester@127.0.0.1:<port>/<name>` in the stub keychain. Add project → From a server… → Folder with sftp.json: trust the certificate (the fingerprint matches `openssl x509 -fingerprint -sha256` of the fake's), allow the keychain item, Create Git repository. A colleague uploads with `curl --ssl-reqd --cacert …/tls/cert.pem --user tester:test -T <file> ftp://127.0.0.1:<port>/<site>/`. Steps 3 to 7 work the same, except that FTP runs no commands: check with `server_read` instead of `server_exec`. Every command after `AUTH TLS` in `calls.log` has `"tls": true`.
9. **Afterwards.** `calls.log` has no `"outside": true`. Stop the phone, the instance, both fakes (`… stop --dir …`) and check their PIDs.

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
| `click <expr>` | Resolves `expr` to an element, scrolls it into view (a button below a short window's fold was clicked in empty space before) and dispatches real mouse events at its center, since a plain `.click()` is ignored by React-controlled sidebar rows. `click <expr> <x> <y>` clicks at that fraction of the element instead (a button inside a Preview picture). |
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

- An instance starts past the welcome wizard: `dev:instance` writes Onboarding's "completed" mark into the instance's kit state. `--onboarding` removes it, for tests of the wizard (Continue, "Do not add projects", "Do not import").
- The instance copies the user's Pi `settings.json`, so a new draft starts on the user's default model, which may be expensive. Pick the cheap model in the picker by its option's aria-label (`GPT-5.6 Luna, Pi, …`), and check the chip's label before sending.
- Proof that the turn ran on it is the session file under `.tau-dev/pi-sessions/`: a `model_change` to the cheap model before the user message, and the assistant message's `"model"`.

## Known traps

`npm run cdp` without a port only drives an instance started from this worktree: a port read from `.tau-dev/instance.json` whose process runs from another worktree is refused, because a dead instance's port can be reused by someone else's. `dev-instance` also sets `TAU_NO_RUNTIME_UPDATES=1`, so a test instance shows no update toast at all, and `TAU_RUNTIME_UPDATE_COMMAND` to `{"*": "echo …"}`, so one it shows anyway (`TAU_NO_RUNTIME_UPDATES=0`) never runs a real `brew upgrade`, `npm install -g` or `claude update`. On the phone, toasts sit at the bottom above the composer and under every sheet; swipe one sideways or tap its × before tapping near it.


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

## Remote access: a phone against the instance

Remote access (pairing, the compact client, reconnects, the proxy listener, the app) is tested on this machine only: a headless Chromium that behaves like a phone, a headless host on loopback, a fake Tailscale Serve and the iOS Simulator. None of it listens beyond 127.0.0.1, announces the real Bonjour type or runs the real `tailscale`. What only a real phone can show is in `docs/mobile-device-checklist.md`, which the user runs.

Three helpers, each touching only what it started (recorded under `.tau-dev/`, checked against `ps` before any signal):

| Helper | What it is |
| --- | --- |
| `npm run cdp:mobile -- …` (`scripts/tau-mobile-cdp.mjs`) | A headless Chromium as an iPhone, iPad or Android phone: device metrics, safe-area insets, a coarse pointer, an iOS user agent and real touch events (`Input.dispatchTouchEvent`). Its profile, and so the paired token, lives in `.tau-dev/mobile/chrome-profile`. |
| `node scripts/tau-test-host.mjs …` | A headless host with its own home, userData and token under `.tau-dev/test-host` (`--name <name>`: `.tau-dev/test-host-<name>`), on 127.0.0.1, optionally with the proxy listener (`--proxy`) or TLS (`--tls`). |
| `node mobile/scripts/sim-device.mjs …` | A simulator of this worktree's own: create, boot, install, launch and the automation bridge in one step, and `down` deletes exactly that device. |

The phone uses Playwright's Chromium from `~/Library/Caches/ms-playwright` (`~/.cache/ms-playwright` on Linux), else an installed Chrome or Chromium, else `TAU_MOBILE_CHROME`. It opens only loopback URLs and names that `launch --resolve` maps to 127.0.0.1.

### The phone: pair, prompt, reconnect

With an instance running (`env -u ELECTRON_RUN_AS_NODE npm run dev:instance -- --build --fresh`, in the background):

```
npm run cdp:mobile -- launch --fresh                     # iphone; --device ipad|iphone-landscape|ipad-landscape|android, --scheme light
npm run cdp:mobile -- pair --label "Test phone"          # a link, the phone opens it, the codes are compared, Allow in the window
npm run cdp:mobile -- snapshot
```

`pair` creates a single-use link over the host's loopback listener with the host token, opens it in the phone, waits until the phone shows its six digits and the host lists the request, fails unless both match, then clicks **Allow** in the instance's own dialog through `npm run cdp`. It ends when the phone runs the compact workbench and prints `client`/`profile` (`compact`). `--access read-only` pairs a read-only device; `--allow owner` allows over the socket instead of the dialog; `--allow none` leaves the request waiting (to test Deny or expiry by hand). `link` only prints the link, for the simulator below.

The test prompt, from the phone. With no thread open the phone starts on its thread list; the floating button starts a draft first. The model picker is a bottom sheet there; pick by aria-label and check the chip before sending:

```
npm run cdp:mobile -- tap "document.querySelector('.touch-browser.home .touch-fab')"   # only on the start page
npm run cdp:mobile -- tap "all('button').find(b => /^Select (runtime and )?model/.test(b.getAttribute('aria-label') ?? ''))"
npm run cdp:mobile -- tap "all('[role=option]').find(o => /^GPT-5\.6 Luna, Pi\b/.test(o.getAttribute('aria-label') ?? ''))"
npm run cdp:mobile -- eval "all('button').map(b => b.getAttribute('aria-label') ?? '').find(t => /^Select (runtime and )?model/.test(t))"
#   must print "Select model: GPT-5.6 Luna" (a draft that offers runtimes says "Select runtime and model: GPT-5.6 Luna")
npm run cdp:mobile -- type "document.querySelector('textarea')" "Reply with one word: ok"
npm run cdp:mobile -- tap "document.querySelector('.send-button[aria-label=\"Send\"]')"
npm run cdp:mobile -- wait-for "document.querySelector('.message.assistant') && !document.querySelector('.send-button.stop')" 120000
```

On touch, Return in the composer adds a line; the send button sends. Prove the model in `.tau-dev/pi-sessions/` as for the desktop.

Gestures and the rest of the phone:

- `tap`, `longpress <expr> [ms]`, `swipe <expr> <dx> [dy]` send touch events at the element's center; a leftward swipe starts near the row's right edge, the way a thumb opens Thread Rail's tray.
- `keyboard <px>` stands in for the on-screen keyboard: the visual viewport shrinks by that much and `body[data-keyboard]` must appear; `keyboard off` closes it. `insert <text>` types the way a software keyboard does (`Input.insertText`), which is what the terminal must accept.
- `press` takes the same keys and chords as `npm run cdp -- press`.
- `device <name> [--scheme]` switches the device; reopen the page afterwards, since the web client picks its profile at load.
- `window <width> <height>` makes the app's window smaller inside the device's screen, as Split View, Slide Over or a web view that reports less height does; `window full` gives the whole screen back. No reload: this is how a tablet's layout decision is checked (`ipad-landscape`, then `window 700 820` stays the tablet's layout, `window 375 820` is a phone's, `window 1180 380` stays a tablet).
- The emulation holds only while a CDP session stays attached, so `launch` starts a small holder process beside Chromium; `stop` ends both.

Wakes and reconnects (F02):

```
npm run cdp:mobile -- freeze-host 15000 &      # SIGSTOP the instance's own host, SIGCONT after 15 s
npm run cdp:mobile -- wake sleep 1500          # the page frozen and resumed: a phone out of the pocket
npm run cdp:mobile -- wait-for "document.querySelector('.host-connection-status')?.textContent" 20000
npm run cdp:mobile -- wait-for "!document.querySelector('.host-connection-status')" 30000
```

The band "Reconnecting to the host…" must appear while the host is frozen (seen 1 to 11 s after the wake) and go within seconds once it thaws. `wake offline` / `wake online` emulate the network going away (Chromium keeps a loopback socket open while "offline", so combine it with `freeze-host` to see the Offline band), `wake foreground` fires `visibilitychange`. `freeze-host` signals only the pid in the instance's `host.json` (or the test host's), and only if its command line runs from this worktree.

The phone's panels open as sheets from the title bar's **More** menu (a single panel keeps its own icon): `tap` **More**, then **Terminal** (`[role=menuitemcheckbox]`), **New terminal**, then `keyboard 320` to see the key bar (esc, ctrl, alt, tab, arrows, ^C) on the keyboard; **More** → **Review** opens the review sheet.

### The proxy listener behind a fake Tailscale Serve

Never turn on the instance's **Tailscale** switch: it binds the machine's real tailnet addresses. The instance holds a proxy listener without it once the Tailscale kit sets up HTTPS against the fake CLI ("Tailscale HTTPS" below). Without the kit, or to test the listener alone, use a headless host with the kit's fake CLI (`kits/tailscale/fixtures/fake-tailscale.mjs`) as Serve in front of it:

```
node scripts/tau-test-host.mjs start --proxy --fresh       # prints url, proxyUrl, tokenFile; state in .tau-dev/test-host
FAKE_TAILSCALE_STATE=$PWD/.tau-dev/fake-tailscale node kits/tailscale/fixtures/fake-tailscale.mjs \
  serve --bg --https=443 <proxyUrl>                        # plain HTTP on 127.0.0.1:18443, Serve's headers
npm run cdp:mobile -- launch --fresh --resolve tau-test-box.tail0000.ts.net
npm run cdp:mobile -- pair --test-host --label "Via Serve" --via http://tau-test-box.tail0000.ts.net:18443
npm run cdp:mobile -- host connections-list --test-host    # the device's lastAddress is the fake peer, 100.101.102.103
```

`--resolve` makes the phone reach the fake MagicDNS name on 127.0.0.1, so the page's origin and `Host` are the tailnet name, as through a real Serve. `--via` sends the pairing link through that origin with the same fragment. A test host has no window, so `pair` allows over the owner socket. `npm run cdp:mobile -- host <method> [json params] --test-host` makes any owner call on it. Afterwards: `… fake-tailscale.mjs serve reset` (stops the stand-in) and `node scripts/tau-test-host.mjs stop`. `start --tls` gives the test host a self-signed certificate for the app's pinning and for a `dns-sd -P … _tau-test._tcp … 127.0.0.1 v=1 id=<host id> fp=<hex>` Bonjour record (`mobile/README.md`).

### Push notifications

Push Kit sends to Apple and Google itself; a test never does, and never reads the user's APNs key or Firebase project. The stand-ins run on loopback:

```
npm run build && node scripts/push-fakes.mjs                       # in the background: fake APNs (cleartext HTTP/2), fake OAuth + FCM
TAU_PUSH_APNS_ORIGIN=<printed> TAU_PUSH_FCM_ORIGIN=<printed> npm run dev:instance -- --fresh   # or `tau-test-host.mjs start --kits` with the same two variables
```

`push-fakes.mjs` writes a throwaway `.p8` key (Key ID `FAKEKEY123`, Team ID `FAKETEAM12`) and a service account whose `token_uri` is the fake into `.tau-dev/push-fakes/`, and appends every push it receives to `.tau-dev/push-fakes/pushes.jsonl`. Enter the two files in Settings → Push (paste the text; `cdp type` fills the textareas, the Key ID and Team ID inputs need the `HTMLInputElement` value setter and an `input` event). Then a paired device registers its token: the simulator's app does so after its first hello, once iOS's "allow notifications" dialog was answered; without the simulator, any paired socket client can call `host-extension ["tau.push", "register", { platform: "ios", token: <64 hex>, host: <host id>, topic: "de.tbuck.tau" }]`. The device's row in Settings → Push has a test push; a real one follows a turn that ends while no client is focused and used in the last three minutes (leave the window alone for that long). The recorded body is an APNs payload: add `"Simulator Target Bundle": "de.tbuck.tau"` and hand it to `xcrun simctl push <udid> de.tbuck.tau payload.json`; that works only after the app's notification permission was granted by a tap on the dialog, which an agent cannot give (no system events, and `simctl privacy` has no notifications service). `xcrun simctl openurl <udid> "<the payload's url>"` checks the link a tap would follow. `npm run smoke:remote-host` runs the same fakes against a headless host with signed-token checks.

### The native app in the iOS Simulator

Check `uptime` first: boot a simulator only while the one-minute load is below 40, one at a time, never while an Android build or emulator runs.

```
(cd mobile && npm ci && node scripts/native-build.mjs ios --dev)   # a development build with the automation bridge
node mobile/scripts/sim-device.mjs up                              # new simulator, boot, install, launch, bridge; refuses above load 40
#   up --ipad: an 11-inch iPad instead of an iPhone
node mobile/scripts/sim.mjs wait-for "text().length > 0" 60000     # the app's web view is connected
npm run cdp:mobile -- link --label "Simulator"                     # prints the loopback pairing link
node mobile/scripts/sim.mjs eval "tap(document.querySelector('[aria-label=\"Add host\"]'))"
node mobile/scripts/sim.mjs eval "type(document.querySelector('textarea'), '<link>')"
node mobile/scripts/sim.mjs eval "tap(byText('button', /^Connect$/))"
node mobile/scripts/sim.mjs wait-for "document.querySelector('[aria-label=\"Pairing code\"]')?.textContent" 30000
npm run cdp:mobile -- host connections-list                        # the request's verification must be the same digits
npm run cdp -- click "<the Allow button of the dialog showing those digits>"
node mobile/scripts/sim-device.mjs screenshot .tau-dev/sim.png     # this simulator only
node mobile/scripts/sim-device.mjs down                            # shut down and delete it, stop the bridge
```

The simulator shares the Mac's loopback, so the app reaches the instance on 127.0.0.1, where the app accepts plaintext only because it runs in a simulator. A fresh simulator's first boot keeps the machine busy for a minute or two; run `down` as soon as the check is done. `mobile/README.md` has the bridge's helpers (`tap`, `type`, `text`, …) and the Android emulator. Never install on a real device and never sign with the user's account.

## Another machine: named test hosts ("rex")

Work that moves to another machine (host to host, remote work) is tested against a second headless host on this Mac, never against the real rex or any other real machine. `--name` starts one of several, each under `.tau-dev/test-host-<name>/` with its own home, userData, host token, host id, Pi agent dir and session store, and the runtime homes (`CODEX_HOME`, OpenCode, Cursor, Grok) empty and signed out:

```
node scripts/tau-test-host.mjs start --name rex --kits --tls --fresh   # prints url, fingerprint, publicKey, tokenFile, userData, sessionsDir
node scripts/tau-test-host.mjs status --name rex
node scripts/tau-test-host.mjs list                                    # every test host of this worktree, with running true/false
npm run cdp:mobile -- host connections-list --test-host=rex            # an owner call on rex over its loopback host token
node scripts/tau-test-host.mjs window --name rex                       # rex's own Tau window: prints pid and CDP port
node scripts/tau-test-host.mjs stop --name rex                         # or stop --all; stops the window too
```

- A named host calls itself by its name (`TAU_MACHINE_NAME`), so pairing and Settings → Machines show "rex", not this Mac's name.
- Its Pi agent dir is prepared like an instance's (`scripts/pi-agent-shadow.mjs`): the login linked, settings copied with GPT-5.6 Luna as the default model. `--no-login` leaves Pi signed out. No other runtime is ever signed in on a test host; nothing is copied from the real `~/.codex`, `~/.claude` or `~/.pi`.
- It listens on 127.0.0.1 with a random port, or the one `--port <n>` names; `--kits` loads the kits (off by default), `--tls` gives it a self-signed certificate to pin. `--cpus <n>` makes it report that many cores (`TAU_TEST_CPU_COUNT`), so "rex with 2 cores" holds on this Mac, for example to see sub-agents queue behind a machine's budget. Its CPU reading then counts only its own process tree (terminals included) against those cores, so `yes > /dev/null` in one of its terminals loads "rex" and nothing else on this Mac does.
- A test host has no window, so it has no window halves: Preview has nowhere to draw ("rex has no display"). `window` starts one on this Mac that is the host's own (its token over loopback, its pinned key, `TAU_NO_FOCUS`, userData `window-userdata/` in the host's folder), so Preview pages and captures happen there; drive it with `npm run cdp -- <port> …`. Its pid and port are in `window.json` there.
- `stop` signals only the pid in that host's `state.json`, and only while it still runs this worktree's `headless.js`. To bring back a host another host paired with, start it again without `--fresh` and with its old `--port`: its key, the pairing and its threads are still there.

### A fixture project with a local "origin"

`node scripts/remote-work-fixture.mjs [--name demo] [--fresh] [--clean]` makes `.tau-dev/remote-work/<name>/origin.git` (bare) and `.tau-dev/remote-work/<name>/work`, a checkout of it whose `origin` is a `file://` URL. It has two commits with fixed dates (the same ids everywhere), a binary file, ignored files as a user has them (`.env`, `.scratch/issues/`, `node_modules/`), an uncommitted change and an untracked file. The bare repo is made with `clone --bare`, so nothing is ever pushed, and Git runs without the caller's hooks, templates or signing. Point an instance at it with `npm run dev:instance -- --workspace .tau-dev/remote-work/demo/work`.

Tau clones only HTTPS and SSH URLs. Instances and test hosts set `TAU_TEST_CLONE_ROOT` to `.tau-dev/remote-work`; with it, `assertAllowedCloneSource` also accepts a `file://` URL whose path (symlinks followed) lies inside that folder, and nothing else.

### A fake model instead of a login

`scripts/fake-model-server.mjs` is an OpenAI-compatible model on 127.0.0.1 (`startFakeModelServer()`), and `prepareFakePiAgentDir(agentDir, baseUrl)` gives a Pi agent dir only that provider (`tau-fake/fake-1`, priced so a thread costs more than zero). It answers from the last user message: `write <path> <word>` makes a `write` tool call and then says "done", `wait <ms>` pauses mid-answer (for aborts), `fail <status> <text>` answers with that HTTP status and `<text>` as the provider's error (a failed turn), anything else is "ok". A test host started from a script takes it through `startTestHost(flags, { prepare: (env) => prepareFakePiAgentDir(env.PI_CODING_AGENT_DIR, baseUrl) })` with `login: false`.

### The remote-work smoke

`npm run smoke:ssh-pairing` (after `npm run build`) checks `tau machines add --ssh` with two test hosts (`ssh-a` as "mini", `ssh-rex` as "rex") and the Servers kit's fake SSH server under `.tau-dev/ssh-pairing/`: a stub `tau` there runs this checkout's command line for rex's userData, and a stub `ssh` here adds the fake's `-F` ssh_config. A's host pairs its agents alone first, then a stand-in for A's window process (the app's `WindowEnvironments` behind core's window half, keys in a plain box instead of the keychain) pairs for itself and its agents. It checks rex's devices, the idempotent second run, `list`, `remove`, a login that would need a password (fails at once, no prompt), and that no pairing code reaches argv or a file. A real Tau window as A needs `--use-mock-keychain` on Electron's command line, so safeStorage never touches the macOS keychain.

`npm run smoke:remote-work` (after `npm run build`; CI runs it too) starts the fake model, the fixture, and two test hosts, `smoke-a` (calls itself "mini", workspace = the fixture) and `smoke-rex` ("rex", TLS, `--cpus 2`), both with kits. It runs a fake turn on rex that writes a file, pairs A with rex over pinned TLS for itself and its agents (one request, allowed by rex's owner over its loopback host token, two devices), and runs a kit command on rex with A's device token. It then hands the agents' token to A's host (`machines-add`), calls Machines Kit's `probe` there, which reaches rex through `services.machines` as the agents' device, asks rex's `host-resources` and `readiness` through Machines Kit (2 cores, no turn running, Pi ready with the fake model, Git with `merge-tree`) and this computer's by its own host id, and sends a 20 MB file. Remote Work Kit then offers the fixture's ignored files (`.env`, `.scratch/`; never `node_modules/`), remembers the ticks, and sends the fixture's state to rex: rex clones the `file://` origin into its mirror under its own `~/.tau/remote-work`, the bundle carries only the state commit, and the worktree there holds the uncommitted change, the untracked file and the ticked ignored files. A change made in that worktree comes back as `tau/rex/smoke` and merges (A's `git status` clean afterwards); a second run where both sides changed the same line comes back as `tau/rex/smoke-2`, is refused as a conflict and leaves A's HEAD and status as they were. A thread started from A on rex (`thread-start`, fake model) is followed from sending to idle with a cost above zero and writes a file in its worktree there; a `wait 30000` turn is stopped from A; rex is stopped by its pid (A reads `offline`, `thread-wait` answers `offline`) and started again on the same port, after which the status is right again and a new turn answers; `thread-settle apply` merges the thread's work as `tau/rex/smoke-thread` and removes the worktree there; and a Pi session from A continues on rex through `thread-start({ session })`. Handoff Kit's `continue-on` then takes a thread of A to rex with its history (native), `bring-back-remote` returns its branch and a merge-back block written on rex, and `settle-remote apply` merges it and removes the worktree there. Machines Kit's `choose-machine` picks an idle rex over A (weights 50 and 5), then, with a waiting fake turn per core on rex, leaves rex out ("2 turns running on 2 cores"); the turns are stopped afterwards. Last, it revokes the agents' device on rex and checks that A's host reports it refused while A's own device stays in (ADR 0027). Steps whose seams are not there yet print `○ … pending (Hxx)`; each ticket turns its own into real steps in `STEPS`. At the end it stops both hosts by the pids in their state files and fails if a pid is alive or a port still accepts connections. A developer's own `rex` test host is never touched.

## Tearing down

Run `npm run cdp -- stop` (SIGTERM, then SIGKILL after ~2s if the process is still alive — observed necessary in practice, since Electron's main process has no SIGTERM handler of its own and a bare `kill <pid>` can leave it running indefinitely). Never `pkill -f Electron` (or any pattern match on the binary name) — that also kills the user's own running Tau. Never `git stash` in the scratch workspace or the worktree.

## Advanced: the Electron client against a headless host

To test the socket transport instead of the embedded host, start a headless host with `node dist-electron/main/headless.js` (`TAU_WORKSPACE`, `TAU_USER_DATA`, `TAU_HOST_LISTEN=127.0.0.1:0`; see `scripts/remote-host-smoke.mjs` for the full pattern, including reading the printed listen URL and the `~/.tau/host-token` file) and start an ordinary window against it with `TAU_HOST_URL=ws://127.0.0.1:<port>` and `TAU_NO_FOCUS=1`. `dev-instance.mjs` only starts the embedded-host path; wire this one by hand. For TLS, add `TAU_HOST_TLS=1` to the host and `TAU_HOST_PUBLIC_KEY=<the printed public key>` to the window (without a pin the window asks on a native sheet that CDP cannot answer, so an agent always pins, or seeds `<userData>/known-hosts.json`); a wrong key must show `.host-connection-status.refused` in the window, never a native alert. `TAU_HOST_TOKEN_FILE` under `.tau-dev/` keeps the token out of `~/.tau`.

Network access (Settings → Connections) is tested on loopback wherever possible: `npm run smoke:remote-host` starts a host with `TAU_HOST_PROXY_LISTEN=127.0.0.1:0` and checks what a peer behind a proxy gets, and `src/main/host-network.test.ts` binds the real plan on 127.0.0.1 with injected interfaces. A real check of **Local network** in an instance binds every interface: keep it short, keep TLS on (it always is), pick a free port rather than 7788, turn the switch off again as soon as the check is done, and write down in the ticket how long it listened and on which interfaces. Never turn on **Tailscale** against the machine's tailnet to test `tailscale serve`, and never run `tailscale serve`, `funnel` or `cert`; a fake `tailscale` on `PATH` with an empty `ZDOTDIR` stands in. `<userData>/network.json` of the instance (under `.tau-dev/userdata/`) holds the switches; delete it, or start with `--fresh`, to begin with everything off.

Bonjour: `dev:instance` sets `TAU_BONJOUR_SERVICE_TYPE=_tau-test._tcp`, so an instance with Local network on announces and looks for the test type only, never `_tau._tcp`. Keep an announcement as short as the Local network check around it, and check afterwards that nothing announces any more: `dns-sd -B _tau-test._tcp local.` for two seconds on macOS lists nothing. Tests never run the real tools; `src/main/host-discovery.test.ts` injects the platform and a fake process (Linux and Windows are covered that way).

**Tailscale HTTPS** (the Tailscale kit's section on Connections) is tested against `kits/tailscale/fixtures/fake-tailscale.mjs`, never the real CLI. Start the instance with `TAU_TAILSCALE_COMMAND=<worktree>/kits/tailscale/fixtures/fake-tailscale.mjs`, `FAKE_TAILSCALE_STATE=<worktree>/.tau-dev/fake-tailscale` and an empty `ZDOTDIR`: the kit then runs that file and nothing else, with no fallback to `PATH` or the app bundle. A service host installed from the instance keeps `TAU_TAILSCALE_COMMAND`; the fake then finds its state beside the instance's userData (`.tau-dev/fake-tailscale`). Never install the service from an instance without `TAU_TAILSCALE_COMMAND`: its host would ask the real CLI. The fake answers `status --json` and `serve status --json`, keeps Serve's config in `state.json` there (edit it to sign out, turn HTTPS certificates off, or put another program on port 443), logs every call to `calls.log`, and refuses `funnel`, `cert` and `set`. `serve --bg` starts a plain-HTTP stand-in for Serve on 127.0.0.1 (the port, or 18000 + a port below 1024: 443 → 18443) that forwards to the proxy listener with the headers Serve sets; send it a request with `Host: <name>` to see what the host makes of a tailnet peer. Stop it with `fake-tailscale.mjs serve reset`, or by the PID in `state.json`. The only real command a check may run is `tailscale status --json`, which changes nothing.

