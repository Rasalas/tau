/** Which releases an installed Tau updates to: tagged releases, or the build of `main` a nightly run published. */
export type UpdateChannel = "stable" | "nightly";

export const UPDATE_CHANNELS: readonly UpdateChannel[] = ["stable", "nightly"];

export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = "stable";

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === "stable" || value === "nightly";
}

/** `0.4.1-nightly.20260922.17`, the version the release workflow stamps on a nightly build. */
const NIGHTLY_VERSION = /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/u;

export function isNightlyVersion(version: string): boolean {
  return NIGHTLY_VERSION.test(version);
}

export interface VersionSkew {
  window: string;
  host: string;
}

/**
 * The window's process and the host process it talks to run different builds.
 * Unknown on either side is no skew: a web client has no window process, and a
 * hello that has not arrived yet says nothing.
 */
export function versionSkew(window: string | undefined, host: string | undefined): VersionSkew | undefined {
  const left = window?.trim();
  const right = host?.trim();
  if (!left || !right || left === right) return undefined;
  return { window: left, host: right };
}
