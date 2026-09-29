/**
 * Ed25519 public keys (raw, base64) that sign a release's `latest*.yml`
 * (`scripts/packaging/release-signing.mjs`, secret `TAU_RELEASE_SIGNING_KEY`).
 * The host refuses a feed without a signature by one of them.
 * `bin/tau-update-helper.mjs` carries the same list; a test keeps them equal.
 * Rotation: docs/host-updates.md, "Release signing".
 */
export const RELEASE_PUBLIC_KEYS: readonly string[] = [
  "8hB4AtWuF6uBYObUdffh+1Ib9FMY5S8RCqm0RRp2Smg=",
];
