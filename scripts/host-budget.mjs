export function evaluateHostBudgets(report, warmSwitchP95Ms = 150) {
  const failures = (report.phases ?? []).flatMap((measurement) => (measurement.phases ?? [])
    .filter((phase) => phase.durationMs > measurement.totalMs + 5)
    .map((phase) => `${measurement.scenario} phase ${phase.name} ${phase.durationMs.toFixed(1)}ms exceeds total ${measurement.totalMs.toFixed(1)}ms`));
  const warm = report.summaries?.["warm-switch"];
  if (!warm || ![warm.median, warm.p95, warm.maximum].every(Number.isFinite)) {
    failures.push("warm-switch median, p95, and maximum were not reported by the host fixture");
  } else if (warm.p95 > warmSwitchP95Ms) {
    failures.push(`${report.mode} warm-switch p95 ${warm.p95.toFixed(1)}ms > ${warmSwitchP95Ms}ms (median ${warm.median.toFixed(1)}ms, p95 ${warm.p95.toFixed(1)}ms, max ${warm.maximum.toFixed(1)}ms)`);
  }
  return failures;
}
