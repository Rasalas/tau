# GitHub access across paired hosts

Review Kit can run supported GitHub API operations through `gh` on another
paired host. Tokens stay in that host's `gh` installation. Tau transfers typed
operation inputs and their results, never credentials, shell commands or CLI
arguments. Both hosts independently verify the same numeric GitHub account id
on the chosen GitHub endpoint before each forwarded operation. Verification is
not cached.

## Setup

1. Pair the hosts in both directions under Settings → Machines. Enable
   "Agents may work there" on both. Review uses those authenticated host
   connections through `services.machines`; its identity checks need the return
   connection even when only one host supplies GitHub operations.
2. Sign `gh` into the same account on the same GitHub endpoint on both hosts.
   The tokens can have different scopes. Both hosts need a pinned public host
   identity. A host without one cannot enable sharing.
3. On the project host, open Settings → Review → GitHub across paired hosts.
   Choose the other machine and its GitHub endpoint. Select Read PRs or Read
   and act.
4. On the credential host, find the project host's paired device in the same
   section. Select its source host, endpoint and matching permission. Approve
   the companion "Agents" device because it carries the host-to-host request.
5. To use that machine for actions even when the local token can read the PR,
   turn on Use for actions on the project host. Only one host per GitHub
   endpoint can have that preference. An unavailable preferred host refuses
   the action before any mutation is sent.

Owner access is required to change these approvals. A paired device cannot
approve itself. Read only pairing permits reads and blocks actions at both
the originating command and the receiving command. Changing a device from
Full to Read only clears its approval.

## Operations

| Operation | Execution |
| --- | --- |
| PR details, checks, conversations, candidates, viewed marks and stack reads | Local first; failed safe reads may try approved connected hosts |
| Comments, replies, line comments, reviews, title/body edits, conversation resolution, comment edits, labels, reviewers and viewed marks | Local by default; an approved action host may be selected before dispatch |
| Merge and auto-merge of a PR opened by URL, revert, stack merge/rebase | May use an approved action host; checkout-backed merge stays on its project host |
| Project PR listings, current branch lookup, diffs, checkout, create/publish and checkout-backed edits | Project host |

Without an explicit action-host preference, Tau reads the PR locally before
starting a mutation. A successful read selects the local host. A failed read
can select an approved action host. A token that can read but cannot write
will still attempt the action locally unless Use for actions is enabled.

Once any mutation starts, Tau never retries it on another host. Connection
loss can leave the outcome unknown. The error says Tau did not retry and asks
the user to check GitHub before trying again. Stack operations may have
completed earlier layers before an error; the provider reports that progress.
Incoming operations use the raw local provider and never forward again.
A request naming a different source host, endpoint or unsupported operation
is refused before the API operation.

## Consent lifetime

Approvals are stored in Review Kit's state directory as `github-sharing.json`,
mode 0600. They bind the host/device id, pinned public identity, active Tau
endpoint and GitHub endpoint. Ordinary host or kit restarts preserve them.
Turning sharing Off, disabling "Agents may work there", forgetting a machine,
revoking or removing a device, changing the pinned identity or active endpoint,
or changing the verified GitHub account clears the affected approval.
Temporary disconnection preserves approval but prevents routing. Review being
disabled prevents its commands from running; re-enabling it checks saved
approval against the current pairing and identity before use.

Tests use two host registries, fake provider operations and fake authenticated
machine connections. They exercise approvals, identity mismatch, read-only
origin and receiver refusal, local preference, chosen remote actions,
unsupported/reflected operations, persistence, revocation and uncertain writes.
They perform no real GitHub writes.
