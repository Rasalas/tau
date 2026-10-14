# Quiet-machine app comparison

Review ticket 61 preparation, 2026-10-14. No app was launched and no performance
run was taken. A current Tau vs. T3 result is still pending. This file records
the prepared reference build and the commands to produce the evidence.

## Prepared reference

The local reference was cloned into `/tmp/reference-harness` from
`/Volumes/WD-Black-SN850X/tbuck/repos/_external/t3code`, with
`git clone --local --no-hardlinks`. The sandbox rejected hardlinks; copying the
objects kept the original checkout read-only. Reference commit:
`7b6d90757415f7897bac1a39e42cfb1331c97ee5`, app version `0.0.45`, Electron
`44.4.5`. The clone's Git status is clean after the build.

Desktop, server and web production bundles were built with two task slots and
two bundler threads. The Electron runtime was downloaded and its paths checked
without starting it. `apps/desktop/dist-electron/main.cjs`, `preload.cjs`,
`apps/server/dist/bin.mjs` and `apps/web/dist/index.html` exist. Main and server
syntax checks passed. Build and runtime-download logs are in
`/tmp/reference-tools/build.log` and `electron-runtime.log`.

To recreate the preparation after `/tmp` is cleared, from an existing local
Node and pnpm installation:

```sh
git clone --local --no-hardlinks \
  /Volumes/WD-Black-SN850X/tbuck/repos/_external/t3code \
  /tmp/reference-harness
git -C /tmp/reference-harness checkout --detach \
  7b6d90757415f7897bac1a39e42cfb1331c97ee5
mkdir -p /tmp/reference-tools/node24
curl -fsSL https://nodejs.org/dist/v24.13.1/node-v24.13.1-darwin-arm64.tar.gz \
  -o /tmp/reference-tools/node24.tar.gz
tar -xzf /tmp/reference-tools/node24.tar.gz \
  -C /tmp/reference-tools/node24 --strip-components=1

cd /tmp/reference-harness
export PATH="/tmp/reference-tools/node24/bin:/tmp/reference-harness/node_modules/.bin:$PATH"
export XDG_CACHE_HOME=/tmp/reference-tools/cache
export XDG_DATA_HOME=/tmp/reference-tools/data
export XDG_CONFIG_HOME=/tmp/reference-tools/config
export npm_config_cache=/tmp/reference-tools/npm
export PNPM_HOME=/tmp/reference-tools/bin
export RAYON_NUM_THREADS=2
export CARGO_BUILD_JOBS=2
pnpm --config.manage-package-manager-versions=false \
  --filter '@t3tools/desktop...' --filter 't3...' --filter '@t3tools/scripts...' \
  install --frozen-lockfile --ignore-scripts \
  --store-dir /tmp/reference-tools/store --child-concurrency 2 --network-concurrency 2
node_modules/.bin/vp run --filter @t3tools/desktop --filter t3 \
  --concurrency-limit 2 build
node apps/desktop/scripts/ensure-electron-runtime.mjs
git status --short
```

The filtered install includes the separate build-scripts workspace. Lifecycle
scripts are skipped; the runtime repair script supplies Electron explicitly.
No launcher bundle, global installation or installed app is involved.

## Seed and measure

Run these outside the sandbox when the one-minute load is below about 10 and
the machine has stopped building or swapping. Keep both source checkouts at
fixed commits and rebuild Tau after checking out the commit to measure.
`COMPARE_TAU_ROOT` is a profile directory, not a source checkout.

