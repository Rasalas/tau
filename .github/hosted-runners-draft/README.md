# Workflows for GitHub-hosted runners (draft)

GitHub only runs workflows under `.github/workflows/`, so nothing in this
directory runs. These files replace the self-hosted runners (`tau-linux`,
`tau-macos`) with GitHub-hosted ones for when the repository is public. Standard
hosted runners are free and unlimited there, and self-hosted runners should not
be attached to a public repository: a pull request can edit the workflow file
and choose any runner label.

| Workflow | Now | Draft |
|---|---|---|
| `ci.yml` | `tau-linux`, forks on `ubuntu-latest` | `ubuntu-24.04`; lint, typecheck and build in one job, tests in three shards |
| `performance.yml` | `tau-linux`, forks on `ubuntu-latest` | `ubuntu-24.04`, the same checks split into two blocking steps |
| `release.yml` | gate, verify, sign, release, nightly on `tau-linux`; macOS on `tau-macos` | `ubuntu-24.04`; macOS on `macos-26` with Xcode 26.6 selected; `windows-2025` |
| `cleanup-artifacts.yml` | `tau-linux` | `ubuntu-24.04`, upstream only |
| `windows.yml` | `windows-latest` | `windows-2025` |

What changed in every file:

- Actions pinned to the commit of the major version in use today (`v4`, `v7`,
  `v2`), so the behavior stays the same. Upgrading to the current majors
  (checkout v7, setup-node v7, upload-artifact v7, download-artifact v8,
  github-script v9, action-gh-release v3) is a separate change.
- `permissions: contents: read` at the top. Only `release` and `nightly` get
  `contents: write`, and only `cleanup-artifacts` gets `actions: write`.
- `persist-credentials: false` on checkout. The release gate keeps the default
  because it runs `git ls-remote origin`.
