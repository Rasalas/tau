# Comparing production builds on Linux

The comparison harness supports Linux with an X11 display and macOS. It uses
each app's installed Electron executable and package entry, including the
reference app's compile-cache bootstrap. Linux process accounting distinguishes
the Electron main process from its renderer and backend.

Tau's startup probe is installed in the current and future main document, so
the first navigation cannot discard it before host confirmation is measured.

Build clean, pinned source checkouts before measuring. For the T3 reference,
use its declared Node and package-manager versions and run
`vp run build:desktop` and the desktop package's `ensure:electron` script. A
Linux build also needs the native helper's libsecret development headers.
Build Tau with `npm run build`. Keep dependency and build work outside the
measurement window.

Use an isolated Xvfb display without a TCP listener, or a display you own. The
harness forwards `DISPLAY` to both apps; it does not inherit the caller's
Xauthority file, session bus or runtime homes. A display requiring authentication
needs a separate setup. Install `lsof`: inability to inspect open files fails the
isolation check rather than reporting a clean run.

Linux uses [`lsof -Q`](https://github.com/lsof-org/lsof/blob/master/docs/manpage.md)
to ignore search targets that exited; a nonzero result still fails the check.
On macOS, a missing target is accepted only if it has exited and `lsof` reports
no diagnostic. This keeps an inspection error distinct from normal process churn.

Set `COMPARE_REFERENCE_SOURCE` to the reference checkout. Set
`COMPARE_TAU_ROOT` and `COMPARE_REFERENCE_ROOT` to distinct scratch folders under
`/tmp`, then run:

```sh
npm run benchmark:compare -- --seed --runs 5 --warmup 1 --out reports/compare-linux.json
npm run benchmark:compare:summary -- --out docs/performance/compare-linux reports/compare-linux.json
```

The harness excludes real app data on both platforms, including Linux's
`~/.config/tau` and T3's config folders. If the source checkout itself lives
inside `~/.t3`, make clean benchmark source copies under `/tmp`; do not weaken
the file guard to accommodate it. Run the harness from the Tau copy.

Keep the sandbox enabled when the machine supports it. On an isolated test
machine whose sandbox helper cannot be configured,
`COMPARE_DISABLE_SANDBOX=1` adds `--no-sandbox` to both comparison launches.
The raw report and generated summary record that condition, the display kind
and background mode. Reports with different launch conditions cannot be pooled.
This option belongs to the comparison harness, not the product launcher.

Linux/Xvfb results describe that machine and rendering setup. Compare current
apps within the same run; do not interpret differences from a historical Mac
report as a product speedup or regression. GPU and CPU conditions, revision,
sample count and missing measurements belong beside any conclusion.
