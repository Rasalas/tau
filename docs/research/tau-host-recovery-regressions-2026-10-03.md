# Tau public recovery regressions

3 October 2026. This report supersedes the earlier partial checkpoint. The two acceptance tests left red at that checkpoint are now green, without skips or expected failures. The passing gate establishes the specific boundaries below, not provider-level exactly-once delivery.

Worktree `tau-agent-1ac6668c`, starting HEAD `217d1f92`, merge-base `08c103ede79ad1f090107ddde3824d726fb8ae28`. Read the integrated [V2 coverage audit](t3-v2-coverage-audit-2026-10-03.md) at the dependency barrier. Its findings were static; the failures below were reproduced through public operations. No delegation, backend migration, real app, full suite or build.

## Policy and implementation

The operator selected conservative recovery, consistent with the ordinary prompt queue:

- An accepted pending child retains its **same handle and full intent durably before ACK**. On restart it is held, not eligible for automatic capacity pumping. `tau_send_to_thread` with `auto` or `queue` appends the explicit message and releases it subject to the existing capacity guard. The original same-process capacity queue remains automatic.
- Definitely-unsent completed outcomes are written before the last outstanding tool-owned count is consumed. They survive a busy parent and kit restart, even without a recovered transcript.
- Before parent admission, the outcome moves from `pending` to durable `sending`. Successful admission removes the notice durably. A recovered `sending` notice has no proof of admission: it is held, exposes the answer and uncertainty, and is not automatically replayed. Reading status/wait explicitly acknowledges the retained result. A failed receipt write after successful admission is also held in the running kit.

These are optional version-1 intent/notice records inside the existing version-2 links file. Old version-1 and link-only version-2 records still read. No outstanding ownership or completion obligation is invented for old records. This is forward read compatibility, not a promise that an older binary can preserve new pending records when rewriting the file.

Pending intent includes prompt, stable ID, chosen workspace and machine, frozen definition/persona/tool/access configuration, model and backend selection, and the spawn retry key. Started bindings also retain the stable ID and model. The binding is persisted before the spawn response returns; immediate pending spawns are persisted before any capacity pump may claim them. Persistence failures before initial admission refuse the spawn instead of returning an undurable accepted handle.

Held intent and uncertain notice are exposed through the control-tool status/list responses and the kit's state command/event. No queue UI or panel files were changed. This report does not claim a new visual treatment in the app.

## Parent-review notice-consumption follow-up

The parent found two failures in the initial green implementation. Both were reproduced and fixed through the same public tools, without changing the five checkpoint fixes or any unrelated file.

1. An explicit `steer` to a recovered idle child was rejected, but `sendTo` had already acknowledged its held notice. The new regression failed because `tau_list_threads` lost its held/uncertain state. A rejected action is not an acknowledgement. Pending updates now acknowledge only after the intent update is persisted; local and remote sends acknowledge only after admission succeeds. Validation and admission failures retain the notice.
2. A status ACK removed its notice, wake obligation and uncertainty before the write succeeded. Replacing the store's directory temporarily with a file made the ACK fail. The new regression then observed that public list had lost the held state. ACK snapshots now exclude the observed notice without removing it from memory. Memory consumption happens only after a successful write. An unrelated save after repair and another recovery retain the full answer and uncertainty.

Notice ACKs and wake journal transitions are serialized per parent, but the lock is not held while waiting for provider admission. A third regression blocks an in-flight parent wake, fails the status ACK without waiting for that admission, then admits the wake while its receipt write also fails. After repair, an unrelated save and restart, the notice remains held with the full retained answer and no replay. Generation checks prevent a flush or ACK from consuming a replacement outcome. Serialized saves build their snapshots when their write starts, so an unrelated save cannot commit a stale pre-ACK snapshot after a successful ACK or erase a retained notice after a failed ACK.

The follow-up touches only `kits/agents/host.ts`, `kits/agents/host.test.ts` and this report. The new test answer exceeds the panel excerpt length; no recovered child transcript is supplied.

Exact red commands:

```sh
node node_modules/vitest/vitest.mjs run kits/agents/host.test.ts \
  -t 'explicit steer of its idle child' --maxWorkers=1
node node_modules/vitest/vitest.mjs run kits/agents/host.test.ts \
  -t 'failed status ACK' --maxWorkers=1
```

