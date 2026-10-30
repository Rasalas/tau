# T3 orchestration parity, 29 October 2026

Compared the official `pingdotgg/t3code` history after 11 October through
`7a4f5b6188fed54ddc866723e39446a198b5835c` with Tau at `4df3128d4`.
Read the previous audit, current implementations and ADRs 0006, 0013, 0017,
0020 and 0038. Changes stay within Agents and Scheduling. Access needed no
change in this pass.

## Implemented

### Cancellation reaches descendants despite a stuck runtime

Upstream [bounded delegated stop effects at 30 seconds](https://github.com/pingdotgg/t3code/commit/36d4d711b79c73eb33131944f73ea4a8c6156484)
and [repaired stuck delegated cancellation](https://github.com/pingdotgg/t3code/commit/6a6c84f9906cbdfa7f533fecfc39ce18c2f4c273).
Tau already cascaded parent Stop. Explicit child cancellation still awaited
the child's runtime before reaching descendants, and did not apply parent
Stop's admission hold. A rejected stop skipped the descendants entirely; a
hung stop blocked them indefinitely.

- `kits/agents/host.ts` now holds the whole child subtree before awaiting
  cancellation, suppressing new admissions and completion wakes.
- Descendant cancellation proceeds independently at every depth. A failed
  ancestor no longer prevents its descendants from receiving Stop.
- Each local or remote runtime cancellation has a 30-second deadline. An
  explicit stop reports its timeout; parent Stop logs failed child stops and
  completes the remaining cascade. A still-streaming runtime remains running
  in the book, rather than claiming the timeout terminated it.
- `kits/agents/host.test.ts` adds rejected-stop and hung-stop regressions,
  including queued grandchildren, late results, blocked new delegation and
  both parent Stop and the individual Stop action.

### Maximum-duration timers recover after sleep

Tau's recent `2871eebcc` already rechecked scheduled start deadlines after
sleep. The maximum-duration timer still waited its original relative delay.
A one-hour job could therefore keep running for nearly another hour after
the machine woke past its deadline.

- `kits/scheduling/host.ts` now rechecks the saved expiry deadline at most
  every 30 seconds, even with automations disabled. It also rechecks after a
  backward clock change instead of stopping early.
- `kits/scheduling/host.test.ts` covers sleep beyond the deadline and a clock
  moving backward.

This is a local follow-up found during the scheduling audit, not a verbatim
port. Upstream's [elapsed-time interval correction across DST](https://github.com/pingdotgg/t3code/commit/b18a9bf5b1729723a36903a8d6c9e113ba0cf5d5)
does not apply directly: Tau has cron, UTC daily, one-off and webhook schedules,
and no elapsed-time interval schedule.

## Existing parity and deferred gaps

- Tau already has durable completion notices, acknowledgements, cancelled
  queued children and parent Stop cascades. The old audit's foreign-tool
  permission hole is fixed by `toolMetadataOf`, tool annotations and conservative
  handling of foreign tools. The held-child-queue completion issue is also
  handled by `settleExpectedTurns` and its existing host test.
- Parent waits already return for runtime questions and approvals, including
  non-Pi dialogs, in Tau `bf4e57577`. Finished-child question banners are
  guarded by `runActive` since `855d27915`.
- Upstream [wakes coordinators for child questions](https://github.com/pingdotgg/t3code/commit/fdacb3a3804bb535e8f5c7b733c4445e8567ea62)
  and [stops showing those questions as user attention on parents](https://github.com/pingdotgg/t3code/commit/975b3dc56850d8a22dc90462219e53be95d8dcf7).
  Tau's ADR 0013 keeps child dialogs answered by the user in their own route.
  Copying the upstream banner suppression without coordinator answer routing
  would hide questions. No change made.
- Upstream [settles delegates after leftover background work finishes](https://github.com/pingdotgg/t3code/commit/163bdeaa119f32bf92f25d2841048b808df542a5).
  Tau's kit records completion on turn end and relies on host liveness and
  background-work behavior. Full parity needs a trace through the runtime and
  background task seams outside this assignment. This pass does not claim it.
- Upstream's [Claude command approval text fix](https://github.com/pingdotgg/t3code/commit/5eebf77b373b719ca4456985340707afa267310e)
  concerns its Claude adapter. Tau's Access gate already shows `input.command`.
  Provider-specific plan-mode and session-approval behavior belongs in the
  Claude/Codex kits and was not changed here.
- A stop timeout bounds the caller's wait; it cannot force an unresponsive
  runtime to terminate. No process kill or fabricated completion was added.

## Parent verification

No tests, typechecks, builds or installs were run, as requested. No commits,
pushes or app-data changes were made. Run with the repository check slot:

```sh
npm test -- kits/agents/host.test.ts kits/scheduling/host.test.ts
npm run typecheck:kits
```

The focused suites include existing local/remote cancellation and scheduling
coverage alongside the new regressions. No cross-scope edit is required for
the implemented fixes.
