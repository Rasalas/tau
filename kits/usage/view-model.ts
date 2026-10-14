/** Compact token counts, through billions (B) and trillions (T). */
export function formatTokens(tokens: number): string {
  let value = Math.max(0, Math.round(tokens));
  const units = ["", "k", "M", "B", "T"];
  let unit = 0;
  // Promote before rounding would produce a four-digit count such as 1000.0M.
  while (value >= 999.95 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }
  return unit === 0 ? String(value) : `${value.toFixed(1)}${units[unit]}`;
}

/** How far into the window the clock is, 0–1, or undefined when its length or reset is unknown. */
export function elapsedShare(window: { resetsAt?: number; windowMinutes?: number }, now: number): number | undefined {
  if (window.resetsAt === undefined || !window.windowMinutes) return undefined;
  const length = window.windowMinutes * 60_000;
  return Math.max(0, Math.min(1, (length - (window.resetsAt - now)) / length));
}

/** `2h 13m`, `3d 4h`, `12m`, as a window's countdown reads. */
export function formatWait(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  return `${rest}m`;
}

/** "resets in 2h 13m", or "reset" once the time has passed. */
export function resetsIn(window: { resetsAt?: number }, now: number): string | undefined {
  if (window.resetsAt === undefined) return undefined;
  return window.resetsAt <= now ? "reset" : `resets in ${formatWait(window.resetsAt - now)}`;
}
