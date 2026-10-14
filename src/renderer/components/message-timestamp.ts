/**
 * The hour cycle `data-timestamps` on <html> asks for: `12h`, `24h` or `locale`.
 * Unset, timestamps keep the 24-hour clock they always had.
 */
function hour12(): boolean | undefined {
  const format = typeof document === "undefined" ? undefined : document.documentElement.dataset.timestamps;
  return format === "12h" ? true : format === "locale" ? undefined : false;
}

// Date.toLocaleString constructs an ICU formatter for every mounted message.
// Keep the compact/full pair for the current timezone and hour-cycle preference.
let formats: Partial<Record<"compact" | "full", Intl.DateTimeFormat>> = {};
let timezoneSignature: string | undefined;
function formatTimestamp(timestamp: number, style: "compact" | "full"): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return date.toLocaleString();
  // Date picks up OS timezone changes without constructing another ICU
  // formatter. Ignore the clock portion, keeping the offset and zone name.
  const cycle = hour12();
  const timezone = `${new Date().toTimeString().slice(9)}:${cycle}`;
  if (timezone !== timezoneSignature) {
    timezoneSignature = timezone;
    formats = {};
  }
  const format = formats[style] ??= new Intl.DateTimeFormat([], {
    ...(style === "full" ? { dateStyle: "full", timeStyle: "long" } : { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
    hour12: cycle,
  });
  return format.format(date);
}

export function compactTimestamp(timestamp: number): string { return formatTimestamp(timestamp, "compact"); }
export function fullTimestamp(timestamp: number): string { return formatTimestamp(timestamp, "full"); }
