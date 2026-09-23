/** Linear-interpolated percentile, the same rule the renderer benchmark uses. */
export function percentile(values, p) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

export const median = (values) => percentile(values, 50);

export function round(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Frame intervals (ms) from rAF timestamps; the first one has no predecessor. */
export function frameStats(timestamps) {
  const intervals = [];
  for (let index = 1; index < timestamps.length; index += 1) intervals.push(timestamps[index] - timestamps[index - 1]);
  return {
    frames: intervals.length,
    p50: round(percentile(intervals, 50)),
    p95: round(percentile(intervals, 95)),
    p99: round(percentile(intervals, 99)),
    max: round(intervals.length ? Math.max(...intervals) : null),
    // Frames that took longer than two vsync intervals at 60 Hz.
    dropped: intervals.filter((interval) => interval > 33.4).length,
  };
}

export function longTaskStats(durations) {
  return {
    count: durations.length,
    totalMs: round(durations.reduce((sum, value) => sum + value, 0)),
    maxMs: round(durations.length ? Math.max(...durations) : 0),
  };
}

/** Median and p95 across runs for every numeric leaf of the per-run records. */
export function aggregateRuns(runs) {
  const paths = new Map();
  const walk = (value, path) => {
    if (typeof value === "number") {
      if (!paths.has(path)) paths.set(path, []);
      paths.get(path).push(value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
    }
  };
  for (const run of runs) walk(run, "");
  return Object.fromEntries([...paths].map(([path, values]) => [path, { median: round(median(values)), p95: round(percentile(values, 95)), n: values.length }]));
}
