/**
 * Version of the contribution interfaces an extension package builds against:
 * `HostExtensionServices`, `DesktopExtension` and the workbench hooks in
 * `tau`. Bump the major when one of them breaks, the minor when it grows.
 */
export const EXTENSION_API_VERSION = "1.58.0";

/** What a manifest's `engines` may constrain. */
export interface ExtensionEngines {
  tau?: string;
  pi?: string;
  api?: string;
}

/** The versions a running Tau offers for those constraints. */
export type ExtensionHostVersions = Record<keyof ExtensionEngines, string>;

export const ENGINE_LABELS: Record<keyof ExtensionEngines, string> = {
  tau: "Tau",
  pi: "Pi",
  api: "the extension API",
};

type Version = [number, number, number];

/** Parses `1.2.3`, `v1.2`, `1.2.3-beta.1` (prerelease ignored); undefined for anything else. */
export function parseVersion(value: string): Version | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compare(left: Version, right: Version): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/** Upper bound (exclusive) of `^x.y.z`: the next major, or the next minor/patch below 1.0.0. */
function caretUpper([major, minor, patch]: Version): Version {
  if (major > 0) return [major + 1, 0, 0];
  if (minor > 0) return [0, minor + 1, 0];
  return [0, 0, patch + 1];
}

function comparatorMatches(comparator: string, version: Version): boolean | undefined {
  const match = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/u.exec(comparator);
  if (!match) return undefined;
  const operator = match[1] ?? "=";
  const raw = match[2];
  const target = parseVersion(raw);
  if (!target) return undefined;
  const missingMinor = !/^v?\d+\.\d+/u.test(raw);
  const missingPatch = !/^v?\d+\.\d+\.\d+/u.test(raw);
  switch (operator) {
    case "^": return compare(version, target) >= 0 && compare(version, caretUpper(target)) < 0;
    case "~": return compare(version, target) >= 0 && compare(version, [target[0], target[1] + 1, 0]) < 0;
    case ">=": return compare(version, target) >= 0;
    case ">": return compare(version, target) > 0;
    case "<=": return compare(version, target) <= 0;
    case "<": return compare(version, target) < 0;
    default:
      // A bare "1" or "1.2" means that major or minor line, like npm's x-ranges.
      if (missingMinor) return version[0] === target[0];
      if (missingPatch) return version[0] === target[0] && version[1] === target[1];
      return compare(version, target) === 0;
  }
}

/**
 * A small semver range check: `*`, `1.2.3`, `1.2`, `^1.2.3`, `~1.2.3`, `>=1.2.3 <2`,
 * and alternatives with `||`. Throws on a range it cannot read, so a typo in
 * a manifest surfaces as a manifest error rather than as "incompatible".
 */
export function satisfiesRange(versionText: string, range: string): boolean {
  const version = parseVersion(versionText);
  if (!version) throw new Error(`"${versionText}" is not a version`);
  const alternatives = range.split("||").map((part) => part.trim());
  if (alternatives.some((part) => !part)) throw new Error(`"${range}" is not a version range`);
  return alternatives.some((alternative) => {
    if (alternative === "*" || alternative === "x") return true;
    const comparators = alternative.split(/\s+/u);
    return comparators.every((comparator) => {
      const matched = comparatorMatches(comparator, version);
      if (matched === undefined) throw new Error(`"${range}" is not a version range`);
      return matched;
    });
  });
}

/** Validates the `engines` ranges themselves, before any version is known. */
export function assertEngineRanges(engines: ExtensionEngines): void {
  for (const [engine, range] of Object.entries(engines)) {
    if (range === undefined) continue;
    satisfiesRange("0.0.0", range);
    void engine;
  }
}

/**
 * The first engine the running Tau does not satisfy, as a sentence for the
 * user, or undefined when every constraint holds.
 */
export function describeIncompatibility(engines: ExtensionEngines | undefined, versions: ExtensionHostVersions): string | undefined {
  if (!engines) return undefined;
  for (const engine of ["api", "tau", "pi"] as const) {
    const range = engines[engine];
    if (range === undefined) continue;
    if (!satisfiesRange(versions[engine], range)) {
      return `needs ${ENGINE_LABELS[engine]} ${range}, this Tau has ${versions[engine]}`;
    }
  }
  return undefined;
}
