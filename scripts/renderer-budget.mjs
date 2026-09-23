function stats(values) {
  return `median ${values.median.toFixed(1)}ms, p95 ${values.p95.toFixed(1)}ms, max ${values.maximum.toFixed(1)}ms`;
}

export function evaluateRendererBudgets(report, budgets) {
  const failures = [];
  const scenarios = report.scenarios ?? [];
  const scenarioIds = new Set(scenarios.map((scenario) => scenario.id));
  for (const required of budgets.rendererRequiredScenarios ?? []) {
    if (!scenarioIds.has(required)) failures.push(`${required} was not reported by the renderer fixture`);
  }
  for (const scenario of scenarios) {
    const scenarioBudget = budgets.rendererScenarioBudgets?.[scenario.id] ?? {};
    if (scenario.longTaskObserverSupported !== true) {
      failures.push(`${scenario.id} Long Task observer is unavailable`);
    }
    const measurements = [
      ["frame p95", scenario.frameIntervalsMs?.p95, budgets.rendererFrameP95Ms, "ms", scenario.frameIntervalsMs],
      ["mount p95", scenario.mountDurationsMs?.p95, scenarioBudget.mountP95Ms ?? budgets.rendererMountP95Ms, "ms", scenario.mountDurationsMs],
      ["long task", scenario.longTasksMs?.maximum, scenarioBudget.longTaskMs ?? budgets.rendererLongTaskMs, "ms", scenario.longTasksMs],
      ["commit p95", scenario.updateDurationsMs?.p95 ?? scenario.commitDurationsMs?.p95, scenarioBudget.commitP95Ms ?? budgets.rendererCommitP95Ms, "ms", scenario.updateDurationsMs ?? scenario.commitDurationsMs],
      ["DOM nodes", scenario.domNodes, budgets.rendererDomNodes, "", undefined],
    ];
    // A scenario that ends its stream reports the end commit: the whole reparse used to land there.
    if (scenario.fixture?.streamEnd || scenario.streamEndCommitMs) {
      measurements.push(["stream end commit p95", scenario.streamEndCommitMs?.p95, budgets.rendererStreamEndCommitMs, "ms", scenario.streamEndCommitMs]);
    }
    for (const [label, actual, budget, unit, distribution] of measurements) {
      if (!Number.isFinite(actual)) {
        failures.push(`${scenario.id} ${label} was not reported by the renderer fixture`);
      } else if (budget !== undefined && actual > budget) {
        const value = unit ? actual.toFixed(1) : actual;
        const detail = distribution && [distribution.median, distribution.p95, distribution.maximum].every(Number.isFinite)
          ? ` (${stats(distribution)})`
          : "";
        failures.push(`${scenario.id} ${label} ${value}${unit} > ${budget}${unit}${detail}`);
      }
    }
  }
  return failures;
}