Each failed before its respective fix. Logs: `/tmp/tau-notice-rejected-action-red.log`, `/tmp/tau-notice-failed-ack-red.log`. The two focused cases passed after the fixes. The concurrency case and the full existing kit/remote tests also pass. No skipped or expected-failure tests were added.

## Boundaries and fixtures

Confirmed seams are public Host prompt, queue and resume operations, and Agents Kit thread-control tools. The new host tests register a fixture runtime through `registerRuntimeBackend`, start real `PiHost` instances, and observe public queue views and runtime admission. No private host methods or internal lifecycle mocks. The fixture blocks admission independently of turn completion.

The kit tests use the existing host-service fixture and invoke `tau_spawn_thread`, `tau_list_threads`, `tau_get_thread_status` and `tau_send_to_thread`. Turn notifications and blocked session admission are inputs at the registered service boundary. One worktree test uses real Git in a temporary repository with hooks and signing disabled. New assertions do not inspect the private book or stored JSON. Existing store-format assertions were updated for the added fields; a legacy-reader test now closes its writer before replacing its file.

All fixture data is temporary. Node is `v22.23.1`, the major required by CONTRIBUTING.md. The borrowed `node_modules` symlink was **unlinked**, not recursively deleted. A fresh, independent installation was created with `npm ci --ignore-scripts`; no package or lockfile changes. All final verification below used this installation. The checkpoint's borrowed-dependency type diagnostics are not current baseline evidence.

## Reproduced failures and minimal fixes

| Public reproduction | Red evidence | Fix and green scope |
|---|---|---|
| A prompt accepted immediately after startup was treated as interrupted work by the later recovery pass. | `-t 'does not recover'` delivered both new work and a hidden restart continuation. | Capture previous-run markers before startup admits client prompts. New work is not recovered as an old turn. |
| A queue head awaiting runtime admission disappeared when a concurrent queue add persisted the remaining list. | `-t 'blocked admission'` restored only the later follow-up. | Include the unresolved in-flight head in every durable queue snapshot. Restart restores both messages, held and ordered. |
| A running tool-started child finished after kit recovery but did not wake its idle parent. | `-t 'after kit recovery'` observed no parent send. | Persist and restore positive outstanding tool-turn counts. Its answer wakes the parent once despite duplicate settlement in the test. |
| Closing before the coalesced link save lost an accepted started child. | `-t 'coalesced save'` recovered an empty child list. | Serialize saves and flush scheduled/in-progress writes on disposal. Started binding is now also persisted before spawn ACK. |
| A real retained worktree lost its identity from the child control API after recovery. | `-t 'worktree identity'` returned status without workspace or branch. | Preserve path, branch and settled marker; recompute change counts rather than storing stale counts. |
| A capacity-queued accepted handle disappeared on restart. | The checkpoint test returned only the started child. The policy-specific hold/release test was rerun red with the independent installation. | Persist the full pending intent before ACK; restore it held with its same ID and retry key. Both explicit release modes respect capacity. |
| A completed child lost the notification owed to its busy parent on restart. | `-t 'unreported answer'` observed no recovered parent send. Rerun red with independent dependencies. | Persist the completed notice before consuming the expected count. Recovery delivers the definitely-unsent answer after the parent becomes idle, without relying on a child transcript. |

The original continuation-test fixture erroneously resolved a streamed prompt before settlement. It was corrected before attributing production failures. The startup race was then reproduced separately.

## Additional passing public coverage

- Held follow-ups survive restart in order, release on an explicit prompt, and advance one at a time. Duplicate settlement before delivery does not send the head twice.
- An opt-in restart continuation is hidden and precedes retained follow-ups.
- A limit holds the queue across restart. The scheduled reset delivers a hidden continuation and releases the follow-up only after it settles. Only timer/Date are faked. The test re-arms the reset through the public operation after installing the fake clock; this is not separate-process wall-clock expiration coverage.
- A rejected admission restores one copy of the queue head and tail; restart retains that order. This behavior was already correct, so it received coverage without another implementation change.
- Capacity becoming free does not start a recovered held child. A repeated spawn retry returns the same held handle. Explicit `auto` and `queue` release still wait for capacity.
- Reopening the kit **without disposing the first writer** observes the pending handle, proving its ACK does not depend on a close-time flush. The original persona/backend/model survives a changed definition file and is used at explicit release.
- An unwritable intent store refuses a spawn before session admission and leaves no accepted child.
- A parent send blocked across kit recovery leaves a durable `sending` notice. Public list/status expose it as held and uncertain, retain the answer, and repeated parent/child settlement does not replay it.
- A version-1 link-only fixture finishes with an answer but does not invent a tool-owned parent wake.
- Existing remote-child restart/following tests pass. No Remote Work implementation or tests were edited.

