# PR review interactions, 29 October 2026

Implemented both recommended review interactions inside Review Kit. Read `AGENTS.md`, `CONTEXT.md`, the domain-doc instructions, ADR 0034 and the recommendations in [the upstream audit](t3code-since-2026-10-11.md). The guide remains a separate reading path under ADR 0034; the filter changes the ordinary diff view only.

## Upstream evidence

Read the official clone at `/tmp/tau-t3code-upstream-20261029`, pinned to `7a4f5b6188fed54ddc866723e39446a198b5835c`, using `git show`:

- [a5448f4c5030b4f70744db5ecfec4cc06828b621](https://github.com/pingdotgg/t3code/commit/a5448f4c5030b4f70744db5ecfec4cc06828b621) adds the test-file filter, shares test/support classification and aligns tree order. Tau already has one `orderFiles` reading order in both request views, which this change preserves.
- [ff424802edd1560fd99fe163e678b67ec09f69b3](https://github.com/pingdotgg/t3code/commit/ff424802edd1560fd99fe163e678b67ec09f69b3) adds an inclusive Viewed range anchored at the previous checkbox interaction and resets its anchor for each PR.

This is a focused adaptation to Tau's views and existing Viewed API, rather than a wholesale transfer of upstream's diff components.

## Behavior

Both `PullRequestCode` and `RemoteReviewDetail` offer a "Hide test files" checkbox beside "Hide whitespace". It starts off and persists under the device-local client-storage key `tau.review.hide-test-files`. Mounted request views in the same renderer share changes immediately. New views read the saved preference.

The shared path classifier recognizes `.test`, `.spec`, `.e2e`, Go-style `_test` and `_spec`, Python test names, common class-test names, test directories, mocks, fixtures and snapshots. It accepts Windows separators. Class names remain case-sensitive so `Latest.java` stays visible. Classification uses paths, not file contents or a language parser.

The file list, selected diff fallback, previous/next navigation, stacked diff cards, sidebar and diff search all use the visible files in the existing order. Hiding the selected test chooses an unviewed visible file, then the first visible file. The legacy view retains its original selection when tests are shown again unless navigation has selected another file. An all-test change keeps the toolbar available and explains why the diff is empty. A guide's explicit Open file action turns the filter off when its target is a test, then jumps there.

The legacy toolbar and the remote Changes tab show visible versus total counts while filtering. The remote sidebar also shows the visible count against the total. Request metadata and change totals continue to describe the whole request. Viewed progress counts actual marks across the complete loaded list, so hiding tests neither marks them viewed nor claims the remaining visible files complete the review. The existing separate count for provider files omitted from the loaded list remains separate from filtered files.

Clicking Viewed establishes an anchor. Shift-clicking another checkbox applies the clicked file's new state to the inclusive range between them in visible reading order. This works forward or backward and can mark or unmark. An absent or filtered-out anchor changes only the clicked file. Switching PRs clears the anchor. Already-correct marks need no write. Hidden files never enter a range.

The shared hook applies optimistic marks and permits one operation per request view at a time. Every changed file uses the existing per-file API. Failures report the file path and restore its server state; successful writes survive other failures in the range. Read-only/offline restrictions still disable Viewed, and the handler also refuses writes when denied. Ordinary clicks in the legacy view preserve its existing advance to the next unviewed visible file. Shift-click stays on the clicked file. The stacked view does not jump when marks change.

Only Review Kit's stylesheet changes, to let the existing toolbars wrap around the extra controls. No core, dependency or workspace files were edited by this task.

## Files

- `kits/review/review-file-interactions.ts`: shared test/support classifier and inclusive range helper.
- `kits/review/use-review-files.ts`: persisted filter and shared optimistic Viewed-range behavior.
- `kits/review/pull-request-code.tsx`: legacy file list, selection, navigation, search, counts and Viewed controls.
- `kits/review/remote-review-detail.tsx`: filtered stack, search, counts, guide navigation and Viewed controls.
- `kits/review/review-detail-store.ts` and `review-detail-sidebar.tsx`: distinguish hidden files from provider omissions and show visible/total sidebar counts.
- `kits/review/styles.css`: toolbar wrapping within the kit.
- `kits/review/review-file-interactions.test.ts`: classifier conventions and range endpoints/order/fallback.
- `kits/review/use-review-files.test.tsx`: request anchor reset, hidden anchor fallback, read-only rejection and overlapping-write protection.
- `kits/review/pull-request-view.test.tsx`: real legacy UI filtering, persistence, selection/navigation/search, marking and unmarking ranges without jumping or marking hidden tests.
- `kits/review/review-detail.test.tsx`: real stacked UI, filtered sidebar/search, visible range writes and recovery from a partial failure.
- `kits/review/file-interaction-test-support.ts`: deterministic changed-file data shared by these tests.

## Verification handoff

Per task instruction, no tests, builds, typechecks, dependency installs or real-app runs were performed. The tests are written but unverified. The parent should run the combined checks through the repository's shared check slot:

```sh
npm test -- kits/review/review-file-interactions.test.ts kits/review/use-review-files.test.tsx kits/review/pull-request-view.test.tsx kits/review/review-detail.test.tsx
npm run typecheck:kits
```

A follow-up component scheduling check uses the same wrapper:

```sh
TAU_TEST_SLOW_RENDERS=30 npm test -- kits/review/pull-request-view.test.tsx kits/review/review-detail.test.tsx
```

Caveats: this is a conventional path filter, so unusual names may need more patterns. Its test/support classifier does not introduce upstream's full code/docs/generated breakdown or change Tau's existing file ordering. Persistence uses client storage, not a machine-wide synchronized preference; other renderer windows read it on mount. Viewed ranges still issue individual provider calls, without a new bulk API. No commits or subagents were created.
