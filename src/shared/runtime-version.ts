import type { RuntimeToolVersion } from "./contracts.js";

/** "0.155.1", "v2.1.3", "1.2.0-beta.4"; build metadata after `+` is ignored. */
function parts(version: string): { numbers: number[]; prerelease?: string } | undefined {
  const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/u.exec(version.trim());
  if (!match) return undefined;
  return { numbers: match[1]!.split(".").map(Number), ...(match[2] ? { prerelease: match[2] } : {}) };
}

/** Negative when `left` is older, positive when newer, 0 when equal or either is unreadable. */
export function compareVersions(left: string, right: string): number {
  const a = parts(left);
  const b = parts(right);
  if (!a || !b) return 0;
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  // A prerelease comes before its release.
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && b.prerelease) return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
  return 0;
}

/** True when the backend knows both versions and the installed one is older. */
export function updateAvailable(version: RuntimeToolVersion | undefined): version is RuntimeToolVersion & { installed: string; latest: string } {
  return Boolean(version?.installed && version.latest && compareVersions(version.installed, version.latest) < 0);
}
