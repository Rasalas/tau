# T3 mobile parity, 2026-10-29

Compared Tau with the complete local T3 Code clone at `/tmp/tau-t3code-upstream-20261029`, pinned to [7a4f5b6188fed54ddc866723e39446a198b5835c](https://github.com/pingdotgg/t3code/commit/7a4f5b6188fed54ddc866723e39446a198b5835c). The supplied change log covers October 11 through October 29. This pass owns only `mobile/**` and this report. No dependencies changed.

## Upstream evidence and Tau comparison

- T3 centralized native activity observation in [c8c6deb6139a4dfb0ef353a003aa8d19761b720f](https://github.com/pingdotgg/t3code/commit/c8c6deb6139a4dfb0ef353a003aa8d19761b720f). Its [app-state source](https://github.com/pingdotgg/t3code/blob/c8c6deb6139a4dfb0ef353a003aa8d19761b720f/apps/mobile/src/lib/appState.ts) reads React Native activity state. Tau already routes Capacitor foreground and network events to its socket through `mobile/src/wakes.ts`. However, `main.tsx` did not supply `AppContext.visibility`, so other-machine polling and widget refreshes used the document's visibility rather than native activity state. Implemented the missing native input to those existing consumers.
- T3 made an incoming pairing link update the open connection form in [76d5ec7a22a312c3b9cb6a64102de1933321e665](https://github.com/pingdotgg/t3code/commit/76d5ec7a22a312c3b9cb6a64102de1933321e665). Tau already fills its open Add machine form, but an older native QR scan could finish afterward and overwrite that link. Implemented a guard against that stale completion.
- T3 preserved typed connection-dependent form input through reconnects in [737eab244dc1e30067a1aa8acf9f671fc1c25eea](https://github.com/pingdotgg/t3code/commit/737eab244dc1e30067a1aa8acf9f671fc1c25eea). In Tau's analogous phone-only pairing flow, a failed scan replaced the Add screen's seeded text. If the screen opened from a link and the user edited it, the replacement cleared that edit. A successful scan also lost its link after pairing failed because the input unmounted. Both now retain retry text. This adapts the retention behavior, rather than copying T3's project form.

These changes follow ADR 0016's shared workbench, ADR 0019's ownership of thread drafts, and ADR 0041's native-client trust boundary. They add no alternate draft store or remote-code path.

## Implemented behavior and files

- `mobile/src/app-visibility.ts` creates one native activity observation shared by other-machine polling and widget refreshes. It seeds the current state, preserves newer events over a late initial read, deduplicates repeated events, and removes its listener on disposal. `mobile/src/main.tsx` installs it for native clients and disposes it when the page leaves. Browser development and native listener-registration failures retain the existing document fallback.
- `mobile/src/Shell.tsx` captures the current pairing input before scanning, retains it on scan errors, and retains a scanned link for retry after pairing fails. A scan result is ignored after another view or incoming link replaces its originating view. `mobile/src/ui/AddHostScreen.tsx` passes the current field text to the scan action.
- `mobile/src/app-visibility.test.ts` covers background startup, shared subscribers, duplicate events, unsubscribe/disposal, a stale initial read, and initial-read failure. `mobile/src/activities.test.ts` now drives the actual visibility adapter to verify that native background events pause the periodic usage refresh and foreground events catch it up.
- `mobile/src/ui/screens.test.tsx` covers edited incoming links across denied, failed, unavailable, invalid and cancelled scans; retrying a scanned link after an unreachable machine; and an old scan finishing after a newer pairing deep link.

## Validation handoff

Tests, typechecks, builds and installs were intentionally not run. The integrating parent owns combined execution. `git diff --check -- mobile docs/research/t3-mobile-parity-2026-10-29.md` passed.

Focused commands for the parent, through the repository's shared check slot:

```sh
npm test -- mobile/src/app-visibility.test.ts mobile/src/activities.test.ts mobile/src/machines.test.ts mobile/src/ui/screens.test.tsx mobile/src/wakes.test.ts
npm run typecheck:mobile
```

The mobile dependency directory is absent in this checkout. The parent may need the documented dependency setup before the mobile typecheck. No native device session was run. A device check should background and foreground Tau while its web view remains loaded, then confirm other-machine visits resume and pairing input survives scanner failures.

## Deferrals

- T3's [reconnecting thread-route fix](https://github.com/pingdotgg/t3code/commit/a42bdd4e516433a16650b9401ab3c066544ca5cd) touches thread hydration. Tau puts that coordination in `src/workbench` and the shared renderer, outside this pass's ownership. Existing native socket wake handling and per-machine storage were retained.
- T3's [file-tree isolation work](https://github.com/pingdotgg/t3code/commit/689763a603a72f38c451f1b9409e187216932386), archive browsing and Markdown/file rendering belong to Tau's shared renderer and extensions. No duplicate phone file viewer was introduced.
- T3 distinguishes React Native's transient inactive state from background state. Capacitor exposes the existing boolean `isActive` contract used by Tau's socket wakes. This pass uses that same contract; it does not invent a second lifecycle interpretation or change socket reconnection policy.
