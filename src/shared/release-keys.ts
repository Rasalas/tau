/**
 * Ed25519 public keys (raw, base64) that sign a release's `latest*.yml`
 * (`scripts/packaging/release-signing.mjs`). Empty until the release workflow
 * signs; while it is, a release is trusted by its checksum from this
 * project's own release URL. Once a key is here, an unsigned feed is refused.
 * `bin/tau-update-helper.mjs` carries the same list; a test keeps them equal.
 */
export const RELEASE_PUBLIC_KEYS: readonly string[] = [];
