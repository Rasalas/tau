# ADR 0034: A guided review is written by a visible read-only sub-agent and stored per pull request

A review guide is a tour of one pull request for the person deciding whether it
lands: two to eight stops in reading order, each showing only the lines that
carry its idea, with the one call a reader should make named where there is one.
It does not replace the line-by-line review; review agents have read every line.
T3 Code ships the idea as a beta (guided reviews, agent tools, a phone tour). This
ADR records how Tau builds it in Review Kit without touching core.

## Data model and storage

A guide is `{ headSha, generatedAt, model, stops[] }`. A stop has a title, a
summary, an optional `attention` (`tradeoff`, `contract`, `product`, `risk`,
`accessibility` plus one sentence: the one place to slow down, never a bug),
`excerpts[]` (`path`, `side` new or old, `start`, `end`, `caption`), `files[]`
(changed files the stop owns without excerpting them, each with a one-line note),
up to three line-anchored `notes[]` (lettered A, B, C in the tab) and up to two
`questions[]` about intent. The types live in `kits/review/guide-protocol.ts`.

The store is `guides.json` in the kit's state directory, keyed
`host/owner/repo#number`, one guide per pull request, shared by every thread,
project and window of this host. A push does not delete it, because a guide costs
a model run: the guide is **stale** when `guide.headSha` differs from the request's
current head, and the tab says "Written before the latest push" with a Rewrite
button. The run (`running` with the head and start time, or the last `failed` with
a reason) lives in memory only. A restart drops a running run and the reader asks
again; nothing claims it.

## Who writes it

A visible sub-agent, not a hidden completion. `services.complete` is one call
without file access and only suits small changes; a guide needs to read the code
around a change. The run therefore starts a thread from the `pr-guide` definition:

- It is an ordinary spawned thread (ADR 0013): it shows in the Agents panel, can be
  stopped there, and counts in the costs. Its parent is the thread the request came
  from (the thread on screen for the tab, the calling thread for a tool).
- It works in a throwaway worktree **of the pull request's head commit**, made by
  Agents Kit (ADR 0017) from a revision Review Kit names. Review Kit fetches the
  head (`git fetch origin <sha>`, else the provider's request head ref) into the project's
  repository first, so this needs a project that is a checkout of the request's
  repository. The worktree is discarded when the run ends.
- It is `access: read-only` and keeps `read`, `grep`, `find`, `ls` and two tools
  only it sees. Access Kit blocks `bash` at read-only, so the git commands T3's
  prompt runs are replaced by `read_pull_request_diff` (the changed files with
  counts, or one file's diff with new-side line numbers, from the provider's own
  read of the request, which is also the diff the normalizer holds the guide to).
  `submit_pull_request_guide { runId, stops }` is how the guide arrives, as
  structured arguments instead of free text. Both register in the runtime
  extension of a Pi thread whose persona is `pr-guide`; no other thread lists them.
  Codex writers receive the same two tools over their filtered MCP credential,
  offered only after the host admits the exact child before its first prompt.
  The `runId` in its prompt names the run the call belongs to.
- The seam Agents Kit gains for this (API 1.59.0) is small and generic: a `spawn`
  host command for callers that name an inline definition, a parent thread and a
  revision to start from, and `discard-changes` opens to the same caller. The
  definition is a built-in in Review Kit, not a file in `.tau/agents/`.

Writing is explicit: opening the tab never spends a run. The agent's own text is
not trusted: the host holds the guide to the change before it stores it.

## The normalizer

Pure and unit-tested (`guide-normalize.ts`), a port of T3's idea. From the
provider's file list and hunks it knows which lines each side changed. It clamps
each excerpt to the changed lines it overlaps (at most 25 lines), merges excerpts
that overlap or touch, drops excerpts of files outside the change, drops notes
that sit outside every excerpt of their stop (and past three), drops empty titles,
notes and questions (and past two), lists each file never excerpted in exactly one
stop's `files`, and appends a closing "Other files" skim stop with every changed
file the agent forgot, so each file appears somewhere. A guide with no stop left
is refused and the agent is told to submit again.

## Tools for agents

Review Kit registers, for every runtime over `services.mcp` and in Pi:

- `write_pull_request_guides { pullRequests: [{ url } | { repository, number, host? }] }`
  (1 to 20). It returns per request `started`, `running` or `failed` with a
  `detail` and never waits; the agent does not write the guides, it starts the
  runs ("prepare guides for these five"). Errors are per request.
- `read_pull_request_guide { url | repository + number }` returns
  `{ guide, run, currentHeadSha, stale }`.

Both honour the beta switch ("off hides the tab and refuses runs for people and
agents alike") and Access Kit's gate: starting a run asks like a write, reading
is free.

## Settings, notification and hosts

Settings → Source control gets the beta switch `review-guides` (off by default, machine
wide), a guide model (`review-guide-model`; empty means the parent thread's
model) and "Guide instructions" (`review-guide-instructions`, per project). Never
automatic. When a run ends the host emits `pr-guide-changed`; every window shows
a toast, and Push Kit tells a phone that is away (Review Kit becomes a caller of
its `notify` command).

GitHub, GitLab, Forgejo and Bitbucket Cloud offer guides through the same provider seam. Each
provider supplies its fork-aware head ref: `refs/pull/N/head` for GitHub and
Forgejo, `refs/merge-requests/N/head` for GitLab. The fetch first asks for the exact
commit, falls back to that ref if necessary, and verifies that the requested
commit is present before spawning. The worktree always starts at that commit,
never at the fallback ref's newer tip. Bitbucket Cloud instead supplies
its confirmed source repository and branch. Forks are fetched from the fork's
HTTPS repository, and Git validates the branch ref before fetching. An abbreviated
Bitbucket head expands only from a unique full hash in the PR's fresh commit
listing; missing, malformed or ambiguous identity facts refuse the guide. Fresh request reads refuse a changed head
before spawning or accepting a guide. Unsupported providers hide the tab and
refuse `guide-write` before fetching or spawning. The writer is chosen explicitly in Review's extension settings: Pi by default,
or Codex. Pi keeps its dedicated guide model and effort settings. Codex uses its
normal runtime model, inheriting a Codex parent's model when compatible. Codex
receives the reading/guide-tool allowlist without `access`: its existing backend
uses that list to enforce a read-only sandbox, disable other native tools and
filter the thread's MCP credential. Other runtimes remain refused.

Agents Kit forwards an in-process `beforePrompt` callback to the existing
`sessions.start` admission seam. Review binds the actual thread, parent and
runtime there and rechecks the head, including after time in the queue. Only that
thread can list or execute the run's MCP tools. Agents Kit reports pending
cancellation and startup failures through `onStartFailed`, so Review clears the
run even when no thread was admitted and another write can retry it. The callback stays in memory;
a restart loses guide runs, and their tools remain unavailable. Trusted kits may
create a child in an explicit worktree on the parent's runtime/model; ordinary
delegation still follows the native-subagent default. Early completion cannot
reinsert an ended run after spawn returns.

## Consequences

- A guide for a request of a repository the project does not hold is refused with
  the reason; the reader opens a thread in a checkout of that repository.
- A large pull request takes minutes; the Agents panel shows progress and Stop.
- The phone draws the same data as one screen per stop; its tour logic is the same
  pure module as the desktop's.
