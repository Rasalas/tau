/**
 * Which client is drawing. Not a screen size and not a feature flag: a claim
 * about what this client can render at all. `desktop` is the Electron window,
 * `web` a browser at the same host, `compact` a browser small enough that the
 * thread list is a sheet and diffs do not split.
 */
export type ClientProfile = "desktop" | "web" | "compact";

export const CLIENT_PROFILES: readonly ClientProfile[] = ["desktop", "web", "compact"];

/**
 * A contribution that says nothing is a desktop contribution. Kits written
 * before profiles existed keep working, and keep being honest: nothing claims
 * a client it was never tried on.
 */
export const DEFAULT_CLIENT_PROFILES: readonly ClientProfile[] = ["desktop"];

/** Something a client may or may not be able to draw. */
export interface ProfileScoped {
  /** Clients that render this contribution. Defaults to `["desktop"]`. */
  profiles?: readonly ClientProfile[];
}

export function rendersOnProfile(profiles: readonly ClientProfile[] | undefined, profile: ClientProfile): boolean {
  return (profiles ?? DEFAULT_CLIENT_PROFILES).includes(profile);
}

/** One contribution and the clients it claims, for the list of what this client leaves out. */
export interface ProfiledContribution {
  extensionId: string;
  extensionName: string;
  /** `panel`, `region`, `tool renderer` — what the workbench would have drawn. */
  kind: string;
  id: string;
  label?: string;
  profiles: readonly ClientProfile[];
  /** Whether the kit named the set itself, or inherited the desktop default. */
  declared: boolean;
}

/**
 * Below this many pixels the thread list is a sheet, the composer is pinned to
 * the bottom and no diff splits. Matched by `profile-compact.css`; change both
 * or neither.
 */
export const COMPACT_WIDTH_PX = 720;

export function parseClientProfile(value: string | null | undefined): ClientProfile | undefined {
  return CLIENT_PROFILES.find((candidate) => candidate === value);
}

/**
 * Which client a browser at this width claims to be. It is decided once, when
 * the page loads: a contribution's profile is a claim about a client, not about
 * a moment, so dragging a window narrow must not unregister a panel.
 */
export function browserClientProfile(width: number, override?: string | null): ClientProfile {
  return parseClientProfile(override) ?? (width < COMPACT_WIDTH_PX ? "compact" : "web");
}

/**
 * How wide the client is *now*. Only the layout follows this — every client
 * narrower than `COMPACT_WIDTH_PX` lays out compactly, the Electron window
 * included.
 */
export function layoutProfileFor(profile: ClientProfile, width: number): ClientProfile {
  return profile === "compact" || width < COMPACT_WIDTH_PX ? "compact" : profile;
}
