# Release repository migration

Prepared on 4 November 2026. New builds use `Rasalas/tau` as their update
source. Both stable and nightly releases continue to be mirrored to
`Rasalas/tau-releases` for older installations.

## Start the transition

- Merge the migration change and publish a new stable version through the
  normal release workflow. Record its tag and publication time here.
- Confirm that the version is published in both repositories, with signed
  feeds, all assets and the fixed installer names. Confirm its packaged
  `resources/app-update.yml` names `Rasalas/tau`.
- Update an older installation through `tau-releases`, then confirm its next
  Stable and Nightly checks use `tau`. Check a portable managed host too.
- Keep both repositories publishing for at least seven days from that stable
  publication. If published on 4 November, review no earlier than 11 November.

Transition stable tag: pending publication.
Transition publication time: pending publication.
Earliest cutover: seven days after that publication.

## Review after seven days

- Run `npm run stats`. The report currently counts `tau-releases` downloads
  and opt-in active installations over 7 and 30 days. It needs the operator's
  SSH alias `vps` for Matomo. Downloads are files, not unique people.
- Check GitHub release download counters in both repositories. New builds
  update from `tau`, so the old repository alone no longer measures all traffic.
- Move website and README links, `install:mac`, package-manager generation
  and checked-in manifests to `Rasalas/tau`. Keep historical release JSON and
  fixture URLs as evidence of the releases they describe. Make the statistics
  report cover both repositories rather than losing the old counts.
- Stop recurring stable/nightly uploads to `tau-releases`; remove its
  preflight guard and GitHub App token steps. Only then remove the publishing
  credentials and the GitHub App installation.
- Keep the final migration stable release and a usable migration nightly in
  `tau-releases`, with their signed feeds and all referenced files. Do not
  delete the repository: an installation that was offline for the week still
  needs this bridge to reach a build that updates from `tau`. Existing package
  metadata and shared download links may also still point there.

Seven days is an observation period, not proof that every installation has
updated. No automatic shutdown or deletion is configured.
