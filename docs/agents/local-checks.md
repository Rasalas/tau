# Local checks

Parallel agents can each start a compiler and a test-worker pool. On a 16 GB
machine, eight concurrent kit typechecks consumed about 17.5 GiB before the app
and tests were counted, forcing sustained swapping.

The root `test`, `test:watch`, and typecheck scripts use `scripts/check.mjs`. They
share one slot across linked Git worktrees. The slot is in Git's common directory,
so a checkout in T3 Code, Tau, or a terminal uses the same limit. Separate clones
have separate slots. Direct `vitest` and compiler invocations bypass it.

Typechecks use the native TypeScript 7.0.2 compiler from the `typescript-7`
alias. TypeScript 5.9 remains in `typescript` for its JavaScript API and for
emitting the host in `npm run build` and `npm run dev`. Those emitters name
`typescript/bin/tsc` explicitly because both packages expose a `tsc` binary;
the compiler behind `node_modules/.bin/tsc` can depend on install order.

Choose the smallest check that covers the change:

```sh
npm test -- scripts/check.test.mjs
npm run typecheck:kits
npm run typecheck:mobile
node scripts/check.mjs typecheck -p tooling/tsconfig.electron.json --noEmit
```

The mobile typecheck needs the native client dependencies installed with
`npm ci --prefix mobile --ignore-scripts`. The root `typecheck` includes it;
`npm --prefix mobile run typecheck` uses the same shared check slot.

A waiting command prints the owning worktree and PID before loading the compiler
or test runner. Leave it waiting; starting another command does not make room.
Cancel a waiting command normally if it is no longer needed. The slot lasts until
the runner exits and the operating system releases it even after a crash. A
leftover `tau-check.lock` file is only metadata, not evidence of a held slot.

Watch mode holds the slot until stopped. Finish the watch session before starting
another check. Admission is exclusive but does not promise first-in-first-out
ordering. Each step of the full typecheck acquires the slot independently, so it
does not hold a slot while waiting for a nested check.

The wrapper loads the test runner in its own Node process and starts the native
compiler as a child process. The wrapper holds the slot until that child closes,
passes through its exit status, and forwards interrupt and termination signals.
It does not share compiler state between source trees or reuse results for
changed files. Existing processes and worktrees without this change are outside the limit. Test runners
still manage their own workers; this is an admission limit, not an OS memory cap.
