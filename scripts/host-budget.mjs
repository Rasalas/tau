export function evaluateHostBudgets(report, budgets = {}) {
  const warmSwitchP95Ms = budgets.warmSwitchP95Ms ?? 150;
  const bootstrapP95Ms = budgets.bootstrapP95Ms ?? (report.mode === "full" ? 2_000 : 1_000);
  const failures = (report.phases ?? []).flatMap((measurement) => (measurement.phases ?? [])
    .filter((phase) => phase.durationMs > measurement.totalMs + 5)
    .map((phase) => `${measurement.scenario} phase ${phase.name} ${phase.durationMs.toFixed(1)}ms exceeds total ${measurement.totalMs.toFixed(1)}ms`));
  const criticalBranch = (report.phases ?? [])
    .filter((measurement) => measurement.scenario === "bootstrap")
    .flatMap((measurement) => measurement.phases ?? [])
    .find((phase) => phase.name === "branch");
  if (criticalBranch) failures.push(`bootstrap still waits ${criticalBranch.durationMs.toFixed(1)}ms for branch resolution`);
  const backgroundBranch = (report.background ?? []).find((measurement) => measurement.name === "branch");
  if (!backgroundBranch || !Number.isFinite(backgroundBranch.durationMs)) {
    failures.push("background branch duration was not reported by the host fixture");
  }
  const bootstrap = report.summaries?.bootstrap;
  if (!bootstrap || ![bootstrap.median, bootstrap.p95, bootstrap.maximum].every(Number.isFinite)) {
    failures.push("bootstrap median, p95, and maximum were not reported by the host fixture");
  } else if (bootstrap.p95 > bootstrapP95Ms) {
    failures.push(`${report.mode} bootstrap p95 ${bootstrap.p95.toFixed(1)}ms > ${bootstrapP95Ms}ms (median ${bootstrap.median.toFixed(1)}ms, p95 ${bootstrap.p95.toFixed(1)}ms, max ${bootstrap.maximum.toFixed(1)}ms)`);
  }
  if (report.mode === "full") {
    const cold = report.summaries?.["cold-switch"];
    if (!cold || ![cold.median, cold.p95, cold.maximum].every(Number.isFinite)) {
      failures.push("cold-switch median, p95, and maximum were not reported by the Full Mode host fixture");
    } else if (cold.p95 > 2_500) {
      failures.push(`full cold-switch p95 ${cold.p95.toFixed(1)}ms > 2500ms (median ${cold.median.toFixed(1)}ms, p95 ${cold.p95.toFixed(1)}ms, max ${cold.maximum.toFixed(1)}ms)`);
    }
    const criticalBind = (report.phases ?? [])
      .filter((measurement) => measurement.scenario === "cold-switch")
      .flatMap((measurement) => measurement.phases ?? [])
      .find((phase) => phase.name === "bind");
    if (criticalBind) failures.push(`full cold-switch still uses serial extension binding (${criticalBind.durationMs.toFixed(1)}ms)`);
  }
  const warm = report.summaries?.["warm-switch"];
  if (!warm || ![warm.median, warm.p95, warm.maximum].every(Number.isFinite)) {
    failures.push("warm-switch median, p95, and maximum were not reported by the host fixture");
  } else if (warm.p95 > warmSwitchP95Ms) {
    failures.push(`${report.mode} warm-switch p95 ${warm.p95.toFixed(1)}ms > ${warmSwitchP95Ms}ms (median ${warm.median.toFixed(1)}ms, p95 ${warm.p95.toFixed(1)}ms, max ${warm.maximum.toFixed(1)}ms)`);
  }
  return failures;
}
