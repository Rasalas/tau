# Thread content search limits

The palette searches user and assistant text, with all query words in one
message, case-insensitively. Reasoning and tool output stay out of palette search.
Find in transcript instead matches a literal substring in text or reasoning and
keeps the newest 2,000 matching message ids. Its structured finder result carries
`truncated`; older desktop extensions may still return an array of ids.

Pi palette search keeps the first 400,000 text characters per session, slicing
an oversized message at the remaining character budget. It reads JSONL in 64 KiB
chunks, reads at most 8 MB per file and 32 MB per query, and skips records over
4 MB rather than accumulating an unbounded JSON line. A skipped record, unread
suffix, file error, result limit, or the 400-session scan limit makes the result
partial. A zero from a partial search does not establish absence. The palette
shows a partial-search row even when there are no matches.

The Pi text cache retains at most 400 entries and 4,000,000 characters across
sessions, evicting
the least recently used entries. Eviction does not remove a session from search:
its text can be reread. File reads run one at a time across queries. Cancellation
stops queued reads and checks between chunks; cancelled results are not cached.
Metadata is shared across concurrent queries and reused for five seconds, then
session paths are listed and statted again with at most eight stats in flight.
Turn completion, reset, deletion, fork, and the `invalidate` command clear metadata
and text immediately. Changed size or
mtime invalidates a cached file after that metadata refresh; additions/deletions
also become visible then. No background scan or watcher is installed.

Other runtimes keep their existing delta index and export limits. The palette
also marks that index partial when more pages remain, text was evicted, or a
thread reaches the runtime export's 64,000-character cap. Reaching that cap is
conservatively partial even if the full text happens to be exactly that length.

The host's `threads` command still returns an array by default. New clients send
`includeStatus: true` to receive `{ matches, truncated, cancelled?, error? }`.
A window supplies a `channel` so a newer query cancels its previous one without
cancelling another window. Transcript read failures reject the find request;
the bar retains loaded matches, labels them partial, and offers Retry.
