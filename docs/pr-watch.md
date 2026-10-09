# Pull request watches

Review Kit can watch a GitHub pull request for one thread. Start from the eye
segment in the existing PR strip or workspace summary, or with the
`watch_pull_request` tool (`{ url }`). The segment shows Watching, or
"Watching 3" when the thread watches several PRs, and its tooltip lists them.
Click it for the list: each watched PR with where its checks stand, its wake
count, the last successful read and its own Stop watching, and Watch for an
open PR of the thread that nobody watches. The strip's "+N" tooltip marks the
watched ones.
Devices paired with Full access can start or stop a watch. Read-only devices
can inspect its state.

Every runtime's system prompt carries a `pull_request_watching` section (Pi's
`before_agent_start`, the MCP endpoint's `instructions` elsewhere): an agent
whose next step waits on a PR starts a watch and ends its turn instead of
polling with `gh pr checks --watch`, `sleep` or a background loop. It watches
every PR it waits on, handles every PR a wake names in that one turn, keeps a
standing instruction such as "merge them once they are green" for every PR it
covers instead of asking again, and unwatches a PR before it merges or closes
it itself, so its own merge does not wake the thread.

The host checks once a minute using one compact GraphQL read per PR. Threads
watching the same PR share that read. All checks finishing, a check failing,
new comments or reviews, a new branch conflict, and merge or close produce a
marked wake. One poll sends a thread at most one wake: it names every watched
PR that changed and the outcome of finished checks ("checks passed" or "checks
finished, a check failed (smoke)"), then where the thread's other watched PRs
stand. Its label keeps one subject per PR ("PR #82 · checks passed; PR #83 ·
…"), and wakes that meet in the queue merge their updates under each PR's
number. A running turn gets it as a steer; with "Wakes during a turn"
set to Queue in Settings › General it waits in the visible queue, where its
arrow steers it in. The watch never edits the PR or merges it; the wake tells the agent to merge
only when the user asked it to.

Checks count as finished once nothing is pending: the rollup is no longer
`PENDING`/`EXPECTED`, no check run or status is still in progress, and no
GitHub Actions run of the head commit is unfinished, which covers jobs that
start after others. A single successful check while others run wakes nobody.
A failed check (conclusion `FAILURE`, `TIMED_OUT`, `CANCELLED`,
`ACTION_REQUIRED` or `STARTUP_FAILURE`, or status `FAILURE`/`ERROR`) wakes at
once and is named; each failure wakes once. A new head commit is judged afresh.
The agent's prompt names the event and URL, without copying external comment
bodies into its instructions.

Stop ends all watches for the thread and drops its waiting wake messages through
the host's normal Stop path. Settle ends watches; undoing Settle restores only
those watches, never one the user stopped separately. Merge or close ends the
watch after a final wake. Ten consecutive wakes caused only by comments end it
after the tenth; another kind of event resets the streak. Fifteen minutes
without a readable GitHub answer ends it with a final explanatory wake.
`unwatch_pull_request` stops the named URL, or all watches in the thread when
no URL is supplied.

State lives in Review Kit's `pr-watches.json` and resumes after host restart.
The host saves an observed event before attempting queue admission. If admission
cannot be confirmed, the watch ends and asks the user to inspect the thread;
it does not blindly retry a potentially admitted wake. Stop and a deleted
thread cannot be overtaken by an outstanding provider read. Storage failure
ends monitoring rather than silently continuing without durable fingerprints.

There are at most 100 watch records; ended records are discarded when a new
watch needs room. Only GitHub is supported. The compact query covers up to 100
review threads and 100 checks and refuses larger PRs rather than missing replies in older
threads. An unreadable PR remains visible with its reason and follows the
normal fifteen-minute end rule. Wake counts track observed events handed to the queue, not completed agent
responses. An unconfirmed admission is called out in the ended state.
