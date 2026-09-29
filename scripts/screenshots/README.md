# Product screenshots

`npm run screenshots -- --out <dir>` makes the pictures the website shows (tbuck.de, the Tau project page) from a real Tau on sample data. Run it again after a visual change and the files in `<dir>` are replaced.

```
npm run screenshots -- --out ../tbuck-www/static/res/project/tau
npm run screenshots -- --out /tmp/shots --only workbench,phone --theme dark
```

| Flag | |
| --- | --- |
| `--out <dir>` | Where the PNGs go, one per shot: `<name>.png`. Required. |
| `--only <a,b>` | Only these shots. |
| `--theme light\|dark` | The app's appearance, light by default. |
| `--build` | Build first even when `dist-electron` exists; without it the runner builds only a checkout that was never built. |
| `--keep` | Leave everything running after the shots, for looking at the app over CDP; `kill <runner pid>` stops it all. |

The shots (`shots.mjs`):

| Name | What | Size |
| --- | --- | --- |
| `reviews` | The Reviews page: ready, requested, conflicting and merged branches | 2560 × 1600 |
| `workbench` | An Agent SDK runtime thread with the stage beside it: Files with the thread's diff, a terminal tab | 2560 × 1600 |
| `juicebars` | The sidebar's foot with the plan-limit bars and their card (Codex and the Agent SDK runtime) | the element |
| `phone` | The paired phone's thread list (iPhone, headless Chromium) | 1179 × 2556 |

The desktop window is 1280 × 800 at 2×. The runner exits non-zero when a shot fails and still stops everything.

## What runs

- **One run folder**, `/tmp/tau-screenshots` (`TAU_SCREENSHOTS_ROOT` moves it). It holds the instance's HOME, userData, Pi sessions and agent dir, the runtimes' homes, the host token and the logs (`logs/app.log`, `logs/phone.log`). The runner empties it at the start and refuses a folder it did not make or one another run still holds.
- **The fixture** (`fixture.mjs`): three Git projects under `home/code` (shop-api, desk-app, garden-planner) with worktree branches in every review state, threads on the Agent SDK runtime, Codex and Pi, a note and a merge in Review Kit's book, and the plan limits the juicebars show. Anthropic models only ever run on the Agent SDK runtime here, never through Pi. No real name, path or host appears; the machine is called "MacBook Pro".
- **No real account or model.** Pi's providers point at the repo's fake model server on loopback; the Agent SDK runtime drives `kits/claude-code/fixtures/stub-cli.mjs` (models and the usage read come from the fixture through `STUB_CLI_MODELS` and `STUB_CLI_USAGE`); Codex is `kits/codex/fixtures/stub-app-server.mjs`. No prompt is sent.
- **An isolated instance**: Electron from this checkout with an environment built from nothing (`instanceEnv` in `run.mjs`), every data path under the run folder, checked by `scripts/compare/isolation.mjs`. It never takes focus.
- **The phone**: Playwright's Chromium as an iPhone, paired through the host's own link and approved over the owner socket.
- **Stopping**: the phone, the host (from `userdata/host.json`, only this checkout's), the app and whatever the app started, each by PID.

`screenshots.test.mjs` checks the shot list, the flags and the fixture; the capture itself needs a display and runs by hand.
