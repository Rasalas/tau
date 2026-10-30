# Review and workspace parity, 29 October 2026

Compared the current Tau checkout with official T3 Code through [`7a4f5b6188fed54ddc866723e39446a198b5835c`](https://github.com/pingdotgg/t3code/commit/7a4f5b6188fed54ddc866723e39446a198b5835c), using the local upstream clone and the October 11 audit as a starting point. Read `AGENTS.md`, `CONTEXT.md`, ADR 0006, ADR 0017 including its amendments, and ADR 0034. This is a source comparison, with no app verification or test execution.

## Implemented

A bounded Git-path correctness pass, adapting upstream's [whitespace preservation](https://github.com/pingdotgg/t3code/commit/aef0e9ca401acb40057a286a19de8768809db960), [quoted filename handling](https://github.com/pingdotgg/t3code/commit/51dcb43062e9582ddcd5f1ac77e524832d4f9dfa), and [compatible worktree-list handling](https://github.com/pingdotgg/t3code/commit/a0ea721c47f0b1ac923fbff1043d2994500ecf51) to gaps still present in Tau. Tau already decoded quoted PR patch paths; agent summaries, local Reviews and worktree storage still had separate affected readers.

- Agent change summaries and local Reviews use NUL-delimited numstat and untracked-file output. Leading/trailing spaces, tabs, quotes and embedded newlines remain actual paths. Agent rename summaries return the destination path instead of Git's display syntax.
- The existing NUL numstat reader now accepts embedded newlines, fixing line counts in ordinary workspace changes and checkpoint/tree comparisons too. One small pure parser supplies all three consumers, without loading Workspace's Git engine into the agent-worktree module.
- Worktree picker, project scans, local review and storage readers now request NUL-delimited worktree records. The first integration run showed that Apple Git emits literal newlines even with `core.quotePath=true`, so decoding quoted line output alone was insufficient. The shared parser preserves literal fields in NUL mode and still accepts C-quoted legacy fixtures. Storage can inspect linked worktrees and report their orphans while retaining its ownership and dirty-file protections. This uses Git's `worktree list --porcelain -z` support.
- A refused worktree removal checks decoded entries before proceeding. Previously a quoted path could miss the raw-text existence test, swallow Git's refusal and attempt the branch-deletion step. The refusal now propagates and branch deletion is skipped.

Changed implementation files:

- `kits/workspace/git-output.ts`, a new pure parser module.
- `kits/workspace/git-diff.ts`, retaining the existing `parseNumstat` export for callers.
- `kits/workspace/agent-worktrees.ts`.
- `kits/workspace/thread-branches.ts`.
- `kits/workspace/worktree-layout.ts`.
- `kits/workspace/worktree-storage.ts`.
- `kits/workspace/workspace-worktrees.ts`.

Regression coverage added in `git-output.test.ts`, `agent-worktrees.test.ts`, `thread-branches.test.ts`, `worktree-storage.test.ts` and `workspace-worktrees.test.ts`. It covers verbatim filenames, renames/binary counts, quoted UTF-8 worktree paths, a local review in a quoted worktree, orphan discovery, dirty-file retention and propagation of Git's removal refusal.

## Already present

The October 11 audit is substantially stale in this area. Current Tau already has settled-thread retention, orphan worktree reporting, missing-worktree restoration, central worktree storage, exact merged-PR head checks for cleanup, config-write serialization with lock retries, competing-fetch recovery, and explanatory PR diff failures. These did not need another implementation.

[Distinct CI checks with overlapping names](https://github.com/pingdotgg/t3code/commit/5e5c52b7a70c16734e42faa072248a597e1333ee) are already distinguished by Tau's `workflow + NUL + name` key. Tau also deliberately retains any running duplicate, addressing the October 11 audit's unfinished-run bug. Its PR watch reads raw contexts and unfinished workflow suites. Do not replace that behavior with a naive newest-run-only rule.

## Deferred

- [Forgejo required-check policy](https://github.com/pingdotgg/t3code/commit/c1a24f884edd7f64f2039c89df9d5918e970d20b) remains a real feature gap. Tau has no required-check flag and only GitHub has agent PR watches. This needs a separate provider/protocol/UI change rather than an isolated status-parser port.
- [Wakes when remaining advisory checks finish](https://github.com/pingdotgg/t3code/commit/09bb9f157b3548043e9e241f34fe3a600a55a57b) depends on upstream's early required-check wake model. Tau currently waits for all observed checks/workflow suites; the same early-wake issue does not map directly.
- Some repository-root reads still call `.trim()` on `rev-parse --show-toplevel`. A checkout whose directory name itself ends with whitespace remains outside this pass. File paths and quoted worktree paths containing internal control characters are covered.
- No cross-scope edits are required for this patch. No files outside `kits/workspace/` and this report were changed by this task.

## Checks for the parent

Not run, as requested. Only `git diff --check -- kits/workspace` was run and passed.

```sh
npm test -- kits/workspace/git-output.test.ts kits/workspace/git-diff.test.ts kits/workspace/workspace-git.test.ts kits/workspace/agent-worktrees.test.ts kits/workspace/thread-branches.test.ts kits/workspace/worktree-storage.test.ts kits/workspace/workspace-worktrees.test.ts
npm run typecheck:kits
```

The parent should fold these into its single combined check run. No commit, push, dependency install or user app data access was performed.