- Labels are pinned: `ubuntu-latest` moves to 26.04 in November 2026
  (actions/runner-images#14748), and `.deb` checks and the AppArmor `sysctl`
  depend on the release.
- `release.yml`: jobs that read release secrets (`verify`, `build`, `sign`)
  run in the environment `release` when the run publishes (a `v*` tag, a
  nightly, or `publish=true`). Otherwise they use `release-dry-run`, which
  holds no secrets.

## Activate

1. Remove the self-hosted runners from the repository (Settings → Actions →
   Runners: `rex-runner-tau`, `macos-runner-tau`, and the offline
   `gh-runner-tau`), then make the repository public. The runners must be gone
   before the repository is public.
2. Move the files: `git mv -f .github/hosted-runners-draft/*.yml .github/workflows/`,
   then delete this directory.
3. Fix the docs that name the old runners: `docs/RELEASE.md` (runner list,
   nightly cost, `install:mac` needing `gh` auth for a private repository),
   `docs/PERFORMANCE.md` (CI split), and the comment in `vitest.config.ts`.
4. Push to a branch and dispatch a dry run:
   `gh workflow run release.yml --ref <branch> -f publish=false`.

## Check first

- **Rebase on the release changes of `fix/K108-tau-releases`.** That branch
  reworks `release.yml` (publishing to `Rasalas/tau-releases` with an app
  token). Carry the runner labels, pins, `environment:` lines and permissions
  over to that version. Its `TAU_RELEASES_APP_*` secrets go into the `release`
  environment too, and `actions/create-github-app-token` is already pinned.
- **Xcode.** The dry run's "Select Xcode" step prints `xcodebuild -version`
  and `actool --version`. The Package log must show actool compiling
  `Icon.icon` into `Assets.car` and `Icon.icns`. If the image drops Xcode 26.6,
  choose another `/Applications/Xcode_26.x.app` from the image's README.
- **Signing.** No `CSC_LINK` secret exists today, so every macOS build so far
  was unsigned (`skipped macOS application code signing` in the log). On a
  hosted runner `CSC_LINK` has to be the base64 of the `.p12`, not a path.
  Notarizing two apps adds several minutes, and Apple's queue decides how many.
- **Test shards.** `npx vitest run --shard=n/3` should run every file once:
  the three shard logs together must list the same number of test files as a
  full local run (894 on 2026-09-29).
- **Performance.** The renderer and start budgets have never measured anything
  on `tau-linux`. They abort on the `chrome-sandbox` check, because the
  `sysctl` step only ran on hosted runners. Hosted runs will report real
  numbers for the first time. They stay advisory.
- **Public logs and artifacts.** Logs, `performance-reports` and the
  `tau-*-diagnostics` artifacts (`builder-debug.yml`, npm logs) become readable
  by anyone. Check one diagnostics artifact for secrets or personal paths
  before going public.

## Repository settings at go-public time

- Settings → Actions → General → *Approval for running fork pull request
  workflows from contributors*: **Require approval for all external
  contributors**. The default only covers first-time contributors.
- Same page: workflow permissions stay **Read repository contents**, and
  *Allow GitHub Actions to create and approve pull requests* stays off.
- Same page: turn on **Require actions to be pinned to a full-length commit
  SHA** once these files are active. Optionally restrict allowed actions to
  GitHub's own plus `softprops/action-gh-release`.
- Settings → Environments → **`release`**: deployment branches and tags
  limited to tags `v*` and the branch `main`. Move `TAU_RELEASE_SIGNING_KEY`,
  `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID` (and `TAU_RELEASES_APP_*`) from repository secrets into it.
  Required reviewers would also stop the scheduled nightly until someone
  approves it, so leave them off unless that is wanted. `release-dry-run`
  needs no configuration.
- Do not add a `pull_request_target` or `workflow_run` workflow that checks
  out pull request code.
- Keep `NIGHTLY`, immutable releases and tag rules as `docs/RELEASE.md` says.

## Performance on shared hardware

A shared runner makes timings noisy. Sizes and counts stay the same on any
machine. Today's checks, by kind:

| Check | Deterministic (block) | Timing (noisy) |
|---|---|---|
| `build:budget` | JS/CSS bytes and gzip, kit bytes, web bytes, overlay blur flag | build time (30 s guard, 20.5 s measured; web 20 s, 4.3 s) |
| `benchmark:git:check` | subprocess counts, parallelism, bytes read, cancel state | slow-command cancel (21 of 150 ms), many-project p95 (61 of 500 ms) |
| `benchmark:host:*` | no branch or serial bind on the critical path, entry and page counts, idle heap | bootstrap cold (550 of 1,000 / 2,500 ms), switches, metadata, large thread (721 of 2,500 ms) |
| `benchmark:renderer` | required scenarios, DOM nodes | frame, mount and commit p95, long tasks |
| `start:report` | zero external requests | first paint, overlay composition |

The draft keeps today's split: build, Git and host checks block, renderer and
start stay advisory. Most blocking timings had 3x headroom or more on
`tau-linux`. The tight ones are build time (20.5 of 30 s), safe-mode cold
bootstrap (549 of 1,000 ms) and full-mode cold bootstrap (543 of 2,500 ms
there, but 2.0 s on a two-core hosted runner in early September). If these
flake on hosted runners, do step 1 before activating. Next steps, in order:

1. Give the `evaluate*Budgets` functions a mode that turns timing violations
   into `::warning::` lines and keeps deterministic ones fatal, then run
   renderer and start in that mode as blocking steps. Their DOM-node,
   scenario and network checks are enforced nowhere today.
2. Timing regressions: `npm run performance:ci` on a quiet development machine
   stays the gate. For CI, a base-versus-head run in one job (both builds,
   interleaved, fail only on a relative slowdown) is the fair comparison on
   shared hardware.
3. If stable CI numbers are needed, run a self-hosted runner that belongs to a
   separate private repository and benchmarks `main` on a schedule. It must
   never be registered to the public one.
