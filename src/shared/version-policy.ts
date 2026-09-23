import type { RuntimeCompatibility } from "./contracts.js";
import { compareVersions } from "./runtime-version.js";

/**
 * Which versions of a program a backend works with. The first range the
 * installed version satisfies decides; none leaves the version unjudged.
 * A range is comparators joined by spaces (`>=0.150.0 <0.154.0`), groups
 * joined by `||`, with `^`, `~`, `=`, `<`, `<=`, `>` and `>=`.
 */
export interface VersionPolicy {
  ranges: ReadonlyArray<{ range: string; status: RuntimeCompatibility["status"]; message?: string }>;
  recommendedVersion?: string;
}

const COMPARATOR = /^(\^|~|>=|<=|>|<|=)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u;
const STATUSES = new Set(["supported", "unsafe", "broken"]);

function satisfiesComparator(version: string, token: string): boolean {
  const match = COMPARATOR.exec(token);
  if (!match) return false;
  const [, operator = "=", majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText ?? 0);
  const patch = Number(patchText ?? 0);
  const bound = `${major}.${minor}.${patch}`;
  const order = compareVersions(version, bound);
  switch (operator) {
    case ">=": return order >= 0;
    case ">": return order > 0;
    case "<=": return order <= 0;
    case "<": return order < 0;
    case "~": return order >= 0 && compareVersions(version, `${major}.${minor + 1}.0`) < 0;
    case "^": {
      const ceiling = major > 0 || minorText === undefined ? `${major + 1}.0.0` : minor > 0 || patchText === undefined ? `0.${minor + 1}.0` : `0.0.${patch + 1}`;
      return order >= 0 && compareVersions(version, ceiling) < 0;
    }
    default:
      // `=1.2` means any 1.2.x; a full version means itself.
      if (patchText !== undefined) return order === 0;
      return order >= 0 && compareVersions(version, minorText !== undefined ? `${major}.${minor + 1}.0` : `${major + 1}.0.0`) < 0;
  }
}

/** Whether a plain `x.y.z` version lies in `range`; a prerelease or a tag never does. */
export function satisfiesVersionRange(version: string, range: string): boolean {
  const stable = version.trim().replace(/^v/u, "");
  if (!/^\d+\.\d+\.\d+$/u.test(stable)) return false;
  return range.split("||").some((group) => {
    const tokens = group.trim().split(/\s+/u).filter(Boolean);
    return tokens.length > 0 && tokens.every((token) => satisfiesComparator(stable, token));
  });
}

/** The policy's verdict on `installed`; undefined when no range speaks for it. */
export function versionCompatibility(policy: VersionPolicy | undefined, installed: string | undefined): RuntimeCompatibility | undefined {
  if (!policy || !installed) return undefined;
  const entry = policy.ranges.find((candidate) => satisfiesVersionRange(installed, candidate.range));
  if (!entry) return undefined;
  const recommended = policy.recommendedVersion && policy.recommendedVersion !== installed.replace(/^v/u, "") ? policy.recommendedVersion : undefined;
  return { status: entry.status, ...(entry.message ? { message: entry.message } : {}), ...(recommended ? { recommendedVersion: recommended } : {}) };
}

/** A policy read from JSON; undefined for anything malformed. */
export function parseVersionPolicy(value: unknown): VersionPolicy | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { ranges, recommendedVersion } = value as { ranges?: unknown; recommendedVersion?: unknown };
  if (!Array.isArray(ranges)) return undefined;
  const parsed: Array<VersionPolicy["ranges"][number]> = [];
  for (const entry of ranges) {
    const { range, status, message } = (entry ?? {}) as { range?: unknown; status?: unknown; message?: unknown };
    if (typeof range !== "string" || typeof status !== "string" || !STATUSES.has(status)) return undefined;
    parsed.push({ range, status: status as RuntimeCompatibility["status"], ...(typeof message === "string" ? { message } : {}) });
  }
  return { ranges: parsed, ...(typeof recommendedVersion === "string" && /^\d+\.\d+\.\d+$/u.test(recommendedVersion) ? { recommendedVersion } : {}) };
}
