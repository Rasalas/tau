# GitHub refresh request counts in Tau

Measured on 3 October 2026 with Review Kit's existing host-extension test harness and recorded GitHub fixtures. No account access or remote writes were used. This checks the candidate from upstream T3 Code PR #14673 against Tau's own request flow.

## Measured duplicate

`usePullRequest.refresh(true)` starts detail, conversations, and, when opened, files. GitHub conversations and files both need the same GraphQL connections for review threads and viewed marks. The cache already shares ordinary reads for one minute, but each fresh read previously started another query even while a fresh query was pending.

The test starts `pr-view`, `pr-comments`, and `pr-files` together, holding the GraphQL response until both consumers have reached the provider. Its counts exclude the account identity lookup, which the harness answers separately.

| One refresh with files open | Before | After |
| --- | ---: | ---: |
| `gh pr view` subprocesses | 1 | 1 |
| `gh pr diff` subprocesses | 1 | 1 |
| `gh api graphql` thread/file reads | 2 | 1 |
| Total request subprocesses | 4 | 3 |

The regression failed before the change with four calls instead of three. The same test passes after the change. These are CLI invocation counts, not measured HTTP request counts inside `gh`, latency measurements, or a prediction for all GitHub traffic. Tau already batches repository lists and reads stack metadata with GraphQL. There is no evidence here for the upstream 74 percent reduction applying to Tau.

## Change and limits

The existing cache accepts an optional `coalesceFresh` flag. Only GitHub's threads/viewed-mark read opts in. A fresh read joins another fresh read only while it is unfinished and less than the existing one-minute read limit old. A completed read is never reused by another fresh request. An ordinary pending read cannot satisfy a fresh request.

The flag applies inside the local GitHub provider, after routing, rather than around the remote-routing operation. Cache entries still belong to one host-extension instance and one request URL. Different endpoint URLs remain separate. Routing continues to verify shared-account identity and permissions. No global map, batching window, polling delay, or new cross-account reuse is added.

A write drops the entry even if its read is pending. A subsequent refresh starts a new query; completion of the old query cannot replace it. A rejected refresh is removed, and the existing rate-limit gate still handles provider errors. Sequential check polls continue to read fresh.

Validation covers the measured refresh, sequential refreshes, a pending ordinary read followed by a fresh read, a mutation during a pending refresh, endpoint separation, and failed-read retry. Existing routing and rate-limit tests also run unchanged.