```sh
cd /Volumes/WD-Black-SN850X/tbuck/repos/_self/tau-worktrees/rv-61-vergleich-mit-t3-messbar-machen
export COMPARE_REFERENCE_SOURCE=/tmp/reference-harness
export COMPARE_REFERENCE_ROOT=/tmp/rv61-reference-profile
export COMPARE_TAU_ROOT=/tmp/rv61-tau-profile
unset TAU_FOREGROUND
npm run build

# Import both fixtures. --seed also performs one run; exclude it from evidence.
npm run benchmark:compare -- --apps tau,reference --seed \
  --runs 1 --warmup 0 --idle-ms 10000 --out reports/compare-seed.json

# Nine measured runs per app after one discarded warm-up per app.
# Each run includes a second launch for cold and warm switches.
npm run benchmark:compare -- --apps tau,reference \
  --runs 9 --warmup 1 --idle-ms 10000 --out reports/compare-full.json

# Optional additional switch samples. Match the builds, fixture and idle window.
npm run benchmark:compare -- --apps tau,reference --thread-switch \
  --runs 5 --warmup 1 --idle-ms 10000 --out reports/compare-switch.json

# A full report suffices. Add the optional file only if that run was performed.
npm run benchmark:compare:summary -- reports/compare-full.json \
  reports/compare-switch.json --out docs/performance/compare-2026-10-14
```

Use the actual measurement date in the output name. If the optional switch run
was skipped, pass only `reports/compare-full.json`. Do not include the seed
report or glob every historical comparison file into one summary. Repeat full
runs with distinct filenames to pool more samples at the same commits. Each
launch restores its seeded profile; apps alternate order between runs.

Both apps get isolated homes, empty shell rc directories, mock keychain access
and a deterministic local replay. The harness launches Tau through its
production package entry and T3 through its production `main.cjs`, with the
server and renderer, as unpackaged apps. It does not use T3's installed launcher
or `boot.cjs` wrapper. The reported start includes the rail and composer from
the seeded profile. OS disk caches are warm after the discarded launch.
`start:report` measures the renderer bundle alone and is not part of this pair.

The idle sample follows 10 seconds of settling and measures another 10 seconds
of CPU time. Its percentage uses one core as 100%. Read the role breakdown and
the complete-window counts; incomplete samples are excluded. CPU time is
quantized by `ps`, and short-lived processes between snapshots can be missed.
Streaming ends at the last visible sentinel and includes transport, frame
intervals and long tasks. It does not time a live provider or runtime completion.

## Keep the evidence

Review the generated `.md` and `.json` together. They contain both app commits,
machine class, dates, load ranges, fixture, warm-ups, medians, spans and sample
counts. Missing measurements are explicit; the tool rejects incompatible
sources. Raw reports remain local under the gitignored `reports/` directory.
Commit only the condensed pair after confirming the machine was quiet and
both builds match the recorded commits. No new timing or CPU CI gate is added.

This fixture has seven imported text threads, with at most 100 turns, and no
saved remote machines or custom shell rc file. The 1,000-session host benchmark
and the renderer scenarios from review tickets 57–59 are separate benchmarks.
This comparison cannot establish startup with an unreachable saved machine or
the performance of every large-thread scenario.

## Preparation checks

The new CPU tests cover cumulative time parsing, the app process tree, role
totals, replay-process exclusion, elapsed-window normalization and invalid
windows. The summary tests cover raw-run pooling, raw warm switches, missing
CPU and timing values, incompatible provenance and writing the Markdown/JSON
pair from the CLI. They failed before the implementation was added.

The standard focused test command passed 76 assertions but exited with an
error because the existing global teardown invokes `ps`, which the sandbox
forbids. A temporary config at `/tmp/rv61-checks/vitest.config.mts` imports the
repository config, preserves setup and home isolation, supplies the test run
id, and omits only the global process-scan teardown. With that config, the final
combined run passed 227 tests across eight files through the shared check slot:

```sh
npm test -- scripts/compare/processes.test.mjs scripts/compare/summary.test.mjs \
  scripts/compare/compare.test.mjs src/shared/core-boundary.test.ts \
  src/shared/kits-boundary.test.ts src/workbench/workbench-boundary.test.ts \
  kits/kit-lifecycle.test.tsx \
  scripts/performance-report.test.mjs \
  --maxWorkers=2 --config /tmp/rv61-checks/vitest.config.mts
node scripts/check.mjs typecheck -p tooling/tsconfig.electron.json --noEmit
npm run lint
```

The scoped typecheck passed. Lint exited successfully with existing repository
warnings. No component test
was added or changed. No extension API, core seam, budget or CI file changed.
Rerun the focused tests with the normal config outside the sandbox to include
the process-leak teardown.