## Commands and results

The first five red-green slices used these commands before their corresponding fixes:

```sh
node node_modules/vitest/vitest.mjs run src/main/pi-host-recovery-regressions.test.ts -t 'does not recover'
node node_modules/vitest/vitest.mjs run src/main/pi-host-recovery-regressions.test.ts -t 'blocked admission' --maxWorkers=1
node node_modules/vitest/vitest.mjs run kits/agents/host.test.ts -t 'after kit recovery'
node node_modules/vitest/vitest.mjs run kits/agents/host.test.ts -t 'coalesced save'
node node_modules/vitest/vitest.mjs run kits/agents/host.test.ts -t 'worktree identity' --maxWorkers=1
```

All passed after their fixes. The two pending/outcome acceptance cases were rerun red after installing independent dependencies:

```sh
npm ci --ignore-scripts
node node_modules/vitest/vitest.mjs run kits/agents/host.test.ts \
  -t 'capacity-queued.*recovery|unreported answer' --maxWorkers=1
```

Red result: 2 failed / 63 skipped, recorded in `/tmp/tau-recovery-policy-red.log`. These skips came only from the name filter; neither acceptance case was skipped. The former partial combined checkpoint was 108 passed / 2 failed.

Final targeted gate:

```sh
node node_modules/vitest/vitest.mjs run \
  src/main/pi-host-recovery-regressions.test.ts \
  src/main/pi-host-queue.test.ts \
  src/main/pi-host-reopen-after-restart.test.ts \
  src/main/pi-host-cold-start.test.ts \
  src/main/turn-reconciliation.test.ts \
  src/main/turn-delivery.test.ts \
  src/main/queued-messages.test.ts \
  src/main/thread-limits.test.ts \
  kits/agents/host.test.ts kits/agents/remote.test.ts --maxWorkers=1
```

Initial completed gate: 129 passed. After the parent-review follow-up, the same command passes **132 tests across ten files**, no skips or expected failures. Current log: `/tmp/tau-notice-followup-targeted.log`.

```sh
TAU_TEST_SLOW_RENDERS=30 node node_modules/vitest/vitest.mjs run \
  kits/agents/app.test.tsx kits/agents/desktop.test.tsx \
  kits/agents/spine.test.ts --maxWorkers=1
```

Result: **48 passed** across three files. No component changes. The same command was rerun after the follow-up and passes all 48. Current log: `/tmp/tau-notice-followup-components.log`.

```sh
node node_modules/typescript/bin/tsc -p tooling/tsconfig.kits.json --noEmit
node node_modules/typescript/bin/tsc -p tooling/tsconfig.electron.json --noEmit
node node_modules/oxlint/bin/oxlint \
  kits/agents/host.ts kits/agents/host.test.ts src/main/pi-host.ts \
  src/main/queued-messages.ts src/main/pi-host-recovery-regressions.test.ts
git diff --check
```

Kit typecheck, scoped project lint and diff check pass. Main typecheck remains blocked by exactly one untouched snapshot error: `src/shared/linked-file-path.test.ts:2`, TS2835, missing `.js` extension. The parent reports PR33 fixed this in its feature branch/origin/main; that fix is absent from this snapshot and was not copied into this lane. No remaining diagnostics name changed files. The same checks were rerun after the follow-up with identical results. Current logs: `/tmp/tau-notice-followup-kits-typecheck.log`, `/tmp/tau-notice-followup-main-typecheck.log`, `/tmp/tau-notice-followup-lint.log`. An earlier attempt to invoke ESLint failed because this repo uses Oxlint; the scoped project lint above is the verification result.

