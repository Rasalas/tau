# Loaded transcript memory

The workbench retains whole host pages. It never derives an opaque cursor,
shortens a message, or splits task/activity metadata away from its source page.

`TranscriptPageWindow` owns a contiguous backward-reading window and the live
tail. Historical pages have budgets of 1,000 messages, 8 MiB of retained-data
weight, and eight pages. Adding a page evicts the newest historical pages first,
keeping the two oldest pages so prepending retains the preceding leading row.
Scroll loading starts only while the visible anchor belongs to the leading
source page. If the reader moves elsewhere during a fetch, that page is not
applied and its cursor remains available. This keeps byte-heavy metadata from
causing eviction under a reader farther down the window.
The tail has a separate 1,000-message / 8 MiB budget across overlapping host
refreshes; exceeding it replaces that tail with the incoming host window and
its original cursor. Live rows received between details stay in the tail.

A gap before the tail explicitly says that newer turns were released and offers
Reload from latest. Back to latest turns above the history does the same. Both
release the historical window and retain live rows. Scrolling up then reads the
evicted pages again through the tail's original host cursor. Searching for an
unloaded message restarts at the tail when a gap exists, then traverses backward
with the existing 500-request guard. Navigation only lists loaded turns. No
coordinates or bookmarks for discarded pages accumulate. A missing older
cursor with an internal gap means unknown completeness, never complete.

The shared detail cache admits whole contiguous tails only. It has aggregate
limits of 5,000 messages and 32 MiB retained-data weight, in addition to its
existing thread-count limit. A detail that exceeds either budget is not cached;
the active view still owns it. Switching threads and bootstrap persistence keep
only the tail, so no gap can be mistaken for a contiguous cached transcript.

## Limits

These are retained-data budgets, not measurements of the JavaScript heap.
`transcriptRetainedBytes` counts UTF-16 strings, keys, scalar values and container
slots. Merged arrays share message and metadata objects with the source pages;
React, DOM, host runtime storage and transient merge allocations are outside
these budgets.

Source pages are indivisible because the protocol exposes backward cursors at
page boundaries only. A source page can contain an oversized message, many
records, or large task/activity metadata. The two leading historical pages and
the current host tail are admitted in full even if each exceeds its budget.
Thus the active view is bounded by the configured budgets **or those three
source pages**, plus live records received before the next host detail. This is
not a hard per-record or process-memory ceiling. A hard ceiling requires a host
contract for loading individual message bodies and finer cursor boundaries.

The protocol has no forward page operation. Reading a discarded newer page
therefore restarts from the tail rather than paging forward from the old
window. Search beyond 500 requests retains the existing false result; the user
can continue scrolling older history. Full export and persisted history are
unchanged.
