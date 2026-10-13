# Development dependency advisories

Review for ticket 82, 2026-10-13. This records local dependency evidence and
proposed dismissal reasons. It does not close remote alerts.

## Patched dependencies

- Root uses Vitest and its mocker at 4.1.11. Vitest 4 removes Tinypool rather
  than updating it. The existing Vite 6 dependency satisfies its requirements.
- Scoped overrides set UUID to 11.1.1 under `ftp-srv` in Root, `xcode` in
  `mobile/`, and `gaxios` in `relay/`. Their CommonJS consumers call `v4`,
  which UUID 11 still exports. Relay's separate UUID 14.0.2 stays unchanged.
- Relay's affected UUID entry is marked `devOptional`, not exclusively `dev`.
  Its Gaxios consumer is also reachable from production dependencies.
- The test setup reads the suite from the second `beforeAll` argument.
  Global teardown explicitly sets a failing exit code when enumeration fails
  or a tagged process survives. Vitest 4 otherwise only logs teardown errors.
- Six existing test files now specify callable mock signatures because
  Vitest 4's unconstrained mock type also includes constructors.

`scripts/development-dependencies.test.mjs` checks every affected lockfile
entry, the test-worker file tag, CommonJS UUID compatibility, and rejection
of partial UUID buffer writes. `src/test-global-setup.test.ts` checks clean
teardown, enumeration failure, and killing tagged survivors after the grace
period without killing a real process.

Sources: [Vitest migration](https://vitest.dev/guide/migration.html),
[Vitest advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9), and
[UUID advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq).

## Unpatched dependencies

`npm ls ip sprintf-js --all` shows these Root chains:

```text
ftp-srv@4.6.3
  ip@1.1.9

electron-builder@26.16.1
  app-builder-lib@26.16.1
    @electron/get@3.1.0
      global-agent@3.0.0
        roarr@2.15.4
          sprintf-js@1.1.3
```

Both are development dependencies. Neither has a published fixed version in
the advisories checked for this review. Replacing the FTP fixture would not
remove `sprintf-js` from the packaging toolchain.

### IP: proposed dismissal, vulnerable code is not used

The [IP advisory](https://github.com/advisories/GHSA-2p57-rm9w-gvfp) concerns
incorrect public-address classification by `isPublic`. `ftp-srv` does not call
`isPublic` or `isPrivate`. Its active and passive connectors use `isEqual` to
match the data connection's address to the control connection's address.
Tau only imports `ftp-srv` in `kits/servers/fixtures/fake-ftp-server.mjs`.
That fixture validates its loopback bind address before listening and supplies
that same address as `pasv_url`. It is not the shipped FTP client.

Suggested dismissal text: "The affected isPublic API is not used. The only
consumer is a loopback-only FTP test fixture; its connectors use isEqual.
The package is a development dependency and is not shipped with Tau."

### Sprintf: proposed dismissal, vulnerable format input is not reachable

The [Sprintf advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
concerns unbounded precision in attacker-controlled format strings. The only
consumer in the installed Root graph is Roarr under Global Agent in the
packaging toolchain. Global Agent's logging calls use fixed literal messages;
request URLs, response headers and errors are context fields rather than
format strings. Neither Tau nor its FTP fixture imports `sprintf-js`.

Suggested dismissal text: "The only consumer is the development packaging
toolchain. Global Agent passes fixed literal log messages to Roarr; network
data is logged as context, not as a format string. No attacker-controlled
precision specifier reaches sprintf through this dependency chain."

These dismissals need a maintainer's review and remote action. Keep the alerts
open until then, and reassess if the consumer graph or call sites change.

## Verification limits

Local audits no longer report the affected Vitest, Mocker, Tinypool or UUID
advisories in Root, Mobile or Relay. Root still reports IP and Sprintf, and
other advisories outside this ticket remain. The audit command is not clean.

Focused tests exercise the FTP fixture and transport, shared check admission,
core/kit/workbench boundaries, and kit lifecycle with
`TAU_TEST_SLOW_RENDERS=30`. Run the selected files through `npm test --`
with `--maxWorkers=2` and each `--shard=1/3`, `2/3`, `3/3`.
The local sandbox refuses `ps`, so global process enumeration and the real
process-enumeration test cannot pass here. A passing set of test assertions
does not establish a clean teardown. Full-suite and CI verification remain
pending; this review does not run the app or change CI.

The three focused shards passed 178 test assertions across nine files, but
each command failed during global teardown with `spawnSync ps EPERM`.
The new dependency checks failed on the original lockfiles, and both new
teardown failure checks failed before the exit-code fix.
The six test files with updated mock types plus the core/kit boundaries
passed another 114 test assertions with `TAU_TEST_SLOW_RENDERS=30`.
That command also failed solely during global process enumeration.

Lint and the scoped Main, Renderer and Kit typechecks passed. A separate
`scripts/check.mjs typecheck` invocation also checked the shared setup,
global setup, its new test, and `vitest.config.ts` directly, since the usual
scope configs do not include those files. Mobile and Relay lockfiles passed
`npm ci --ignore-scripts --dry-run` without installing their dependencies.
