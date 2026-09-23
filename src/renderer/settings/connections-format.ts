import { PAIRING_LINK_LIFETIMES_MS, type UiClientDevice, type UiHostEndpoint } from "../../shared/connections";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function span(ms: number): string {
  // Rounded first, so 59.9 minutes reads as 1 h and not as 60 min.
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.round(ms / HOUR);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(ms / DAY);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** `just now`, `5 min ago`, `3 h ago`, `2 days ago`. */
export function formatAgo(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return ms < MINUTE ? "just now" : `${span(ms)} ago`;
}

/** `Expires in 9 min`, or `Expired` once it has. */
export function formatExpiresIn(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  return ms <= 0 ? "Expired" : `Expires in ${span(ms)}`;
}

/** `Safari · iOS` or whichever halves are known; empty when neither is. */
export function describeDevice(device: UiClientDevice): string {
  return [device.browser, device.os].filter(Boolean).join(" · ");
}

/** The endpoint a QR code shows first: a network address, never loopback (a phone would dial itself). */
export function qrEndpoint(endpoints: readonly UiHostEndpoint[], chosen?: string): UiHostEndpoint | undefined {
  const network = endpoints.filter((endpoint) => endpoint.reachability === "network");
  return network.find((endpoint) => endpoint.url === chosen) ?? network[0];
}

/** The lifetimes a new link offers, as the host accepts them. */
export const LINK_LIFETIMES: ReadonlyArray<{ label: string; ms: number }> = PAIRING_LINK_LIFETIMES_MS.map((ms) => ({ label: span(ms), ms }));
