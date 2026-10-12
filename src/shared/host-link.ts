/**
 * The state of one socket to a host, below `HostConnectionState`: whether
 * frames flow, how fast, and when the next attempt starts.
 */
export type HostLinkPhase =
  /** The socket is open. */
  | "open"
  /** A socket is being opened. */
  | "connecting"
  /** The last one failed; `retryAt` says when the next starts. */
  | "waiting"
  /** As `waiting`, while the device reports no network. */
  | "offline"
  /** For good: closed by the client, or refused by the host. */
  | "closed";

export interface HostLink {
  phase: HostLinkPhase;
  /** The last heartbeat's round trip, while the host answers them. */
  roundTripMs?: number;
  /** Failed attempts since the socket was last open. */
  attempts: number;
  /** When the next attempt starts, in `Date.now()` time, while `waiting` or `offline`. */
  retryAt?: number;
}

/**
 * Sleep pauses connection work; resume checks it with fresh deadlines.
 * Other moments a socket may have died without a close event: the app came back
 * to the foreground, the device changed networks or lost its network. The
 * client's entry point supplies them (`src/renderer/browser-wakes.ts` for a page).
 */
export type HostWake = "suspend" | "resume" | "foreground" | "online" | "offline" | "network-change";

/** Subscribes to lifecycle changes, reporting a known initial sleep/offline state; answers the unsubscribe. */
export type HostWakeSource = (listener: (wake: HostWake) => void) => () => void;
