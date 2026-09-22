/**
 * The hour cycle `data-timestamps` on <html> asks for: `12h`, `24h` or `locale`.
 * Unset, timestamps keep the 24-hour clock they always had.
 */
function hour12(): boolean | undefined {
  const format = typeof document === "undefined" ? undefined : document.documentElement.dataset.timestamps;
  return format === "12h" ? true : format === "locale" ? undefined : false;
}

export function compactTimestamp(timestamp: number): string {
  const cycle = hour12();
  return new Date(timestamp).toLocaleString([], {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(cycle === undefined ? {} : { hour12: cycle }),
  });
}

export function fullTimestamp(timestamp: number): string {
  const cycle = hour12();
  return new Date(timestamp).toLocaleString([], { dateStyle: "full", timeStyle: "long", ...(cycle === undefined ? {} : { hour12: cycle }) });
}
