# Local checks

Parallel agents can each start a compiler and a test-worker pool. On a 16 GB
machine, eight concurrent kit typechecks consumed about 17.5 GiB before the app
and tests were counted, forcing sustained swapping.

The root `test`, `test:watch`, and typecheck scripts use `scripts/check.mjs`. They
share one slot across linked Git worktrees. The slot is in Git's common directory,
so a checkout in T3 Code, Tau, or a terminal uses the same limit. Separate clones
have separate slots. Direct `vitest` and `tsc` invocations bypass it.

Choose the smallest check that covers the change:

```sh
npm test -- scripts/check.test.mjs
npm run typecheck:kits
node scripts/check.mjs typecheck -p tooling/tsconfig.electron.json --noEmit
```

A waiting command prints the owning worktree and PID before loading the compiler
or test runner. Leave it waiting; starting another command does not make room.
Cancel a waiting command normally if it is no longer needed. The slot lasts until
the runner exits and the operating system releases it even after a crash. A
leftover `tau-check.lock` file is only metadata, not evidence of a held slot.

Watch mode holds the slot until stopped. Finish the watch session before starting
another check. Admission is exclusive but does not promise first-in-first-out
ordering. Each step of the full typecheck acquires the slot independently, so it
does not hold a slot while waiting for a nested check.

The wrapper loads the tool in its own Node process. It does not share compiler
state between different source trees or reuse results for changed files. Existing
processes and worktrees without this change are outside the limit. Test runners
still manage their own workers; this is an admission limit, not an OS memory cap.
