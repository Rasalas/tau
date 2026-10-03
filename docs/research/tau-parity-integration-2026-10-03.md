# Parity integration checkpoint

3 October 2026, parent branch `feat/t3code-parity-assessment`, base `08c103ed`.
This is a worktree checkpoint, not a release-readiness certificate.

## Integrated and inspected

- V2 static audit, with full PR/attributable Theo-source limits retained.
- Release source-preflight CLI and revised mobile evidence checklist.
- Reconnect stale-socket guards, rejected-write cleanup and bounded retry jitter.
- Preview serialized CDP key/click input and explicit, non-overwriting downloads.
- Optional owner-managed, host-only scheduling kit. Scheduling and new jobs default off; missed/uncertain occurrences are held.
- Visible queue reorder buttons. Default Enter queues; Cmd+Enter steers, subject to saved client preferences.

The approved release fix from PR #33, `ffc3d481`, was applied with
`git cherry-pick --no-commit` to remove the already-repaired Workspace Kit
boundary violation from this feature checkout. No other local-main commits
were imported. These nine release-fix files are staged; other integrated work
remains unstaged or new. No commit, push or new release was made for this checkpoint.

## Parent verification

Own dependencies installed with `npm ci --ignore-scripts`, not a borrowed
`node_modules` symlink. This reported 22 audit findings, including one critical;
no unapproved `npm audit fix` or dependency/version changes were applied.

Per-area reruns passed:

- Release CLI: 9 Vitest tests and six public-source assertions.
- Reconnect/Preview: 157 tests with `TAU_TEST_SLOW_RENDERS=30`.
- Scheduling: 17 public host-command tests and its own TypeScript project.
- Queue/Composer/Prompt Tools: 55 targeted tests; 49 UI tests also passed with delayed renders.
- Targeted Oxlint and renderer TypeScript checks passed.

The combined 21-file integration command used `TAU_TEST_SLOW_RENDERS=30`
and `--maxWorkers=2`. Result: 273 passed, one failed, 274 total.
The failure was the existing Workspace host test
`tells clients when HEAD moves outside Tau, and answers the new branch at once`.
It did not observe `head-changed` within its five-second deadline.
The same test alone with `--maxWorkers=1` passed in 899 ms. A subsequent
combined rerun with the same slow-render setting and `--maxWorkers=2`, adding
the three HeadWatch tests, passed all 277 tests across 22 files in 10.96 seconds.
The earlier intermittent failure is not a demonstrated fix or proof of
harmlessness. Its cause is unresolved; no timeout widening or watcher change
was made. All ten kit-boundary tests now pass.

Whole-repo Oxlint passed with warnings. `git diff --check` and
`git diff --cached --check` passed.

The first `npm run typecheck` passed its extension and Pi-extension phases,
reached `typecheck:kits`, then exceeded the 180-second command budget without
a compiler diagnostic. No owned tsc process remained afterward. System load
was around 20, but that observation does not prove the cause. Foreign
processes were left untouched. A separately measured Kit typecheck passed in
28.01 seconds, covering 3,798 files and using about 2.15 GB of memory.
A subsequent complete `npm run typecheck` passed every project in 63.93
seconds. No source or test-timeout configuration was changed to obtain that
result. The original slowdown's cause remains unproved.
After Recovery integration and two further parent red-green regressions,
the joint run passed all 453 tests across 34 files with delayed renders and
`--maxWorkers=2`. Complete `npm run typecheck`, whole-repo Oxlint and both
diff checks passed again on that combined state. No full build, build-budget
check or complete application test ran in this parent integration pass. The
worker's isolated Electron Preview probe is recorded in its report, not
claimed as independently repeated here.

## Recovery remains separate

Recovery is now integrated. The worker fixed the two parent review findings
with red-green tests: rejected steering retains the notice, and failed ACK
writes do not consume it in memory. Its final checkpoint passed 132 targeted
tests and 48 slow-render component tests. It preserves pending handles/full
intent before ACK, holds them after restart for explicit release, persists
unsent completed outcomes and holds ambiguous paid parent admission rather
than replaying it.

The parent added two further public regressions and fixes. An already-admitted
follow-up returns delivery with an acknowledgment warning if the previous
result's ACK write fails, rather than inviting another paid send by falsely
rejecting. A result that finishes during admission is not consumed by the old
result's acknowledgment. The parent Recovery run passes 134 tests. Exact
scope and unresolved crash/receipt boundaries remain in
[tau-host-recovery-regressions-2026-10-03.md](tau-host-recovery-regressions-2026-10-03.md).

The worker's earlier pending user-question blocked steering, so its turn was
explicitly restarted from the preserved checkpoint with the conservative
policy. The same thread/runtime continued. No alternate execution protocol
was introduced.

## Release boundary

The already-published nightly `0.7.39-nightly.20261003.35` was built by run
[37134652830](https://github.com/Rasalas/tau/actions/runs/37134652830) from
`ffc3d481`. It excludes the new parity, scheduling, Preview and queue-button
work. Mobile jobs were skipped. Publishing it does not establish that the
Pi background-subagent host-discovery failure is fixed. That diagnosis and
real-provider and full-build/release certification remain separate from the
passing targeted integration gates.

## Further upstream evidence

A read-only process inspection revealed an existing local T3 checkout at
`/Users/tbuck/.t3/worktrees/t3code/t3code-1e5b6b17`, commit
`0080e80c00a3e333e3dcafd85b2615d56f84e3b8`, branch
`t3code/address-pr-closing-feedback`. No files there were changed and its
source has not yet been audited. This may provide a local primary-source
path for the incomplete V2/runtime assessment, without a web-research
transport workaround. Its date/ancestry and uncommitted changes must be
checked before attributing any content to PR #2829.
