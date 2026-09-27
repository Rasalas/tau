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
 * a moment, so dragging a window narrow must not unregister a panel. A touch
 * screen (a tablet at any width) is compact too: it has no hover and no mouse.
 */
export function browserClientProfile(width: number, override?: string | null, touch = false): ClientProfile {
  return parseClientProfile(override) ?? (touch || width < COMPACT_WIDTH_PX ? "compact" : "web");
}

/**
 * How far the width must come back past a threshold before the layout changes
 * back. Without it a window at the edge (or one the system resizes by a few
 * pixels) flips between two layouts on every resize.
 */
export const LAYOUT_HYSTERESIS_PX = 40;

/**
 * How wide the client is *now*. Only the layout follows this — every client
 * narrower than `COMPACT_WIDTH_PX` lays out compactly, the Electron window
 * included. `previous` is the layout it has: a compact layout widens again only
 * `LAYOUT_HYSTERESIS_PX` past the threshold.
 */
export function layoutProfileFor(profile: ClientProfile, width: number, previous?: ClientProfile): ClientProfile {
  if (profile === "compact") return "compact";
  return width < COMPACT_WIDTH_PX + (previous === "compact" ? LAYOUT_HYSTERESIS_PX : 0) ? "compact" : profile;
}

/** A compact client at least this wide, on a tablet-sized screen, shows the desktop's arrangement. */
export const COMPACT_SPLIT_MIN_WIDTH_PX = 720;
/**
 * The shorter side of a tablet's screen is at least this (an iPad mini's is
 * 744 pt), a phone's at most about 440. The screen, not the window: a phone
 * on its side stays a phone, and a keyboard or a resize never changes it.
 */
export const TABLET_SCREEN_MIN_SIDE_PX = 600;

/**
 * How a compact layout arranges itself: `single` is one screen at a time (a
 * phone, or any window narrowed below 720 px), `split` is the desktop's
 * arrangement for touch: the thread list in a sidebar, the chat, and tools and
 * documents beside it. Only a client that claims compact splits.
 */
export type CompactForm = "single" | "split";

/**
 * Width and device decide, never height or content: an on-screen keyboard, a
 * streaming transcript or the system's own resizes must not turn a tablet into
 * a phone. `previous` adds the hysteresis: a split stays split until the width
 * falls `LAYOUT_HYSTERESIS_PX` below the threshold.
 */
export function compactFormFor(profile: ClientProfile, width: number, screenMinSide: number, previous?: CompactForm): CompactForm {
  if (profile !== "compact" || screenMinSide < TABLET_SCREEN_MIN_SIDE_PX) return "single";
  return width >= COMPACT_SPLIT_MIN_WIDTH_PX - (previous === "split" ? LAYOUT_HYSTERESIS_PX : 0) ? "split" : "single";
}

/** The split's thread list: a third of the width, within bounds. */
export function compactSidebarWidth(width: number): number {
  return Math.min(380, Math.max(280, Math.round(width * 0.32)));
}
