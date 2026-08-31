export function compactTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function fullTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], { dateStyle: "full", timeStyle: "long" });
}