`pi-host.ts` remains 2,077 lines, below its snapshot's documented 2,080-line boundary limit. No unrelated boundary-limit change was included.

## Parent integration verification

After taking the lane into the feature checkout, the parent added two public-tool regressions:

- A follow-up already admitted by the runtime must not become a rejected tool call solely because acknowledgment of the previous result cannot be written. The pre-fix test rejected with `EEXIST`. It now returns its admitted delivery plus `acknowledgmentWarning`, retains the previous result and preserves the successful in-process request key. Repeating that key sends no second follow-up.
- A new answer finishing during follow-up admission must not be acknowledged as if it were the previous result. With latest-notice acknowledgment, restart returned no answer. Capturing the old notice before admission preserves the new complete answer across restart without a recovered transcript. The regression was verified red against latest-notice acknowledgment, then green with the captured identity.

The parent Recovery run passes 134 tests across ten files. The joint integration run passes 453 tests across 34 files with `TAU_TEST_SLOW_RENDERS=30` and `--maxWorkers=2`. Complete `npm run typecheck`, `npm run lint`, unstaged and staged diff checks pass. PR33's `.js` import fix is present in this parent checkout, so the worker snapshot's compiler blocker does not remain here. These are fixture/component gates, not a real-provider or OS power-loss test.

## Precise crash boundaries and residual risks

1. **Ordinary queued prompts still lack a provider receipt.** The in-flight-head change prevents concurrent-mutation loss, not replay after provider admission but before durable queue removal. Restored ordinary queues are held by default; opt-in continuation paths deserve a separate post-admission process-crash test. No reproduced double-charge claim is made here.
2. **Parent notices have a conservative intent/send journal, not a transaction with the provider.** A crash after writing `sending` but before invoking send holds even a truly unsent answer. A crash after admission but before durable deletion also holds it. This sacrifices automatic delivery when uncertain to avoid paid replay. A rejection from the existing host prompt admission boundary is treated as definitely unadmitted and may retry; no new runtime receipt contract was introduced.
3. **Completion persistence begins at the kit's observed outcome boundary.** A crash before the notice write commits is not covered by the completion-survival test. The previous outstanding count remains durable, but not every backend promises to re-emit a completed outcome on recovery. No claim of universal completion recovery is made.
4. **Binding/start uncertainty is not exactly-once.** A crash during session/worktree creation before durable thread binding can leave an orphan runtime/worktree and a held intent. Automatic restart never admits that held intent. Explicit release is an operator-authorized action, not receipt proof that earlier provider work did not happen.
5. **A send and its notice ACK are separate admissions.** A follow-up can be admitted before its previous-result ACK write fails. The parent fix returns admitted delivery with an acknowledgment warning instead of a false rejection, retains the previous notice and preserves the successful in-process request key. This does not add transactional provider receipts or make retries after process restart exactly-once. Rejected validation or admission itself does not consume the retained notice.
6. **Other control ACKs are not all durability barriers.** Pending spawn ACK and pending-send intent update are barriers; routine non-spawn events still use coalesced saves. This work does not prove every cancel/steer ACK or arbitrary SIGKILL window durable. The restart tests replace host/kit instances against retained storage; they are not OS power-loss/fsync tests.
7. **Worktree identity is narrower than worktree recovery.** Path/branch/settled state survives; apply/discard-after-crash, in-progress Git operations and orphan cleanup need their own public regressions. No apply/discard safety guarantee is inferred from a retained link.
8. **Old stores do not carry intent/notice obligations.** No speculative paid wakes or automatic admission is added for records lacking those fields. New held/uncertain fields are observable in APIs/state; their visual rendering was not tested in the real app.
9. A stale old marker replaced by a new accepted turn in the same session during startup deserves a separate regression. The fixed startup case is marker capture before admission, not a global recovery/orchestrator rewrite.

## Changed files

- `src/main/pi-host.ts`
- `src/main/queued-messages.ts`
- `src/main/pi-host-recovery-regressions.test.ts`
- `kits/agents/host.ts`
- `kits/agents/host.test.ts`
- `docs/research/tau-host-recovery-regressions-2026-10-03.md`

No parent Queue-button, client connection, preview, runtime-specific kit, scheduler, package, workflow, release or build-script files were edited. The five completed checkpoint fixes were retained.
