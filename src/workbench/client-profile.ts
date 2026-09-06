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
