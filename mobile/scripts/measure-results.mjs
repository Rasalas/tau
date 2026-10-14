export function parseStartOutput(output) {
  const match = /^\s*TotalTime:\s*(\d+)\s*$/mu.exec(output);
  if (!/^\s*Status:\s*ok\s*$/mu.test(output) || /(?:Error:|Warning: Activity not started)/u.test(output) || !match) {
    throw new Error("am start did not report a fresh successful launch with TotalTime");
  }
  return Number(match[1]);
}

/** The system WebView renders the app; a Play image can replace it after boot. */
export function parseWebView(output) {
  const match = /Current WebView package \(name, version\):\s*\(([^,)]+),\s*([^)\s]+)\)/u.exec(output);
  return match ? `${match[1]} ${match[2]}` : undefined;
}

export function statistics(values) {
  if (!values.length || values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error("Missing or invalid timing sample");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return { count: sorted.length, median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, min: sorted[0], max: sorted.at(-1) };
}

export function summarize(samples) {
  const measured = samples.filter((sample) => !sample.warmup);
  if (!measured.length) throw new Error("No measured rounds");
  return Object.fromEntries([...new Set(measured.map((sample) => sample.size))].map((size) => {
    const rows = measured.filter((sample) => sample.size === size);
    return [size, {
      nativeStart: statistics(rows.map((row) => row.launch.totalMs)),
      listPaint: statistics(rows.map((row) => row.launch.listPaintMs)),
      observedStart: statistics(rows.map((row) => row.launch.observedMs)),
      coldOpen: statistics(rows.map((row) => row.coldMs)),
      warmOpen: statistics(rows.map((row) => row.warmMs)),
    }];
  }));
}

export function selectTargets(targets, titles) {
  const sizes = new Set();
  const names = new Set();
  for (const target of targets) {
    if (!["short", "long"].includes(target.size) || sizes.has(target.size) || names.has(target.title) || !target.title?.trim() || !target.text?.trim()) throw new Error("Targets need unique short/long sizes and titles, and newest reply text");
    sizes.add(target.size);
    names.add(target.title);
  }
  const selected = targets.filter((target) => titles.includes(target.title));
  const skipped = targets.filter((target) => !selected.includes(target)).map(({ size }) => ({ size, reason: "Thread absent from list" }));
  if (!selected.length) throw new Error("No target threads in the list; seed fixtures or supply --targets");
  return { selected, skipped };
}

export function parseOptions(args) {
  const result = { runs: 5, warmup: 1, serial: "emulator-5554", avd: "tau_play_review", bridgePort: 9477, timeoutMs: 30_000 };
  const names = { "--runs": "runs", "--warmup": "warmup", "--serial": "serial", "--avd": "avd", "--bridge-port": "bridgePort", "--timeout-ms": "timeoutMs", "--targets": "targets", "--test-host": "testHost" };
  for (let index = 0; index < args.length; index += 1) {
    const name = names[args[index]];
    if (!name || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Unknown option or missing value: ${args[index]}`);
    const value = args[(index += 1)];
    result[name] = ["runs", "warmup", "bridgePort", "timeoutMs"].includes(name) ? Number(value) : value;
  }
  for (const name of ["runs", "warmup", "bridgePort", "timeoutMs"]) {
    if (!Number.isSafeInteger(result[name]) || result[name] < (name === "warmup" ? 0 : 1)) throw new Error(`Invalid ${name}`);
  }
  if (result.bridgePort > 65535 || !/^emulator-\d+$/u.test(result.serial)) throw new Error("Use an emulator serial and a valid bridge port");
  return result;
}

export function markdown(report) {
  const lines = [
    `# Android emulator timings, ${report.date}`,
    "",
    `Source commit: \`${report.commit}\`${report.dirty ? " with local changes" : ""}. App ${report.app.version}, build ${report.app.build}.`,
    `APK SHA-256: \`${report.app.apkSha256}\`.`,
    `AVD: ${report.device.avd}. API ${report.device.api}. Image: \`${report.device.image}\`.${report.device.webview ? ` WebView: ${report.device.webview}.` : ""}`,
    `Rounds per target: ${report.runs} + ${report.warmup} warm-up. Warm-up excluded from statistics. Each target gets its own cold start.`,
    "",
    "| Thread | Metric, ms | Median | Min–max | Samples |",
    "| --- | --- | ---: | ---: | ---: |",
  ];
  const labels = { nativeStart: "Native TotalTime", listPaint: "WebView origin → usable list paint", observedStart: "Launch command → list observed", coldOpen: "Cold tap → newest reply paint", warmOpen: "Warm tap → newest reply paint" };
  for (const [size, metrics] of Object.entries(report.summary)) {
    for (const [name, stats] of Object.entries(metrics)) lines.push(`| ${size} | ${labels[name]} | ${stats.median.toFixed(1)} | ${stats.min.toFixed(1)}–${stats.max.toFixed(1)} | ${stats.count} |`);
  }
  lines.push("", `Load before: ${report.load.before}`, `Load after: ${report.load.after}`, "");
  for (const skipped of report.skipped) lines.push(`Skipped ${skipped.size}: ${skipped.reason}.`);
  lines.push("", "Cold means force-stop with paired storage and bundle caches retained. The host stays running; its caches can warm across rounds. Warm means reopening the same thread in the same app process.", "", "WebView timings use performance.timeOrigin and performance.now. Paint is estimated by requestAnimationFrame followed by a task, with visibility and hit testing. Launch-to-observed includes bridge polling and transport latency and is an upper bound. These are emulator measurements, not physical device evidence.", "", "Runbook: [mobile emulator measurement](../mobile-emulator-measurement.md). Raw samples include warm-up rounds in the corresponding reports/mobile-*.json.", "");
  return lines.join("\n");
}
