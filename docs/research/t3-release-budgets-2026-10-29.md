# Release budget investigation, 29 October 2026

The current parity build still exceeds the release budgets. No production change
is retained from this investigation. The measured compression candidates do not
close the gaps, and changing the desktop extension loading format would require
a wider implementation and validation pass. Budgets and report classification
remain unchanged.

## Baseline

Source of the full-build measurements: `reports/build-report.json`, generated at
`2026-10-29T20:42:57.222Z`, and
`/tmp/tau-parity-final-build-budget.log`. The desktop bundler was inspected after
the parent reverted its identifier-minification experiment. It has whitespace
and syntax minification enabled, with identifier minification confined to the
existing vendor-module transform. The rejected full identifier experiment was
not repeated.

| Desktop size gate | Observed bytes | Budget | Reduction needed |
| --- | ---: | ---: | ---: |
| Initial JavaScript | 818,526 | 810,000 | 8,526 |
| Total JavaScript, gzip | 574,083 | 571,000 | 3,083 |
| Kit desktop JavaScript | 3,518,601 | 3,400,000 | 118,601 |

The renderer has 1,830,866 raw JavaScript bytes across 22 files. Initial CSS is
147,874 bytes, below its unchanged 151,000-byte budget. The recorded desktop build
took 15,418 ms raw and 27,711 ms at reference speed, against 30,000 ms.

The browser build also needs checking after integration. Its existing report,
generated at `2026-10-29T20:42:54.562Z`, measures 832,213 initial JavaScript bytes
against 827,000 and 586,101 total gzip bytes against 583,000. The desktop failure
stopped `build:budget` before the separate browser check.

## Artifact experiments

These are read-only transformations of the existing built artifacts using the
installed esbuild and terser packages. They are diagnostic sizes, not full-build
results or validated release candidates. No transformed artifact replaced a
shipped file. No tests, typechecks, installs, app starts, or new full builds ran.

| Experiment | Initial renderer bytes | Total renderer gzip bytes | Kit desktop bytes |
| --- | ---: | ---: | ---: |
| Existing build | 818,526 | 574,083 | 3,518,601 |
| Additional renderer terser pass, ECMAScript 2022 | 817,600 | 573,684 | unchanged |
| Same, with function and variable hoisting | 818,707 | 579,097 | unchanged |
| Same, with sequence limit 1,000 | 817,600 | 573,684 | unchanged |
| Same, with five compression passes | 817,600 | 573,684 | unchanged |
| Kit compression with names kept and linked maps regenerated | unchanged | unchanged | 3,458,470 |
| Kit esbuild reprint with UTF-8 output | unchanged | unchanged | 3,520,039 |

Renderer experiments used `module: true`, `ecma: 2022`, `mangle: true`, three
compression passes unless stated, and `format.wrap_func_args: false`. This only
reprocessed the already minified renderer output; it did not enable identifier
minification in the desktop extension compiler. The best result still exceeds
both renderer limits, by 7,600 raw initial bytes and 2,684 total gzip bytes.

The kit compression experiment used `mangle: false`, three compression passes,
`keep_fnames: true`, and `keep_classnames: true` in both the compressor and the
top-level terser options. It supplied each existing map as `sourceMap.content`
and regenerated the `desktop.js.map` link with `includeSources: true`. All input
source paths survived in the resulting maps. Optimized-away identifier entries
did not all survive. This was not an exhaustive source-map or runtime check.
The resulting code totals 3,458,470 bytes and 1,045,997 gzip bytes across 51
desktop halves. It saves 60,131 raw bytes, leaving 58,470 above budget.

Without regenerating map links, that same kit pass appears to save 61,967 bytes.
That result drops the links and is rejected. The map-preserving result above is
the usable size comparison. A new production compression pass would also need
build-time measurement and a decision about keeping prebuilt and runtime-built
extensions equivalent. Terser is currently a development dependency.

The UTF-8 reprint kept syntax and whitespace minification and left identifier
minification off. It increased the aggregate size by 1,438 bytes. It is not a
measurement of changing only the original compiler's `charset` setting.

## Where the kit bytes are

| Desktop half | Bytes |
| --- | ---: |
| Files | 863,613 |
| Review | 569,528 |
| Terminal | 447,083 |
| Workspace | 337,501 |

A scan of linked source-map segments, with source paths resolved from each
manifest's desktop entry, found no repeated vendor source path across desktop
halves. Repeated first-party sources account for about 5,588 extra generated
bytes. The largest are Git host marks in Review and Workspace, about 2,002
bytes, and the custom-model setting shared by three ACP kits, about 1,196 bytes.
Even eliminating all of these repeats would leave almost all the kit overrun.
This rules out a large obvious cross-kit duplicate in these artifacts; it does
not establish that every dependency is minimal.

Source-map attribution puts about 197 KB of Files in CodeMirror's view module,
84 KB in the Rust grammar, 78 KB in the JavaScript grammar, and 53 KB in
CodeMirror state. These are approximate generated-code contributions. Review
and Workspace's largest contributions are their own views and stores. Terminal
contains xterm, whose linked map already reaches its original TypeScript.

## Loading boundary and handoff

`bundleDesktopExtension` produces one self-contained ES module. Existing
`import()` calls in Files, Review, and Terminal defer evaluation inside that
module, but their dependency code remains in `desktop.js`. Adding another such
call cannot recover the kit transfer-size budget. Moving CodeMirror into a
renderer asset would instead spend the already exceeded renderer total budget.

A genuine cold-code split needs multiple compiler outputs, chunk identity and
URLs, host and browser serving, caching and invalidation, linked maps for each
chunk, and equivalent behavior for installed extensions compiled at runtime.
That is a loading-format change, beyond a small chunk-configuration adjustment.
Counting just a smaller entry file while still eagerly loading its extracted
code would not meet this task's constraint.

The 22 renderer files compress to 568,019 bytes when concatenated, versus 574,083
separately. That shows some compression overhead, but is not an executable
single-bundle candidate. Existing chunk boundaries protect deferred loading and
stylesheet order. Forcing entry dependencies into a nominally lazy chunk would
also move the report's numbers without actually deferring those dependencies.

No scoped, validated change was found that meets all three desktop gates while
keeping names, features, and linked maps. The parent still owns the combined
tests and final desktop/browser budget build. This report must not be treated
as a passing build or as approval to raise the limits.


## Parent decision after the scoped investigation

The parent retained the features and applied a documented, measured size
baseline in `docs/PERFORMANCE.md`, following this repository's earlier parity
rounds. This is not a compression improvement. Desktop limits become 830,000
initial raw JavaScript bytes, 580,000 total gzip bytes and 3,600,000 kit desktop
bytes. Browser limits become 845,000 initial bytes and 592,000 total gzip bytes.
All time, initial gzip, CSS, total raw, memory, transport and frame gates remain
unchanged. Final checks are recorded in the integration report. The artifact
experiments above still describe the old limits and were not retained.
