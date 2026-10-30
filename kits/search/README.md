# Thread content search

The palette searches visible user and assistant text, with all query words in
one message. Whole words rank above prefixes and substrings. Reasoning and tool
output stay out of palette search. Opening a message hit resolves its best
message against the runtime's current ids before navigating there.

Find in transcript matches a literal substring in text or reasoning and keeps
the newest 2,000 matching message ids. Its structured finder result carries
`truncated`; older desktop extensions may still return an array of ids.
Transcript read failures reject the request so the bar can retain loaded
matches, label them partial, and offer Retry.

The machine-local message index streams Pi sessions and versioned runtime
exports to disk. Completed generations include older sessions and the middle
of large messages without retaining whole sessions in RAM. Runtime exports
arrive in pages of at most 64,000 characters. A changed or failed export never
publishes a half-written generation. Older runtime providers expose only their
legacy prefix, which remains partial coverage.

While the index is unavailable or disabled, Pi search uses bounded cold reads.
It keeps the first 400,000 text characters per session, slicing an oversized
message at the remaining budget. Reads use 64 KiB chunks, stop at 8 MB per file
and 32 MB per query, and skip records larger than 4 MB. At most 400 admitted
sessions are scanned, newest first. A skipped record, unread suffix, file error,
result limit, or remaining session makes coverage partial. A zero from a
partial search does not establish absence. The palette shows a partial-search
row even when there are no matches.

The cold text cache retains at most 400 entries and 4,000,000 characters across
sessions, evicting the least recently used entries. Evicted text can be reread.
File reads run one at a time across queries. Cancellation stops queued reads
and checks between chunks; cancelled results are not cached. Metadata is
shared across concurrent queries and reused for five seconds, with at most
eight stats in flight. Turn completion, reset, deletion, fork, and the
`invalidate` command clear cold metadata and text. Thread lifecycle events also
refresh the persistent index.

The palette uses `thread-search` continuation pages so a cold search can return
useful matches while work continues. `complete` describes job completion;
`truncated` and `error` describe coverage even after a job finishes. The legacy
`threads` command returns an array by default. Callers can send
`includeStatus: true` for `{ matches, truncated, cancelled?, error? }`. Both
protocols use a per-window `channel` to cancel superseded work without
cancelling another window. The active transcript takes precedence over stored
text when its runtime is available.
