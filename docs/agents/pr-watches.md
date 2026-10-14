# GitHub pull request watches

Review Kit polls every minute. Distinct PR reads from a poll start together and
batch up to five aliases by GitHub hostname and credential fingerprint. Each poll
resolves gh's current credential locally and pins it for the request. The token
stays in memory and the subprocess environment; neither tokens nor fingerprints
are logged or persisted. Single-PR watches use one local credential subprocess
plus one API subprocess. Multiple threads watching the same PR share its fresh
read, including a read still running after the cache TTL. Completed watch answers
are never reused by a later poll. A missing or erroneous batch alias gets one
standalone fresh fallback. HTTP-200 partial GraphQL answers remain usable even when gh exits 1;
healthy aliases are delivered independently. Quota errors still suspend the gate.
There is no separate fingerprint/detail cache to invalidate.

The query reads metadata, not conversation bodies or files. Every issue comment,
review and review-thread comment contributes its ID and updated time; reviews also
contribute their state. All accounts are included, including the signed-in account.
Human feedback and other threads' remarks must remain visible. The write paths do
not persist remark ID, exact version and originating-thread provenance, and shell
writes bypass them, so Tau cannot safely identify the watching agent's own replies.
Those replies can trigger wakes; the existing cap stops a watch after ten
consecutive comment-only wakes. No account login proves agent authorship.
Migrating an old tail or account-filtered fingerprint may cause one remark wake
when the complete fingerprint replaces it.

Connections read 100 rows at a time, up to 30 pages each and 100 additional pages
per PR per poll. Pagination is serial and cursor progress is checked. Missing or
incomplete connections, repeated cursors, limits, and more than 100 check contexts
or check suites are unreadable failures; partial fingerprints never become the
baseline. The CLI bounds each response at 16 MiB. Large discussions can cost extra
requests and delay a poll beyond a minute; polls never overlap. Changes made and
reverted between polls are unobservable. Pagination is not a transactional GitHub
snapshot, so activity racing a page read can wait until the next poll.

Quota suspension persists its retry time and pauses the fifteen-minute unreadable
clock across restarts. Retry-After and reset headers from gh's included response
headers override exponential backoff. Without a server time, backoff starts at one
minute and caps at fifteen minutes. Watch reads skip suspended PRs until retry is
due, so an account switch during suspension takes effect at that retry or on a
new watch. A successful read clears the unreadable clock. Genuine failures before
and after a suspension still accumulate toward termination.

Concrete failed check IDs, unfinished workflow suites, force-push baselines,
per-thread grouped wakes, persistence before admission, uncertain-admission stops,
and Stop/Settle lifecycle rules remain in force. Watching grants no PR write or
merge authority.

The measured five-alias cap costs five primary points per batch. At 25 PRs on one
host/credential, without pagination or fallback, a poll uses five API requests,
six subprocesses including local credential resolution, and 25 primary points.
At one-minute cadence that is 300 API requests, 360 subprocesses and 1,500 points
per hour. The measured 25-alias query cost 27 points, so that cap is not used.
