# Product screenshots

`npm run screenshots -- --out <dir>` makes the pictures the websites show (the landing page in `site/`, the Tau project page on tbuck.de) from a real Tau on sample data. Run it again after a visual change and the files in `<dir>` are replaced.

```
npm run screenshots:site     # site/assets: every shot, light and dark, as WebP at two sizes
npm run screenshots -- --out ../tbuck-www/static/res/project/tau --only reviews,workbench,juicebars,phone
npm run screenshots -- --out /tmp/shots --only workbench,phone --theme dark
npm run screenshots -- --out /tmp/play --only phone,phone-thread,phone-reviews,phone-diff,phone-terminal,phone-usage --phone android-store
```

| Flag | |
| --- | --- |
| `--out <dir>` | Where the pictures go, one per shot: `<name>.png`. Required. |
| `--only <a,b>` | Only these shots. |
| `--theme light\|dark\|both` | The app's appearance, light by default. `both` takes every shot twice; the dark ones are `<name>-dark.*`. |
| `--phone <device>` | The phone the `phone*` shots are taken on, from `DEVICES` in `scripts/tau-mobile-cdp.mjs`: `iphone` (default, 1179 × 2556), `android` or `android-store` (1080 × 1920, the 9:16 Google Play wants; it refuses a phone screenshot more than twice as long as wide). |
| `--format png\|webp` | PNG by default. `webp` writes `<name>.webp` at full size and `<name>-sm.webp` at half, for a page's `srcset`. |
| `--build` | Build first even when `dist-electron` exists; without it the runner builds only a checkout that was never built. |
| `--keep` | Leave everything running after the shots, for looking at the app over CDP; `kill <runner pid>` stops it all. |

The shots (`shots.mjs`):

| Name | What | Size |
| --- | --- | --- |
| `reviews` | The Reviews page: ready, requested, conflicting and merged branches | 2560 × 1600 |
| `workbench` | An Agent SDK runtime thread with the stage beside it: Files with the thread's diff, a terminal tab | 2560 × 1600 |
| `juicebars` | The sidebar's foot with the plan-limit bars and their card (Codex and the Agent SDK runtime) | the element |
| `threads` | The thread list, from the sidebar's top to its foot | the sidebar |
| `stage` | The stage with a terminal in the thread's worktree: `git log` and `git status` | the stage, 500 px high |
| `runtimes` | Settings → Runtimes: every runtime installed, with its version | 2560 × 1600 |
| `usage` | The Usage page over 30 days: spend and plan tokens, per day, by provider and by project, in Tau and outside it | the page's top, down to the tables |
| `kits` | Settings → Extensions: the kits Tau ships | 2560 × 1600 |
| `machines` | A second machine, "studio": its threads in the list and a new thread's Run on menu | 2560 × 1600 |
| `phone` | The paired phone's thread list (headless Chromium as the `--phone` device) | the phone's screen |
| `phone-thread` | A thread on the phone: the agent's reply and the composer | the phone's screen |
| `phone-reviews` | Reviews on the phone, by state | the phone's screen |
| `phone-diff` | A review on the phone with one file's diff open, and Merge | the phone's screen |
| `phone-terminal` | A terminal in the thread's worktree: `git log` and `git status` | the phone's screen |
| `phone-usage` | Usage on the phone: this month's spend and plan tokens, the last 12 days, the providers | the phone's screen |

The desktop window is 1280 × 800 at 2×. The runner exits non-zero when a shot fails and still stops everything.

## What runs

- **One run folder**, `/tmp/tau-screenshots` (`TAU_SCREENSHOTS_ROOT` moves it). It holds the instance's HOME, userData, Pi sessions and agent dir, the runtimes' homes, the host token and the logs (`logs/app.log`, `logs/phone.log`). The runner empties it at the start and refuses a folder it did not make or one another run still holds.
- **The fixture** (`fixture.mjs`): three Git projects under `home/code` (shop-api, desk-app, garden-planner) with worktree branches in every review state, threads on the Agent SDK runtime, Codex and Pi, a note and a merge in Review Kit's book, the plan limits the juicebars show, and six weeks of work outside Tau in the Codex and Agent SDK CLIs' own log formats (counts only) for Usage. OpenCode is the repo's fake server; Antigravity is a "managed" copy of the pinned release whose two files only exist, with a sign-in marker in Tau's own profile. Nothing starts either. Anthropic models only ever run on the Agent SDK runtime here, never through Pi. No real name, path or host appears; the machine is called "MacBook Pro".
- **No real account or model.** Pi's providers point at the repo's fake model server on loopback; the Agent SDK runtime drives `kits/claude-code/fixtures/stub-cli.mjs` (models and the usage read come from the fixture through `STUB_CLI_MODELS` and `STUB_CLI_USAGE`); Codex is `kits/codex/fixtures/stub-app-server.mjs`. No prompt is sent.
- **An isolated instance**: Electron from this checkout with an environment built from nothing (`instanceEnv` in `run.mjs`), every data path under the run folder, checked by `scripts/compare/isolation.mjs`. It never takes focus, and runs with `--lang=en-US`, so dates and numbers read the same on any machine.
- **The phone**: Playwright's Chromium as the `--phone` device (an iPhone by default), paired through the host's own link and approved over the owner socket.
- **A second machine** (`studio.mjs`), only for a run that takes `machines`: a headless host named "studio" on loopback with its own home, userData, token and two Pi threads under `<run folder>/studio`. The window pairs with it in Settings → Machines, and the runner approves the request with studio's own token after comparing the code. Every shot of such a run shows studio's threads in the list.
- **Stopping**: the phone, studio, the host (from `userdata/host.json`, only this checkout's), the app and whatever the app started, each by PID.

`screenshots.test.mjs` checks the shot list, the flags and the fixture; the capture itself needs a display and runs by hand.
